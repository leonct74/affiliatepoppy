// The ledger's vocabulary — the types the Lambdas, the backend and the poppy UI all speak.
//
// They live in shared/ rather than in either half because the SAME rows are written by the
// receiver (a webhook credits a sale) and read by the poppy (the merchant's Ledger tab), and
// a second, drifting definition of "what a ledger entry is" is exactly how the two halves of
// a money feature come to disagree.

import type { Placement } from "./placements";

/** One row of earnings. The Stripe id is the key, which is what makes redelivery a no-op. */
export interface LedgerEntry {
  affId: string;
  /** The sk suffix — `cs_…`, `in_…`, or `rf#ch_…`. */
  ledgerId: string;
  kind: "sale" | "renewal" | "refund";
  /** The commission, in minor units. Negative for a reversal. */
  amountCents: number;
  /** What it was a percentage OF — kept so any figure can be explained years later. */
  baseCents: number;
  currency: string;
  pct: number;
  /** The Stripe object this came from — meaningful only inside the account it landed on. */
  orderRef: string;
  day: string;
  /**
   * The Stripe CONNECTED ACCOUNT the sale landed on (`acct_…`), or "" for the merchant's own
   * account. P7: a code minted on a developer's account produces sales there; the merchant
   * pays the publisher either way (D15) and this is how they know what the developer owes back.
   */
  account?: string;
}

/** An affiliate as the money path needs them. */
export interface AffiliateRecord {
  affId: string;
  /** pending → waiting on the merchant · active → has a working code · retired → partnership
   *  ended, earnings kept · declined → the merchant turned the application down (2026-08-22).
   *  "declined" is a state rather than a delete so the applicant gets an ANSWER instead of
   *  waiting forever, and so the same person can't silently re-appear in the queue. */
  status: "pending" | "active" | "retired" | "declined";
  /** This affiliate's own commission rate, when the merchant set one (D9). */
  pctOverride?: number;
}

/** An affiliate as the admin and the portal read them. */
export interface AffiliateProfile extends AffiliateRecord {
  email: string;
  displayName: string;
  code: string;
  /** Stripe's id for the code on the merchant's OWN account. */
  promotionCodeId: string;
  /** The same code, minted on each participating connected account: acct id → promo id (P7). */
  promotionCodeIds?: Record<string, string>;
  createdDay: string;
  /** What they said at sign-up about where they'd share the code — optional, their own words
   *  (2026-08-22). Shown beside the Approve button, because it is what the decision rests on. */
  channels?: string;
  /**
   * Where they say they share their code — optional, declared by them, a favour to the
   * merchant (shared/src/placements.ts). Empty for most affiliates, and that is fine.
   */
  placements: Placement[];
}

/** An affiliate's running totals, per currency. */
export interface Totals {
  currency: string;
  earnedCents: number;
  refundedCents: number;
  paidCents: number;
}

/** A recorded payout — money the merchant says they have actually sent (D12). */
export interface Payout {
  batchId: string;
  affId: string;
  currency: string;
  amountCents: number;
  day: string;
  note: string;
}
