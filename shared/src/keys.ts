// Every DynamoDB key in AffiliatePoppy, built in ONE place.
//
// Two family rules meet here:
//  · Deterministic keys only — never `new Date()` as a key fallback (the MailPoppy importer
//    lesson). A ledger key is the Stripe object's own id, so a webhook redelivery writes the
//    same key and the conditional put makes it a no-op.
//  · Single table. The partitions below are chosen so that every screen is ONE query: the
//    admin's affiliate list, the admin's totals, an affiliate's own ledger, the payout
//    history. Nothing in this product ever needs a Scan.

/** Program settings + non-secret Stripe state. */
export const CFG_PK = "cfg";
export const CFG_SK_PORTAL = "portal";
export const CFG_SK_STRIPE = "stripe";
/** The paid plan (D19c). One flag, honesty-enforced like every poppy tier. */
export const CFG_SK_PLAN = "plan";

/** The affiliate directory — one thin row per affiliate, so the admin list is one Query. */
export const DIR_PK = "dir";
export const dirSk = (affId: string) => `aff#${affId}`;

/** An affiliate's own partition: their profile and every ledger entry they earned. */
export const affPk = (affId: string) => `aff#${affId}`;
export const AFF_SK_PROFILE = "profile";

/**
 * A ledger entry. The Stripe id IS the key, which is what makes the whole money path
 * idempotent: `cs_…` for the sale that started a subscription, `in_…` for a renewal invoice,
 * `rf#ch_…` for the reversal a refunded charge causes.
 */
export const ledSk = (stripeId: string) => `led#${stripeId}`;
export const refundLedgerId = (chargeId: string) => `rf#${chargeId}`;
/** True for the sk of a ledger row (used when reducing a query result). */
export const isLedgerSk = (sk: string) => sk.startsWith("led#");
export const LEDGER_SK_PREFIX = "led#";

/**
 * Running totals, in their OWN partition rather than inside each affiliate's.
 *
 * Refinement of DESIGN.md §3.3 (recorded there): the admin's Ledger tab needs everyone's
 * totals at once. Under `aff#<id>` that is one query per affiliate; under a shared partition
 * it is a single Query, and an affiliate reading their own total is still one GetItem.
 * Totals are a CACHE — the ledger rows are the truth — but they are written in the same
 * DynamoDB transaction as the entry that moves them, so the two cannot drift.
 */
export const TOT_PK = "tot";
export const totSk = (affId: string, currency: string) => `aff#${affId}#${currency.toLowerCase()}`;
/** Read the affiliate id and currency back out of a totals row. */
export function parseTotSk(sk: string): { affId: string; currency: string } | null {
  const m = /^aff#(.+)#([a-z]{3})$/.exec(sk);
  return m ? { affId: m[1]!, currency: m[2]! } : null;
}
/**
 * Running totals per CONNECTED ACCOUNT (P7 / D15b): what the merchant is advancing on sales
 * that landed on a developer's account, and so what that developer owes them back. Same
 * partition, different prefix, written in the same transaction as the entry.
 */
export const acctTotSk = (account: string, currency: string) => `acct#${account}#${currency.toLowerCase()}`;
export function parseAcctTotSk(sk: string): { account: string; currency: string } | null {
  const m = /^acct#(.+)#([a-z]{3})$/.exec(sk);
  return m ? { account: m[1]!, currency: m[2]! } : null;
}

/** Redeemed-code → affiliate. Written for BOTH the human code and Stripe's promotion-code id
 *  (see stripe-events.ts: a webhook carries the id, a human types the code). */
export const codePk = (code: string) => `code#${code.toUpperCase()}`;
export const promoPk = (promotionCodeId: string) => `promo#${promotionCodeId}`;
export const MAP_SK = "map";

/**
 * Subscription → affiliate. THE row that makes D5 (commission on renewals) work: with a
 * `duration: once` coupon the renewal invoice carries no discount at all, so the code is
 * invisible on `invoice.paid` and the mapping written at first checkout is the only link
 * back to the affiliate. Skipping it silently turns recurring commission into first-only.
 */
export const subPk = (subscriptionId: string) => `sub#${subscriptionId}`;

/**
 * Payment reference → the ledger entry it created, so a refund can find what to reverse.
 * A `charge.refunded` event names a charge, a payment intent and (for subscriptions) an
 * invoice — never the checkout session we keyed the sale on.
 */
export const refPk = (referenceId: string) => `ref#${referenceId}`;

/** Payout batches in one partition, newest last — the admin's history is one Query. */
export const PAYOUTS_PK = "payouts";
export const payoutSk = (day: string, batchId: string) => `${day}#${batchId}`;

/** The portal's soft signup rate-limit buckets. TTL'd — they are never read after the hour. */
export const RATE_PK = "rate";
export const rateSk = (bucket: string) => bucket;
