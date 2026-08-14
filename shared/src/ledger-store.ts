// The ledger's DynamoDB access — the ONE place any part of this poppy reads or writes the
// merchant's table. The receiver credits through it, the portal reads an affiliate's own rows
// through it, and the poppy's admin screens use the same class, so there is a single
// definition of every key and every write.
//
// Two things here are load-bearing and easy to get wrong:
//
// 1. ATOMICITY. A ledger entry and the running total it moves are written in ONE
//    TransactWriteItems call. If they were two calls, a Lambda that died between them would
//    leave a total that silently disagrees with its own entries — the kind of drift nobody
//    notices until an affiliate queries their payout. The conditional put inside the same
//    transaction is also what makes a webhook redelivery a no-op: the condition fails, the
//    WHOLE transaction is cancelled, and the total does not move.
//
// 2. NO BUYER DATA. Nothing written here contains a customer's name, email, IP or user agent.
//    A ledger row holds an amount, a currency, a date and an opaque Stripe id that is
//    meaningful only inside the merchant's own account (DESIGN.md §3.4).

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  AFF_SK_PROFILE,
  CFG_PK,
  CFG_SK_PORTAL,
  CFG_SK_STRIPE,
  DIR_PK,
  LEDGER_SK_PREFIX,
  MAP_SK,
  PAYOUTS_PK,
  TOT_PK,
  affPk,
  codePk,
  dirSk,
  ledSk,
  payoutSk,
  promoPk,
  refPk,
  subPk,
  totSk,
} from "./keys";
import {
  DEFAULT_BRANDING,
  sanitizeBranding,
  sanitizeSettings,
  type PortalBranding,
  type ProgramSettings,
} from "./settings";
import type { AffiliateProfile, LedgerEntry, Payout, Totals } from "./ledger";

const CONDITION_FAILED = "ConditionalCheckFailedException";
const TRANSACTION_CANCELED = "TransactionCanceledException";

const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });

export class DynamoLedger {
  constructor(
    private readonly db: DynamoDBClient,
    private readonly tableName: string,
  ) {}

  private async get(pk: string, sk: string): Promise<Record<string, AttributeValue> | undefined> {
    const out = await this.db.send(
      new GetItemCommand({ TableName: this.tableName, Key: { pk: S(pk), sk: S(sk) } }),
    );
    return out.Item;
  }

  /** Every row in one partition, following pagination — never a Scan. */
  private async query(pk: string, skPrefix?: string): Promise<Record<string, AttributeValue>[]> {
    const items: Record<string, AttributeValue>[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const out = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: skPrefix ? "pk = :p AND begins_with(sk, :s)" : "pk = :p",
          ExpressionAttributeValues: skPrefix ? { ":p": S(pk), ":s": S(skPrefix) } : { ":p": S(pk) },
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...(out.Items ?? []));
      startKey = out.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  async settings(): Promise<ProgramSettings> {
    const item = await this.get(CFG_PK, CFG_SK_PORTAL);
    // A missing config row is a program that was never configured — the defaults are safe
    // (approval required, nothing given away) rather than an error the webhook would retry.
    return sanitizeSettings(item?.settings?.S ? JSON.parse(item.settings.S) : undefined);
  }

  /** Settings and branding together — what the poppy's Settings tab loads and saves. */
  async config(): Promise<{ settings: ProgramSettings; branding: PortalBranding }> {
    const item = await this.get(CFG_PK, CFG_SK_PORTAL);
    return {
      settings: sanitizeSettings(item?.settings?.S ? JSON.parse(item.settings.S) : undefined),
      branding: item?.branding?.S ? sanitizeBranding(JSON.parse(item.branding.S)) : { ...DEFAULT_BRANDING },
    };
  }

  async saveConfig(settings: ProgramSettings, branding: PortalBranding): Promise<void> {
    await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: S(CFG_PK), sk: S(CFG_SK_PORTAL) },
        UpdateExpression: "SET settings = :s, branding = :b",
        ExpressionAttributeValues: {
          ":s": S(JSON.stringify(settings)),
          ":b": S(JSON.stringify(branding)),
        },
      }),
    );
  }

  /** The non-secret half of the Stripe connection: which coupon, and when we last heard. */
  async stripeState(): Promise<{ couponId: string; lastEventAt: number; livemode: boolean }> {
    const item = await this.get(CFG_PK, CFG_SK_STRIPE);
    return {
      couponId: item?.couponId?.S ?? "",
      lastEventAt: Number(item?.lastEventAt?.N ?? "0"),
      livemode: item?.livemode?.BOOL ?? false,
    };
  }

  async saveCoupon(couponId: string, discountPct: number): Promise<void> {
    await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: S(CFG_PK), sk: S(CFG_SK_STRIPE) },
        UpdateExpression: "SET couponId = :c, couponPct = :p",
        ExpressionAttributeValues: { ":c": S(couponId), ":p": N(discountPct) },
      }),
    );
  }

  async affiliate(affId: string): Promise<AffiliateProfile | undefined> {
    const item = await this.get(affPk(affId), AFF_SK_PROFILE);
    return item ? readAffiliate(affId, item) : undefined;
  }

  async affiliateForPromotionCode(promotionCodeId: string): Promise<string | undefined> {
    return (await this.get(promoPk(promotionCodeId), MAP_SK))?.affId?.S;
  }

  async affiliateForCode(code: string): Promise<string | undefined> {
    return (await this.get(codePk(code), MAP_SK))?.affId?.S;
  }

  async affiliateForSubscription(subscriptionId: string): Promise<string | undefined> {
    return (await this.get(subPk(subscriptionId), MAP_SK))?.affId?.S;
  }

  async mapSubscription(subscriptionId: string, affId: string): Promise<void> {
    // Deliberately unconditional: re-running it writes the same bytes, and the first writer
    // and every redelivery agree on the value.
    await this.db.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: { pk: S(subPk(subscriptionId)), sk: S(MAP_SK), affId: S(affId) },
      }),
    );
  }

  async credit(entry: LedgerEntry, references: string[]): Promise<boolean> {
    const totalsField = entry.amountCents >= 0 ? "earnedCents" : "refundedCents";
    try {
      await this.db.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: ledgerItem(entry),
                // THE idempotency guard. A redelivered webhook fails here, which cancels the
                // whole transaction — so the totals below cannot move twice for one sale.
                ConditionExpression: "attribute_not_exists(sk)",
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: S(TOT_PK), sk: S(totSk(entry.affId, entry.currency)) },
                UpdateExpression: `ADD ${totalsField} :amount`,
                ExpressionAttributeValues: { ":amount": N(Math.abs(entry.amountCents)) },
              },
            },
            // Reverse lookups, so a later refund can find this credit from whichever id the
            // charge names (DESIGN.md §4.3's third subtlety).
            ...references.slice(0, 5).map((reference) => ({
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: S(refPk(reference)),
                  sk: S(MAP_SK),
                  affId: S(entry.affId),
                  ledgerId: S(entry.ledgerId),
                  amountCents: N(entry.amountCents),
                  currency: S(entry.currency),
                },
              },
            })),
          ],
        }),
      );
      return true;
    } catch (e) {
      if (isAlreadyWritten(e)) return false; // a redelivery — correct, and not an error
      throw e;
    }
  }

  async findCredit(references: string[]): Promise<{ affId: string; amountCents: number; currency: string } | undefined> {
    for (const reference of references) {
      const item = await this.get(refPk(reference), MAP_SK);
      if (item?.affId?.S) {
        return {
          affId: item.affId.S,
          amountCents: Number(item.amountCents?.N ?? "0"),
          currency: item.currency?.S ?? "",
        };
      }
    }
    return undefined;
  }

  async reverse(entry: LedgerEntry): Promise<void> {
    // Stripe reports the CUMULATIVE refunded amount, so two partial refunds produce two events
    // whose reversals must converge on one row rather than stack. Read what is there, move the
    // total by the difference, and guard the write with the value we read — so a redelivery
    // (difference zero) is a no-op and a genuine concurrent update is retried, never lost.
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.get(affPk(entry.affId), ledSk(entry.ledgerId));
      const previous = Number(existing?.amountCents?.N ?? "0");
      const delta = Math.abs(entry.amountCents) - Math.abs(previous);
      if (existing && delta === 0) return;

      try {
        await this.db.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.tableName,
                  Item: ledgerItem(entry),
                  ConditionExpression: existing ? "amountCents = :previous" : "attribute_not_exists(sk)",
                  ...(existing ? { ExpressionAttributeValues: { ":previous": N(previous) } } : {}),
                },
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: { pk: S(TOT_PK), sk: S(totSk(entry.affId, entry.currency)) },
                  UpdateExpression: "ADD refundedCents :delta",
                  ExpressionAttributeValues: { ":delta": N(delta) },
                },
              },
            ],
          }),
        );
        return;
      } catch (e) {
        if (!isAlreadyWritten(e)) throw e;
        // Someone else moved it between our read and our write — re-read and reconcile.
      }
    }
    throw new Error("Could not record the refund; the ledger was being written at the same time.");
  }

  // ── reads the portal and the admin share ────────────────────────────────────────────
  async totalsFor(affId: string): Promise<Totals[]> {
    const rows = await this.query(TOT_PK, `aff#${affId}#`);
    return rows.map(readTotals).filter((t): t is Totals => !!t);
  }

  async ledgerFor(affId: string): Promise<LedgerEntry[]> {
    const rows = await this.query(affPk(affId), LEDGER_SK_PREFIX);
    return rows.map((r) => ({
      affId,
      ledgerId: (r.sk?.S ?? "").slice(LEDGER_SK_PREFIX.length),
      kind: (r.kind?.S ?? "sale") as LedgerEntry["kind"],
      amountCents: Number(r.amountCents?.N ?? "0"),
      baseCents: Number(r.baseCents?.N ?? "0"),
      currency: r.currency?.S ?? "",
      pct: Number(r.pct?.N ?? "0"),
      orderRef: r.orderRef?.S ?? "",
      day: r.day?.S ?? "",
    }));
  }

  /**
   * Record a payout the merchant says they have actually made (D12 — we report, we never move
   * money). The batch id comes from the caller and the put is conditional, so a double-click
   * or a retried request records ONE payout rather than telling an affiliate they were paid
   * twice.
   */
  async recordPayout(payout: Payout): Promise<boolean> {
    try {
      await this.db.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: S(PAYOUTS_PK),
                  sk: S(payoutSk(payout.day, payout.batchId)),
                  affId: S(payout.affId),
                  currency: S(payout.currency),
                  amountCents: N(payout.amountCents),
                  day: S(payout.day),
                  note: S(payout.note),
                },
                ConditionExpression: "attribute_not_exists(sk)",
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: S(TOT_PK), sk: S(totSk(payout.affId, payout.currency)) },
                UpdateExpression: "ADD paidCents :amount",
                ExpressionAttributeValues: { ":amount": N(payout.amountCents) },
              },
            },
          ],
        }),
      );
      return true;
    } catch (e) {
      if (isAlreadyWritten(e)) return false;
      throw e;
    }
  }

  async listPayouts(): Promise<Payout[]> {
    const rows = await this.query(PAYOUTS_PK);
    return rows.map((r) => ({
      batchId: (r.sk?.S ?? "").split("#").slice(1).join("#"),
      affId: r.affId?.S ?? "",
      currency: r.currency?.S ?? "",
      amountCents: Number(r.amountCents?.N ?? "0"),
      day: r.day?.S ?? "",
      note: r.note?.S ?? "",
    }));
  }

  async listAffiliates(): Promise<AffiliateProfile[]> {
    const dir = await this.query(DIR_PK);
    const ids = dir.map((r) => (r.sk?.S ?? "").slice("aff#".length)).filter(Boolean);
    const profiles = await Promise.all(ids.map((id) => this.affiliate(id)));
    return profiles.filter((p): p is AffiliateProfile => !!p);
  }

  async allTotals(): Promise<(Totals & { affId: string })[]> {
    const rows = await this.query(TOT_PK);
    return rows
      .map((r) => {
        const totals = readTotals(r);
        const sk = r.sk?.S ?? "";
        const m = /^aff#(.+)#([a-z]{3})$/.exec(sk);
        return totals && m ? { ...totals, affId: m[1]! } : undefined;
      })
      .filter((t): t is Totals & { affId: string } => !!t);
  }

  /** Register a new affiliate: the directory row and the profile, written together. */
  async createAffiliate(profile: AffiliateProfile): Promise<void> {
    await this.db.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                pk: S(affPk(profile.affId)),
                sk: S(AFF_SK_PROFILE),
                email: S(profile.email),
                displayName: S(profile.displayName),
                status: S(profile.status),
                code: S(profile.code),
                promotionCodeId: S(profile.promotionCodeId),
                createdDay: S(profile.createdDay),
                ...(typeof profile.pctOverride === "number" ? { pctOverride: N(profile.pctOverride) } : {}),
              },
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: { pk: S(DIR_PK), sk: S(dirSk(profile.affId)), createdDay: S(profile.createdDay) },
            },
          },
        ],
      }),
    );
  }

  /** Point a code (both forms) at an affiliate. Written when a code is issued. */
  async mapCode(code: string, promotionCodeId: string, affId: string): Promise<void> {
    await this.db.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: { pk: S(codePk(code)), sk: S(MAP_SK), affId: S(affId) },
              // A code may only ever mean ONE affiliate. Refusing to overwrite is what stops a
              // re-issue from quietly redirecting someone else's earnings.
              ConditionExpression: "attribute_not_exists(pk) OR affId = :aff",
              ExpressionAttributeValues: { ":aff": S(affId) },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: { pk: S(promoPk(promotionCodeId)), sk: S(MAP_SK), affId: S(affId) },
            },
          },
        ],
      }),
    );
  }

  /** Patch a profile's mutable fields (status, code, override) without touching the rest. */
  async updateAffiliate(
    affId: string,
    patch: Partial<Pick<AffiliateProfile, "status" | "code" | "promotionCodeId" | "pctOverride">>,
  ): Promise<void> {
    const sets: string[] = [];
    const removes: string[] = [];
    const values: Record<string, AttributeValue> = {};
    const names: Record<string, string> = {};
    if (patch.status) {
      sets.push("#status = :status");
      names["#status"] = "status";
      values[":status"] = S(patch.status);
    }
    if (patch.code !== undefined) {
      sets.push("code = :code");
      values[":code"] = S(patch.code);
    }
    if (patch.promotionCodeId !== undefined) {
      sets.push("promotionCodeId = :promo");
      values[":promo"] = S(patch.promotionCodeId);
    }
    if (patch.pctOverride === null || patch.pctOverride === undefined) {
      if ("pctOverride" in patch) removes.push("pctOverride");
    } else {
      sets.push("pctOverride = :pct");
      values[":pct"] = N(patch.pctOverride);
    }
    if (!sets.length && !removes.length) return;
    await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: S(affPk(affId)), sk: S(AFF_SK_PROFILE) },
        UpdateExpression: [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""]
          .filter(Boolean)
          .join(" "),
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ConditionExpression: "attribute_exists(sk)",
      }),
    );
  }
}

function ledgerItem(entry: LedgerEntry): Record<string, AttributeValue> {
  return {
    pk: S(affPk(entry.affId)),
    sk: S(ledSk(entry.ledgerId)),
    kind: S(entry.kind),
    amountCents: N(entry.amountCents),
    baseCents: N(entry.baseCents),
    currency: S(entry.currency),
    pct: N(entry.pct),
    orderRef: S(entry.orderRef),
    day: S(entry.day),
  };
}

function readAffiliate(affId: string, item: Record<string, AttributeValue>): AffiliateProfile {
  const status = item.status?.S;
  return {
    affId,
    email: item.email?.S ?? "",
    displayName: item.displayName?.S ?? "",
    status: status === "active" || status === "retired" ? status : "pending",
    code: item.code?.S ?? "",
    promotionCodeId: item.promotionCodeId?.S ?? "",
    createdDay: item.createdDay?.S ?? "",
    ...(item.pctOverride?.N ? { pctOverride: Number(item.pctOverride.N) } : {}),
  };
}

function readTotals(item: Record<string, AttributeValue>): Totals | null {
  const m = /^aff#.+#([a-z]{3})$/.exec(item.sk?.S ?? "");
  if (!m) return null;
  return {
    currency: m[1]!,
    earnedCents: Number(item.earnedCents?.N ?? "0"),
    refundedCents: Number(item.refundedCents?.N ?? "0"),
    paidCents: Number(item.paidCents?.N ?? "0"),
  };
}

/** True when a write lost to a condition — ours, or one inside a cancelled transaction. */
function isAlreadyWritten(e: unknown): boolean {
  const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (err?.name === CONDITION_FAILED) return true;
  if (err?.name !== TRANSACTION_CANCELED) return false;
  return (err.CancellationReasons ?? []).some((r) => r.Code === "ConditionalCheckFailed");
}
