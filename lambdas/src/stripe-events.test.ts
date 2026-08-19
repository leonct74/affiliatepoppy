// Reading Stripe's payloads — the shapes, not the arithmetic (that is attribute.test.ts).
//
// Stripe has sent several shapes for the same fact over the years, and a webhook payload is
// never "expanded", so the field a merchant sees in the dashboard is often not the field we
// receive. Each test below pins one of those differences, because the failure mode is always
// the same and always silent: commission that simply never appears.

import { describe, expect, it } from "vitest";
import { dayOf, idOf, readEvent } from "../../shared/src/stripe-events";

const event = (type: string, object: Record<string, unknown>, created = 1_754_006_400) => ({
  type,
  created,
  data: { object },
});

describe("ids and dates", () => {
  it("reads an id whether the field is a bare string or an expanded object", () => {
    expect(idOf("cs_123")).toBe("cs_123");
    expect(idOf({ id: "cs_123", object: "checkout.session" })).toBe("cs_123");
    expect(idOf(null)).toBe("");
    expect(idOf(undefined)).toBe("");
  });

  it("takes the day from the EVENT's own timestamp, so a redelivery lands on the same day", () => {
    // Using the wall clock instead would file a Tuesday redelivery of a Monday sale under
    // Tuesday, and the merchant's month-end totals would move every time Stripe retried.
    expect(dayOf(1_754_006_400)).toBe("2025-08-01");
    const parsed = readEvent(event("checkout.session.completed", {
      id: "cs_1",
      amount_total: 1000,
      currency: "eur",
      payment_status: "paid",
      discounts: [{ promotion_code: "promo_1" }],
    }));
    expect(parsed).toMatchObject({ day: "2025-08-01" });
  });
});

describe("a checkout", () => {
  const session = (over: Record<string, unknown> = {}) =>
    readEvent(
      event("checkout.session.completed", {
        id: "cs_1",
        mode: "subscription",
        payment_status: "paid",
        amount_total: 12000,
        currency: "eur",
        total_details: { amount_tax: 2000 },
        subscription: "sub_1",
        payment_intent: "pi_1",
        discounts: [{ coupon: "co_1", promotion_code: "promo_1" }],
        ...over,
      }),
    );

  it("carries the promotion code's ID, not the human code — a webhook is never expanded", () => {
    // This is why attribution looks up `promo_…` first: the string the affiliate hands out
    // does not appear anywhere in this payload.
    expect(session()).toMatchObject({ kind: "sale", promotionCodeId: "promo_1", code: "" });
  });

  it("reads the human code too, when the payload happens to carry it expanded", () => {
    expect(session({ discounts: [{ promotion_code: { id: "promo_1", code: "oliver7k3m" } }] })).toMatchObject({
      code: "OLIVER7K3M", // upper-cased: codes are case-insensitive everywhere in the product
    });
  });

  it("is ignored when no code was redeemed — most of a merchant's sales are organic", () => {
    expect(session({ discounts: [] })).toMatchObject({ kind: "ignore" });
    expect(session({ discounts: undefined })).toMatchObject({ kind: "ignore" });
  });

  it("collects the ids a later refund might name, and no others", () => {
    const parsed = session({ invoice: "in_1" });
    expect(parsed).toMatchObject({ references: ["pi_1", "in_1", "cs_1"] });
  });

  it("reports whether the money actually arrived", () => {
    expect(session()).toMatchObject({ paid: true });
    expect(session({ payment_status: "no_payment_required" })).toMatchObject({ paid: true });
    expect(session({ payment_status: "unpaid" })).toMatchObject({ paid: false });
  });

  it("treats a delayed payment's later success the same as an ordinary checkout", () => {
    // Bank debits and vouchers complete the checkout first and pay days later, through
    // `async_payment_succeeded`. Ignoring it would drop every sale made by those methods.
    const parsed = readEvent(
      event("checkout.session.async_payment_succeeded", {
        id: "cs_1",
        payment_status: "paid",
        amount_total: 5000,
        currency: "eur",
        discounts: [{ promotion_code: "promo_1" }],
      }),
    );
    expect(parsed).toMatchObject({ kind: "sale", ledgerId: "cs_1" });
  });
});

describe("a connected account's event (P7)", () => {
  it("carries the account id through, and reads as the merchant's own when there is none", () => {
    const sale = event("checkout.session.completed", {
      id: "cs_1", amount_total: 9500, currency: "eur", payment_status: "paid",
      discounts: [{ promotion_code: "promo_1" }],
    });
    expect(readEvent(sale)).toMatchObject({ kind: "sale", account: "" });
    expect(readEvent({ ...sale, account: "acct_dev1" })).toMatchObject({ kind: "sale", account: "acct_dev1" });
    const refund = event("charge.refunded", { id: "ch_1", amount: 9500, amount_refunded: 9500, currency: "eur" });
    expect(readEvent({ ...refund, account: "acct_dev1" })).toMatchObject({ kind: "refund", account: "acct_dev1" });
  });
});

describe("an invoice", () => {
  const invoice = (over: Record<string, unknown> = {}) =>
    readEvent(
      event("invoice.paid", {
        id: "in_2",
        billing_reason: "subscription_cycle",
        subscription: "sub_1",
        amount_paid: 12000,
        tax: 2000,
        currency: "eur",
        charge: "ch_2",
        ...over,
      }),
    );

  it("finds its subscription in BOTH shapes Stripe has used", () => {
    // The classic top-level field, and the newer nested one. Reading only one of them makes
    // renewals stop being attributed the day an account's API version moves.
    expect(invoice()).toMatchObject({ kind: "renewal", subscriptionId: "sub_1" });
    expect(
      invoice({ subscription: undefined, parent: { subscription_details: { subscription: "sub_1" } } }),
    ).toMatchObject({ subscriptionId: "sub_1" });
  });

  it("sums the newer per-rate tax breakdown when there is no single `tax` field", () => {
    expect(invoice({ tax: undefined, total_taxes: [{ amount: 1500 }, { amount: 500 }] })).toMatchObject({
      taxCents: 2000,
    });
  });

  it("names the charge AND the payment intent across both invoice shapes, so a refund can find it", () => {
    // 2025-03-31.basil removed `invoice.charge` / `invoice.payment_intent` for a `payments`
    // list — and the refund event names the charge's payment intent, never the invoice. Read
    // only the old fields and every refund on a renewal goes unmatched under the new version.
    expect(invoice({ payment_intent: "pi_2" })).toMatchObject({ references: ["ch_2", "pi_2", "in_2"] });
    expect(
      invoice({
        charge: undefined,
        payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_new" } }] },
      }),
    ).toMatchObject({ references: ["pi_new", "in_2"] });
  });

  it("turns the first invoice of a subscription into a LINK — credited at checkout, but these are the refundable ids", () => {
    // The checkout session carried the invoice id but not this payment intent; a refund of the
    // first payment will name the payment intent. So the credit gets filed under it too.
    expect(invoice({ billing_reason: "subscription_create", payment_intent: "pi_first" })).toMatchObject({
      kind: "link",
      knownReference: "in_2",
      references: ["ch_2", "pi_first"],
    });
    // …and with nothing to link, the old behaviour: ignore, never double-credit.
    expect(invoice({ billing_reason: "subscription_create", charge: undefined })).toMatchObject({ kind: "ignore" });
  });

  it("skips an invoice that isn't for a subscription, and one that was never paid", () => {
    expect(invoice({ subscription: undefined })).toMatchObject({ kind: "ignore" });
    expect(invoice({ amount_paid: 0 })).toMatchObject({ kind: "ignore" });
  });

  it("handles the payment_succeeded sibling identically", () => {
    const parsed = readEvent(
      event("invoice.payment_succeeded", {
        id: "in_3",
        billing_reason: "subscription_cycle",
        subscription: "sub_1",
        amount_paid: 1000,
        currency: "eur",
      }),
    );
    expect(parsed).toMatchObject({ kind: "renewal", ledgerId: "in_3" });
  });
});

describe("a refund", () => {
  it("names a charge — never the checkout session the sale was keyed on", () => {
    // Hence the reference list, in the order most likely to find the original credit.
    const parsed = readEvent(
      event("charge.refunded", {
        id: "ch_1",
        amount: 12000,
        amount_refunded: 6000,
        currency: "eur",
        payment_intent: "pi_1",
        invoice: "in_1",
      }),
    );
    expect(parsed).toMatchObject({
      kind: "refund",
      chargeId: "ch_1",
      refundedCents: 6000,
      chargeTotalCents: 12000,
      references: ["pi_1", "in_1", "ch_1"],
    });
  });

  it("is ignored when nothing was actually refunded", () => {
    expect(readEvent(event("charge.refunded", { id: "ch_1", amount: 100, amount_refunded: 0 }))).toMatchObject({
      kind: "ignore",
    });
  });
});

describe("anything else", () => {
  it("is ignored with a reason, and never throws", () => {
    // Stripe retries a 500 for days. A receiver that threw on an event type the merchant
    // happens to have enabled would hammer their own Lambda indefinitely.
    for (const value of [undefined, null, {}, { type: "customer.created" }, { data: {} }, "nonsense"]) {
      expect(readEvent(value)).toMatchObject({ kind: "ignore" });
    }
    expect(readEvent(event("payment_intent.succeeded", { id: "pi_1" }))).toMatchObject({
      kind: "ignore",
      reason: "unhandled event type payment_intent.succeeded",
    });
  });
});
