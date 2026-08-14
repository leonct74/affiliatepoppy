// Commission arithmetic. Pure, integer-only, and the single place any money is calculated.
//
// D4 (founder): the commission base is what the customer ACTUALLY PAID, after their discount
// and EXCLUDING tax. Two reasons, both his: "10% of what the customer actually paid", and tax
// was never the merchant's money to share.
//
// Everything is in minor units (cents, pence, yen). Stripe reports amounts that way, so we
// never introduce a floating-point currency value anywhere in the pipeline — the only
// rounding in the system is the single Math.round in commissionCents.

/** Non-negative integer, or 0 for anything that isn't a usable number. */
function cents(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

/**
 * What the commission is a percentage OF: the paid total minus tax.
 *
 * `amountTotal` is already net of the discount — Stripe's amount_total is what was charged —
 * so the affiliate earns on the discounted price, which is the honest reading of D4 and the
 * one that keeps the merchant's margin arithmetic (+15% / −5% / −10%) working.
 */
export function commissionBase(amountTotalCents: unknown, taxCents: unknown): number {
  return Math.max(0, cents(amountTotalCents) - cents(taxCents));
}

/**
 * The commission itself. Half-up rounding to whole minor units: a merchant paying out in real
 * money cannot transfer a third of a cent, and rounding at the ledger entry (rather than at
 * the payout) keeps every displayed number and every total consistent for good.
 */
export function commissionCents(baseCents: unknown, pct: unknown): number {
  const base = cents(baseCents);
  const p = typeof pct === "number" && Number.isFinite(pct) ? Math.max(0, pct) : 0;
  return Math.round((base * p) / 100);
}

/**
 * How much of a commission a refund takes back.
 *
 * Stripe reports refunds against the CHARGE, whose total includes tax, so the reversal is
 * proportional to the fraction of the charge that was given back rather than recomputed from
 * a base we no longer have. A full refund therefore reverses the whole commission exactly
 * (refunded === total ⇒ ratio 1), and a half refund reverses half of it.
 */
export function proportionalReversal(
  originalCommissionCents: unknown,
  refundedCents: unknown,
  chargeTotalCents: unknown,
): number {
  const commission = cents(originalCommissionCents);
  const refunded = cents(refundedCents);
  const total = cents(chargeTotalCents);
  if (!commission || !refunded || !total) return 0;
  if (refunded >= total) return commission;
  return Math.round((commission * refunded) / total);
}

/** What an affiliate is owed right now: earned, less what was reversed, less what was paid. */
export function owedCents(totals: { earnedCents?: number; refundedCents?: number; paidCents?: number }): number {
  return cents(totals.earnedCents) - cents(totals.refundedCents) - cents(totals.paidCents);
}
