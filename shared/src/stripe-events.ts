// Reading a Stripe event into an instruction for the ledger. Pure: no AWS, no clock, no
// network — so every awkward shape Stripe can send is covered by a unit test instead of
// discovered in production, where the symptom is silently missing commission.
//
// Three subtleties are baked in here, each of which would otherwise be a live-only bug:
//
//  1. A WEBHOOK CARRIES IDS, NOT THE CODE. `session.discounts[].promotion_code` is
//     `promo_1234`, not "OLIVER7K3M" — the human code only appears if the caller expands the
//     object, which a webhook payload never does. So attribution looks the promotion-code ID
//     up first, and the code string second (which is what a manually-entered coupon or an
//     expanded payload gives us).
//  2. A RENEWAL CARRIES NO DISCOUNT. With `duration: once` the coupon applies to the first
//     payment only, so every later invoice looks like an ordinary full-price sale to anyone
//     reading discounts. Renewals are therefore attributed from the subscription mapping
//     written at checkout, never from the invoice's own discounts.
//  3. A REFUND NAMES A CHARGE, NOT WHAT WE KEYED ON. `charge.refunded` knows nothing about
//     the checkout session the sale was credited under, so every credit also writes reverse
//     lookups for the payment intent, the invoice and the charge — whichever the refund
//     happens to mention.

/** UTC day (YYYY-MM-DD) from epoch seconds — the ledger's only date, and deterministic. */
export function dayOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** Stripe fields are `"cs_123"` unexpanded and `{ id: "cs_123" }` expanded. Accept both. */
export function idOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** What the receiver should do about one event. */
export type Instruction =
  | { kind: "ignore"; reason: string }
  | Sale
  | Renewal
  | Refund
  | Link;

export interface Sale {
  kind: "sale";
  /** The connected account the event came from (`event.account`), or "" for the merchant's own. */
  account: string;
  /** The ledger key — the checkout session's own id, so a redelivery is a no-op. */
  ledgerId: string;
  /** Stripe's id for the promotion code that was redeemed (the reliable lookup). */
  promotionCodeId: string;
  /** The human code, when the payload happens to carry it. */
  code: string;
  amountTotalCents: number;
  taxCents: number;
  currency: string;
  /** Present for mode=subscription — the mapping that makes renewals attributable. */
  subscriptionId: string;
  /** Ids a later refund might name. */
  references: string[];
  /** false for a delayed/unpaid checkout: map the subscription, credit nothing yet. */
  paid: boolean;
  day: string;
}

export interface Renewal {
  kind: "renewal";
  /** The connected account the event came from (`event.account`), or "" for the merchant's own. */
  account: string;
  /** The invoice's own id. */
  ledgerId: string;
  subscriptionId: string;
  amountPaidCents: number;
  taxCents: number;
  currency: string;
  references: string[];
  day: string;
}

/**
 * "These ids also name a sale you already credited." The first invoice of a subscription is
 * credited at checkout, under the session's ids — but the charge that a LATER refund names
 * belongs to the invoice's payment intent, which the checkout session never carried. Since
 * API version 2025-03-31 the charge no longer points back at its invoice either, so without
 * this row a refund of a subscription's first payment could not be matched to its credit.
 */
export interface Link {
  kind: "link";
  /** The connected account the event came from (`event.account`), or "" for the merchant's own. */
  account: string;
  /** An id the credit is already filed under (the invoice's own id). */
  knownReference: string;
  /** The new ids to file it under as well. */
  references: string[];
  day: string;
}

export interface Refund {
  kind: "refund";
  /** The connected account the event came from (`event.account`), or "" for the merchant's own. */
  account: string;
  chargeId: string;
  refundedCents: number;
  chargeTotalCents: number;
  currency: string;
  /** Ids to look the original credit up by — payment intent, invoice, charge. */
  references: string[];
  day: string;
}

/** The tax on an invoice, across the shapes Stripe has used for it. */
function invoiceTax(invoice: Record<string, unknown>): number {
  if (typeof invoice.tax === "number") return invoice.tax;
  const totals = invoice.total_taxes;
  if (Array.isArray(totals)) {
    return totals.reduce((sum: number, t: unknown) => sum + num((t as { amount?: unknown })?.amount), 0);
  }
  return 0;
}

/**
 * Every payment id an invoice names, across the shapes Stripe has used: the flat `charge` /
 * `payment_intent` fields (removed in 2025-03-31.basil) and the `payments` list that replaced
 * them. A refund event names the charge and its payment intent, never the invoice (any more),
 * so these are what a later refund is matched on.
 */
function invoicePaymentRefs(invoice: Record<string, unknown>): string[] {
  const refs = [idOf(invoice.charge), idOf(invoice.payment_intent)];
  const payments = (invoice.payments as { data?: unknown } | undefined)?.data;
  if (Array.isArray(payments)) {
    for (const p of payments) {
      const payment = (p as { payment?: Record<string, unknown> })?.payment;
      if (!payment) continue;
      refs.push(idOf(payment.payment_intent), idOf(payment.charge));
    }
  }
  return [...new Set(refs.filter(Boolean))];
}

/** The subscription an invoice belongs to, across the shapes Stripe has used for it. */
function invoiceSubscription(invoice: Record<string, unknown>): string {
  const direct = idOf(invoice.subscription);
  if (direct) return direct;
  const parent = invoice.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  return idOf(parent?.subscription_details?.subscription);
}

/** The first promotion code on a discount list, in both id and human form. */
function readDiscount(discounts: unknown): { promotionCodeId: string; code: string } {
  if (!Array.isArray(discounts)) return { promotionCodeId: "", code: "" };
  for (const d of discounts) {
    const promo = (d as { promotion_code?: unknown })?.promotion_code;
    const promotionCodeId = idOf(promo);
    const code =
      promo && typeof promo === "object" && typeof (promo as { code?: unknown }).code === "string"
        ? ((promo as { code: string }).code ?? "")
        : "";
    if (promotionCodeId || code) return { promotionCodeId, code };
  }
  return { promotionCodeId: "", code: "" };
}

/**
 * Turn a verified Stripe event into an instruction.
 *
 * Anything unrecognised, untracked or irrelevant becomes `ignore` — NEVER an error. Stripe
 * retries a 500 for days, so a receiver that throws on an event type the merchant happens to
 * have enabled would hammer their own Lambda indefinitely.
 */
export function readEvent(event: unknown): Instruction {
  const e = (event ?? {}) as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "";
  const data = (e.data as { object?: unknown })?.object;
  if (!data || typeof data !== "object") return { kind: "ignore", reason: "event has no object" };
  const obj = data as Record<string, unknown>;
  const day = dayOf(num(e.created) || Math.floor(Date.now() / 1000));
  // Present only on events delivered by a "connected accounts" webhook endpoint (P7).
  const account = typeof e.account === "string" ? e.account : "";

  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    const { promotionCodeId, code } = readDiscount(obj.discounts);
    if (!promotionCodeId && !code) return { kind: "ignore", reason: "no promotion code on this checkout" };
    const ledgerId = idOf(obj.id);
    if (!ledgerId) return { kind: "ignore", reason: "checkout session has no id" };
    const references = [idOf(obj.payment_intent), idOf(obj.invoice), ledgerId].filter(Boolean);
    return {
      kind: "sale",
      account,
      ledgerId,
      promotionCodeId,
      code: code.toUpperCase(),
      amountTotalCents: num(obj.amount_total),
      taxCents: num((obj.total_details as { amount_tax?: unknown })?.amount_tax),
      currency: String(obj.currency ?? "").toLowerCase(),
      subscriptionId: idOf(obj.subscription),
      references,
      // A checkout can complete before the money arrives (bank debits, vouchers). Map the
      // subscription now so renewals are attributable; credit only what was actually paid.
      paid: obj.payment_status === "paid" || obj.payment_status === "no_payment_required",
      day,
    };
  }

  if (type === "invoice.paid" || type === "invoice.payment_succeeded") {
    const subscriptionId = invoiceSubscription(obj);
    if (!subscriptionId) return { kind: "ignore", reason: "invoice is not for a subscription" };
    const ledgerId = idOf(obj.id);
    if (!ledgerId) return { kind: "ignore", reason: "invoice has no id" };
    // The first invoice of a subscription is the checkout we already credited — crediting it
    // again would pay twice for one sale. (Its ledger key differs, so nothing else catches it.)
    // But it carries the payment ids a future refund will name, and the checkout did not — so
    // file the existing credit under them too.
    if (obj.billing_reason === "subscription_create") {
      const references = invoicePaymentRefs(obj);
      if (references.length === 0) return { kind: "ignore", reason: "first invoice — already credited at checkout" };
      return { kind: "link", account, knownReference: ledgerId, references, day };
    }
    const amountPaidCents = num(obj.amount_paid);
    if (amountPaidCents <= 0) return { kind: "ignore", reason: "nothing was paid on this invoice" };
    return {
      kind: "renewal",
      account,
      ledgerId,
      subscriptionId,
      amountPaidCents,
      taxCents: invoiceTax(obj),
      currency: String(obj.currency ?? "").toLowerCase(),
      references: [...invoicePaymentRefs(obj), ledgerId],
      day,
    };
  }

  if (type === "charge.refunded") {
    const chargeId = idOf(obj.id);
    const refundedCents = num(obj.amount_refunded);
    if (!chargeId || refundedCents <= 0) return { kind: "ignore", reason: "no refunded amount" };
    return {
      kind: "refund",
      account,
      chargeId,
      refundedCents,
      chargeTotalCents: num(obj.amount),
      currency: String(obj.currency ?? "").toLowerCase(),
      // Order matters: the invoice/payment-intent reference is what the original credit was
      // recorded against; the charge itself is the last resort.
      references: [idOf(obj.payment_intent), idOf(obj.invoice), chargeId].filter(Boolean),
      day,
    };
  }

  return { kind: "ignore", reason: `unhandled event type ${type || "(none)"}` };
}
