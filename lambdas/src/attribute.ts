// What a verified Stripe event DOES to the ledger.
//
// This is the money path's decision layer, and it is deliberately free of AWS: the store
// arrives as an interface, so every rule below — who gets credited, how much, what happens on
// a redelivery, what a refund takes back — is unit-tested against a fake rather than hoped for
// in production. (The receiver Lambda is then a thin shell: verify, read, apply, 200.)
//
// The invariant that matters most: NOTHING here decides anything from data the caller sent.
// The event is signature-verified before it arrives, and every number is recomputed from the
// merchant's own stored settings and the affiliate's own record.

import { refundLedgerId } from "../../shared/src/keys";
import type { AffiliateRecord, LedgerEntry } from "../../shared/src/ledger";
import { commissionBase, commissionCents, proportionalReversal } from "../../shared/src/money";
import type { ProgramSettings } from "../../shared/src/settings";
import type { Instruction } from "../../shared/src/stripe-events";

export type { AffiliateRecord, Instruction, LedgerEntry };

/** Everything the decision layer needs from storage. */
export interface LedgerStore {
  settings(): Promise<ProgramSettings>;
  affiliate(affId: string): Promise<AffiliateRecord | undefined>;
  /** Stripe's promotion-code id → affiliate. The reliable lookup (a webhook carries ids). */
  affiliateForPromotionCode(promotionCodeId: string): Promise<string | undefined>;
  /** The human code → affiliate. The fallback, for payloads that carry the code itself. */
  affiliateForCode(code: string): Promise<string | undefined>;
  /** subscription → affiliate, written at first checkout (DESIGN.md §4.3). */
  affiliateForSubscription(subscriptionId: string): Promise<string | undefined>;
  mapSubscription(subscriptionId: string, affId: string): Promise<void>;
  /**
   * Write ONE ledger entry, its reverse-lookup rows and its effect on the running totals, as a
   * single atomic write. Returns false when the entry already existed — that is a webhook
   * redelivery, and it must change nothing.
   */
  credit(entry: LedgerEntry, references: string[]): Promise<boolean>;
  /** The credit a refund is about, found by whichever id the charge happens to name. */
  findCredit(references: string[]): Promise<FoundCredit | undefined>;
  /** File an existing credit under more ids (idempotent — the same rows, the same values). */
  addReferences(references: string[], credit: FoundCredit): Promise<void>;
  /**
   * Move a reversal to `amountCents` (idempotent by charge): the entry is rewritten to the new
   * total and the running totals move by the difference, so repeated `charge.refunded` events
   * for the same charge converge instead of stacking.
   */
  reverse(entry: LedgerEntry): Promise<void>;
}

/** A credit as a reverse-lookup row describes it. */
export interface FoundCredit {
  affId: string;
  ledgerId: string;
  amountCents: number;
  currency: string;
}

/** What happened, in a shape worth logging and asserting on. */
export type Outcome =
  | { applied: "ignored"; reason: string }
  | { applied: "linked"; ledgerId: string; references: string[] }
  | { applied: "mapped"; subscriptionId: string; affId: string }
  | { applied: "credited"; entry: LedgerEntry }
  | { applied: "duplicate"; ledgerId: string }
  | { applied: "reversed"; entry: LedgerEntry };

/**
 * Apply one instruction. Never throws for "this event isn't ours" — an unknown code, an
 * unmapped subscription and a refund of something we never credited are all ordinary,
 * expected traffic on a merchant's webhook, and answering anything but 200 would make Stripe
 * retry them for days.
 */
export async function applyInstruction(instruction: Instruction, store: LedgerStore): Promise<Outcome[]> {
  if (instruction.kind === "ignore") return [{ applied: "ignored", reason: instruction.reason }];

  if (instruction.kind === "sale") {
    const affId =
      (instruction.promotionCodeId ? await store.affiliateForPromotionCode(instruction.promotionCodeId) : undefined) ??
      (instruction.code ? await store.affiliateForCode(instruction.code) : undefined);
    if (!affId) return [{ applied: "ignored", reason: "code is not one of ours" }];

    const outcomes: Outcome[] = [];
    // The mapping comes FIRST and happens even when the money hasn't landed yet: a trial or a
    // delayed payment method still produces renewals, and without this row they would arrive
    // with no discount, no code and nothing to attribute them to.
    if (instruction.subscriptionId) {
      await store.mapSubscription(instruction.subscriptionId, affId);
      outcomes.push({ applied: "mapped", subscriptionId: instruction.subscriptionId, affId });
    }
    if (!instruction.paid) {
      outcomes.push({ applied: "ignored", reason: "checkout completed but not paid yet" });
      return outcomes;
    }

    const base = commissionBase(instruction.amountTotalCents, instruction.taxCents);
    const pct = await rateFor(affId, store);
    const amount = commissionCents(base, pct);
    if (amount <= 0) {
      outcomes.push({ applied: "ignored", reason: "nothing to pay on this sale" });
      return outcomes;
    }
    const entry: LedgerEntry = {
      affId,
      ledgerId: instruction.ledgerId,
      kind: "sale",
      amountCents: amount,
      baseCents: base,
      currency: instruction.currency,
      pct,
      orderRef: instruction.ledgerId,
      day: instruction.day,
    };
    const written = await store.credit(entry, instruction.references);
    outcomes.push(written ? { applied: "credited", entry } : { applied: "duplicate", ledgerId: entry.ledgerId });
    return outcomes;
  }

  if (instruction.kind === "renewal") {
    const settings = await store.settings();
    // D5 is a toggle: the founder's own program pays on renewals, another merchant's may not.
    if (settings.firstPaymentOnly) {
      return [{ applied: "ignored", reason: "this program pays on first payments only" }];
    }
    const affId = await store.affiliateForSubscription(instruction.subscriptionId);
    if (!affId) return [{ applied: "ignored", reason: "subscription was not brought in by an affiliate" }];

    const base = commissionBase(instruction.amountPaidCents, instruction.taxCents);
    const pct = await rateFor(affId, store);
    const amount = commissionCents(base, pct);
    if (amount <= 0) return [{ applied: "ignored", reason: "nothing to pay on this renewal" }];

    const entry: LedgerEntry = {
      affId,
      ledgerId: instruction.ledgerId,
      kind: "renewal",
      amountCents: amount,
      baseCents: base,
      currency: instruction.currency,
      pct,
      orderRef: instruction.ledgerId,
      day: instruction.day,
    };
    const written = await store.credit(entry, instruction.references);
    return [written ? { applied: "credited", entry } : { applied: "duplicate", ledgerId: entry.ledgerId }];
  }

  if (instruction.kind === "link") {
    const credit = await store.findCredit([instruction.knownReference]);
    if (!credit) return [{ applied: "ignored", reason: "first invoice of a sale we never credited" }];
    await store.addReferences(instruction.references, credit);
    return [{ applied: "linked", ledgerId: credit.ledgerId, references: instruction.references }];
  }

  // A refund.
  const original = await store.findCredit(instruction.references);
  if (!original) return [{ applied: "ignored", reason: "refund is for a sale we never credited" }];

  const reversal = proportionalReversal(original.amountCents, instruction.refundedCents, instruction.chargeTotalCents);
  if (reversal <= 0) return [{ applied: "ignored", reason: "nothing to take back" }];

  const entry: LedgerEntry = {
    affId: original.affId,
    ledgerId: refundLedgerId(instruction.chargeId),
    kind: "refund",
    // Negative, so the ledger reads as a running account rather than a list of two kinds of
    // positive number that the reader has to sign themselves.
    amountCents: -reversal,
    baseCents: instruction.refundedCents,
    currency: original.currency || instruction.currency,
    pct: 0,
    orderRef: instruction.chargeId,
    day: instruction.day,
  };
  await store.reverse(entry);
  return [{ applied: "reversed", entry }];
}

/** This affiliate's rate: their own override if the merchant set one, else the program's. */
async function rateFor(affId: string, store: LedgerStore): Promise<number> {
  const [settings, affiliate] = await Promise.all([store.settings(), store.affiliate(affId)]);
  const override = affiliate?.pctOverride;
  return typeof override === "number" && Number.isFinite(override) && override >= 0
    ? override
    : settings.commissionPct;
}
