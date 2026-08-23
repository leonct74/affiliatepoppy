// The table's row mapper, both directions.
//
// Why this file exists: every affiliate field is hand-mapped to DynamoDB attributes on the way
// in and back on the way out, and a field added to the TYPE but not to both maps fails in the
// quietest way there is — the write succeeds, the read returns something else, and the feature
// looks like it simply does nothing. That happened twice in one build (founder, 2026-08-23:
// "I declined one user but nothing happened"): "declined" was written and read back as
// "pending", and the applicant's channels were never stored at all. These tests round-trip
// every state the app can write, so the next field that only gets half-wired fails here.

import { describe, expect, it } from "vitest";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { DynamoLedger } from "../../shared/src/ledger-store";
import { AFFILIATE_STATES, type AffiliateProfile } from "../../shared/src/ledger";

type Row = Record<string, AttributeValue>;
const rowKey = (k: Row) => `${k.pk?.S}|${k.sk?.S}`;

/** Enough DynamoDB to be honest about this mapper: puts, the SET/REMOVE updates this store
 *  actually emits, and gets. Nothing here interprets the store's intent — it stores attributes
 *  and hands them back, which is the whole point. */
class FakeDynamo {
  readonly rows = new Map<string, Row>();

  async send(command: { input: Record<string, any> }): Promise<any> {
    const input = command.input;
    if (input.TransactItems) {
      for (const t of input.TransactItems) if (t.Put) this.rows.set(rowKey(t.Put.Item), { ...t.Put.Item });
      return {};
    }
    if (input.UpdateExpression) {
      const row = this.rows.get(rowKey(input.Key)) ?? { ...input.Key };
      const names: Record<string, string> = input.ExpressionAttributeNames ?? {};
      const values: Record<string, AttributeValue> = input.ExpressionAttributeValues ?? {};
      const [, setPart = "", removePart = ""] = /^\s*(?:SET (.*?))?(?:\s*REMOVE (.*))?$/.exec(input.UpdateExpression)!;
      for (const assignment of setPart.split(", ").filter(Boolean)) {
        const [lhs, rhs] = assignment.split(" = ");
        row[names[lhs!] ?? lhs!] = values[rhs!]!;
      }
      for (const attr of removePart.split(", ").filter(Boolean)) delete row[names[attr] ?? attr];
      this.rows.set(rowKey(input.Key), row);
      return {};
    }
    return { Item: this.rows.get(rowKey(input.Key)) };
  }
}

function ledgerWith(profile: Partial<AffiliateProfile> = {}) {
  const db = new FakeDynamo();
  const ledger = new DynamoLedger(db as never, "t");
  const create = ledger.createAffiliate({
    affId: "pp_u1",
    email: "p@example.com",
    displayName: "Olly",
    status: "pending",
    code: "",
    promotionCodeId: "",
    createdDay: "2026-08-23",
    placements: [],
    ...profile,
  });
  return { ledger, create };
}

describe("an affiliate survives the round trip", () => {
  it("stores every state the app can write, and reads back the same one", async () => {
    const { ledger, create } = ledgerWith();
    await create;
    for (const status of AFFILIATE_STATES) {
      await ledger.updateAffiliate("pp_u1", { status });
      expect((await ledger.affiliate("pp_u1"))?.status).toBe(status);
    }
  });

  it("keeps what the applicant said at sign-up — on create and on backfill", async () => {
    const { ledger, create } = ledgerWith({ channels: "  YouTube   and a newsletter " });
    await create;
    expect((await ledger.affiliate("pp_u1"))?.channels).toBe("YouTube and a newsletter");

    await ledger.updateAffiliate("pp_u1", { channels: "Instagram" });
    expect((await ledger.affiliate("pp_u1"))?.channels).toBe("Instagram");
  });

  it("falls back to pending for a status it doesn't know — a strange row is never a live code", async () => {
    const { ledger, create } = ledgerWith();
    await create;
    await ledger.updateAffiliate("pp_u1", { status: "banana" as never });
    expect((await ledger.affiliate("pp_u1"))?.status).toBe("pending");
  });
});
