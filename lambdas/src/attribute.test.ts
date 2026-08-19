// The money path, end to end, against a fake store.
//
// Every test here is a rule the founder decided or a failure that would only ever show up in
// production: a webhook redelivery paying twice, a renewal losing its affiliate because the
// coupon was `duration: once`, a refund taking back more (or less) than it should.
//
// The fake store below is deliberately dumb — a Map and a few arrays — so that when a test
// fails it is the DECISION that is wrong, not the storage.

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ProgramSettings } from "../../shared/src/settings";
import { readEvent } from "../../shared/src/stripe-events";
import { applyInstruction, type LedgerEntry, type LedgerStore } from "./attribute";

class FakeStore implements LedgerStore {
  settingsValue: ProgramSettings = { ...DEFAULT_SETTINGS, commissionPct: 10 };
  affiliates = new Map<string, { affId: string; status: "pending" | "active" | "retired"; pctOverride?: number }>();
  promoCodes = new Map<string, string>();
  codes = new Map<string, string>();
  subscriptions = new Map<string, string>();
  entries = new Map<string, LedgerEntry>();
  references = new Map<string, { affId: string; ledgerId: string; amountCents: number; currency: string; account: string }>();
  /** Every credit attempt, including the ones a redelivery rejected. */
  creditAttempts: LedgerEntry[] = [];

  async settings() {
    return this.settingsValue;
  }
  async affiliate(affId: string) {
    return this.affiliates.get(affId);
  }
  async affiliateForPromotionCode(id: string) {
    return this.promoCodes.get(id);
  }
  async affiliateForCode(code: string) {
    return this.codes.get(code);
  }
  async affiliateForSubscription(id: string) {
    return this.subscriptions.get(id);
  }
  async mapSubscription(id: string, affId: string) {
    this.subscriptions.set(id, affId);
  }
  async credit(entry: LedgerEntry, references: string[]) {
    this.creditAttempts.push(entry);
    if (this.entries.has(entry.ledgerId)) return false; // the redelivery guard
    this.entries.set(entry.ledgerId, entry);
    for (const r of references) {
      this.references.set(r, { affId: entry.affId, ledgerId: entry.ledgerId, amountCents: entry.amountCents, currency: entry.currency, account: entry.account ?? "" });
    }
    return true;
  }
  async findCredit(references: string[]) {
    for (const r of references) {
      const found = this.references.get(r);
      if (found) return found;
    }
    return undefined;
  }
  async addReferences(references: string[], credit: { affId: string; ledgerId: string; amountCents: number; currency: string; account: string }) {
    for (const r of references) this.references.set(r, credit);
  }
  async reverse(entry: LedgerEntry) {
    this.entries.set(entry.ledgerId, entry);
  }

  /** What an affiliate has actually earned, from the entries themselves. */
  balance(affId: string): number {
    let total = 0;
    for (const e of this.entries.values()) if (e.affId === affId) total += e.amountCents;
    return total;
  }
}

let store: FakeStore;
beforeEach(() => {
  store = new FakeStore();
  store.affiliates.set("aff-oliver", { affId: "aff-oliver", status: "active" });
  store.promoCodes.set("promo_123", "aff-oliver");
  store.codes.set("OLIVER7K3M", "aff-oliver");
});

/** A subscription checkout that redeemed Oliver's code: €100 + €20 tax. */
const checkout = (over: Record<string, unknown> = {}) => ({
  type: "checkout.session.completed",
  created: 1_754_000_000, // 2025-07-31
  data: {
    object: {
      id: "cs_test_1",
      mode: "subscription",
      payment_status: "paid",
      amount_total: 12000,
      currency: "eur",
      total_details: { amount_tax: 2000 },
      subscription: "sub_abc",
      payment_intent: "pi_abc",
      discounts: [{ coupon: "co_5off", promotion_code: "promo_123" }],
      ...over,
    },
  },
});

const apply = (event: unknown) => applyInstruction(readEvent(event), store);

describe("a sale", () => {
  it("credits the affiliate the commission on what was paid, excluding tax", async () => {
    const outcomes = await apply(checkout());
    const credited = outcomes.find((o) => o.applied === "credited");
    // €120 charged, €20 of it tax ⇒ base €100 ⇒ 10% ⇒ €10.00.
    expect(credited).toMatchObject({ applied: "credited" });
    expect(store.entries.get("cs_test_1")).toMatchObject({
      affId: "aff-oliver",
      amountCents: 1000,
      baseCents: 10000,
      currency: "eur",
      kind: "sale",
      day: "2025-07-31",
    });
  });

  it("uses the affiliate's own rate when the merchant set one (D9)", async () => {
    store.affiliates.set("aff-oliver", { affId: "aff-oliver", status: "active", pctOverride: 25 });
    await apply(checkout());
    expect(store.entries.get("cs_test_1")?.amountCents).toBe(2500);
  });

  it("maps the subscription, so renewals can find their affiliate later (§4.3)", async () => {
    await apply(checkout());
    expect(store.subscriptions.get("sub_abc")).toBe("aff-oliver");
  });

  it("credits ONCE when Stripe redelivers the same event", async () => {
    await apply(checkout());
    await apply(checkout());
    // Both attempts reached the store; only the first became money.
    expect(store.creditAttempts).toHaveLength(2);
    expect(store.balance("aff-oliver")).toBe(1000);
  });

  it("ignores a code that isn't ours", async () => {
    const outcomes = await apply(checkout({ discounts: [{ promotion_code: "promo_someone_else" }] }));
    expect(outcomes).toEqual([{ applied: "ignored", reason: "code is not one of ours" }]);
    expect(store.entries.size).toBe(0);
  });

  it("falls back to the human code when the payload carries it expanded", async () => {
    await apply(checkout({ discounts: [{ promotion_code: { id: "promo_unknown", code: "OLIVER7K3M" } }] }));
    expect(store.balance("aff-oliver")).toBe(1000);
  });

  it("maps the subscription but credits nothing when the money hasn't arrived", async () => {
    // A delayed payment method (or a trial): the checkout completes, the payment doesn't.
    const outcomes = await apply(checkout({ payment_status: "unpaid" }));
    expect(store.subscriptions.get("sub_abc")).toBe("aff-oliver");
    expect(store.entries.size).toBe(0);
    expect(outcomes.some((o) => o.applied === "mapped")).toBe(true);
  });

  it("credits nothing on a fully-discounted (zero) checkout, without erroring", async () => {
    const outcomes = await apply(checkout({ amount_total: 0, total_details: { amount_tax: 0 } }));
    expect(store.entries.size).toBe(0);
    expect(outcomes.some((o) => o.applied === "ignored")).toBe(true);
  });
});

describe("a renewal", () => {
  const invoice = (over: Record<string, unknown> = {}) => ({
    type: "invoice.paid",
    created: 1_756_678_400,
    data: {
      object: {
        id: "in_second",
        billing_reason: "subscription_cycle",
        subscription: "sub_abc",
        amount_paid: 12000,
        tax: 2000,
        currency: "eur",
        charge: "ch_2",
        ...over,
      },
    },
  });

  beforeEach(async () => {
    await apply(checkout()); // the first payment, which is what maps the subscription
  });

  it("is credited from the SUBSCRIPTION MAPPING — a renewal carries no discount at all", async () => {
    // This is the subtlety that would otherwise turn "commission on all sales" into
    // first-payment-only, silently: the coupon is `duration: once`, so the renewal invoice
    // has no promotion code on it anywhere.
    await apply(invoice());
    expect(store.entries.get("in_second")).toMatchObject({ affId: "aff-oliver", amountCents: 1000, kind: "renewal" });
  });

  it("is NOT credited when the merchant chose first-payment-only (D5's toggle)", async () => {
    store.settingsValue = { ...store.settingsValue, firstPaymentOnly: true };
    const outcomes = await apply(invoice());
    expect(outcomes).toEqual([{ applied: "ignored", reason: "this program pays on first payments only" }]);
    expect(store.entries.has("in_second")).toBe(false);
  });

  it("never double-pays the FIRST invoice, which the checkout already credited", async () => {
    const outcomes = await apply(invoice({ id: "in_first", billing_reason: "subscription_create", charge: undefined }));
    expect(outcomes[0]).toMatchObject({ applied: "ignored" });
    expect(store.balance("aff-oliver")).toBe(1000); // the sale only
  });

  it("files the checkout's credit under the first invoice's payment ids — so refunding the FIRST payment still works", async () => {
    // Under current API versions the refund event names the charge's payment intent (pi_first)
    // and not the invoice; the checkout session never carried pi_first. Without the link, the
    // refund below would be "a sale we never credited" and the affiliate would keep €10 on a
    // sale that was given back.
    await apply(checkout({ id: "cs_test_2", invoice: "in_first", payment_intent: undefined })); // a second sale
    const linked = await apply(
      invoice({ id: "in_first", billing_reason: "subscription_create", charge: undefined,
        payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_first" } }] } }),
    );
    expect(linked[0]).toMatchObject({ applied: "linked", ledgerId: "cs_test_2", references: ["pi_first"] });
    expect(store.balance("aff-oliver")).toBe(2000); // two sales — the link credited nothing

    await apply({
      type: "charge.refunded",
      created: 1_756_678_400,
      data: { object: { id: "ch_first", amount: 12000, amount_refunded: 12000, currency: "eur", payment_intent: "pi_first" } },
    });
    expect(store.balance("aff-oliver")).toBe(1000); // the second sale's commission taken back
  });

  it("is ignored for a subscription no affiliate brought in", async () => {
    const outcomes = await apply(invoice({ subscription: "sub_organic", id: "in_organic" }));
    expect(outcomes).toEqual([
      { applied: "ignored", reason: "subscription was not brought in by an affiliate" },
    ]);
  });

  it("reads the subscription from the newer invoice shape too", async () => {
    await apply(
      invoice({ subscription: undefined, parent: { subscription_details: { subscription: "sub_abc" } } }),
    );
    expect(store.entries.has("in_second")).toBe(true);
  });

  it("sums the newer per-tax-rate breakdown when there is no single tax field", async () => {
    await apply(invoice({ tax: undefined, total_taxes: [{ amount: 1500 }, { amount: 500 }] }));
    expect(store.entries.get("in_second")?.baseCents).toBe(10000);
  });
});

describe("a refund", () => {
  const refund = (over: Record<string, unknown> = {}) => ({
    type: "charge.refunded",
    created: 1_756_678_400,
    data: {
      object: {
        id: "ch_1",
        amount: 12000,
        amount_refunded: 12000,
        currency: "eur",
        payment_intent: "pi_abc",
        ...over,
      },
    },
  });

  beforeEach(async () => {
    await apply(checkout());
  });

  it("takes the whole commission back on a full refund", async () => {
    await apply(refund());
    expect(store.balance("aff-oliver")).toBe(0);
  });

  it("takes back proportionally on a partial refund", async () => {
    // Half the charge given back ⇒ half the commission reversed. (The charge includes tax, so
    // the ratio is over the charge, not over the commission base.)
    await apply(refund({ amount_refunded: 6000 }));
    expect(store.balance("aff-oliver")).toBe(500);
  });

  it("converges when Stripe reports a second, larger cumulative refund", async () => {
    await apply(refund({ amount_refunded: 6000 }));
    await apply(refund({ amount_refunded: 12000 }));
    // The reversal row is REWRITTEN to the new total rather than a second one being added.
    expect(store.balance("aff-oliver")).toBe(0);
  });

  it("is ignored when it belongs to a sale we never credited", async () => {
    const outcomes = await apply(refund({ id: "ch_other", payment_intent: "pi_other" }));
    expect(outcomes).toEqual([{ applied: "ignored", reason: "refund is for a sale we never credited" }]);
    expect(store.balance("aff-oliver")).toBe(1000);
  });
});

describe("a sale on a developer's connected account (P7)", () => {
  it("credits the publisher exactly as on the merchant's own account, and records WHOSE account it was", async () => {
    // The publisher's side is unchanged: same code, same rate, same money. What is new is the
    // account on the entry — which is how the merchant knows what the developer owes back.
    const outcomes = await apply({ ...checkout({ id: "cs_dev" }), account: "acct_dev1" });
    expect(outcomes.at(-1)).toMatchObject({ applied: "credited", entry: { amountCents: 1000, account: "acct_dev1" } });
    expect(store.balance("aff-oliver")).toBe(1000);
  });

  it("books the refund against the account the SALE was on, whatever the refund event says", async () => {
    await apply({ ...checkout({ id: "cs_dev", payment_intent: "pi_dev" }), account: "acct_dev1" });
    const outcomes = await apply({
      type: "charge.refunded", created: 1_756_678_400, account: "acct_dev1",
      data: { object: { id: "ch_dev", amount: 12000, amount_refunded: 12000, currency: "eur", payment_intent: "pi_dev" } },
    });
    expect(outcomes[0]).toMatchObject({ applied: "reversed", entry: { amountCents: -1000, account: "acct_dev1" } });
  });
});

describe("events that are none of our business", () => {
  it("are ignored rather than failed — Stripe retries a failure for days", async () => {
    for (const type of ["customer.created", "payment_intent.succeeded", "invoice.upcoming"]) {
      const outcomes = await apply({ type, created: 1, data: { object: { id: "x" } } });
      expect(outcomes[0]?.applied).toBe("ignored");
    }
  });

  it("survive a malformed event without throwing", async () => {
    expect((await apply({}))[0]?.applied).toBe("ignored");
    expect((await apply(null))[0]?.applied).toBe("ignored");
  });
});
