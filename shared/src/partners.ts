// Participating developers — the Stripe CONNECTED ACCOUNTS the merchant's codes also work on.
//
// P7. A Stripe promotion code lives on ONE account, so for a code to be redeemable at a
// checkout created on a developer's connected account it must be minted there too. The
// merchant lists the developers who take part (opt-in, one by one — D15's guard: a
// developer's tolerance for leaked codes is theirs to decide, never inherited), and every
// affiliate code is then minted on the merchant's own account AND on each of these.

export interface Partner {
  /** The connected account id, `acct_…`. */
  account: string;
  /** What the merchant calls them — shown in the Ledger, never sent to Stripe. */
  label: string;
  /** The programme's coupon AS CREATED ON THAT ACCOUNT (coupons live on one account too). */
  couponId: string;
  /** The discount that coupon gives — so a changed discount is noticed and re-minted. */
  couponPct: number;
}

export const MAX_PARTNERS = 100;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,}$/;

export const isAccountId = (s: string): boolean => ACCOUNT_ID.test(s.trim());

/** Partners as we will actually use them, whatever was stored. */
export function sanitizePartners(input: unknown): Partner[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Partner[] = [];
  for (const raw of input) {
    const p = (raw ?? {}) as Partial<Record<keyof Partner, unknown>>;
    const account = typeof p.account === "string" ? p.account.trim() : "";
    if (!isAccountId(account) || seen.has(account)) continue;
    seen.add(account);
    out.push({
      account,
      label: (typeof p.label === "string" ? p.label.trim() : "").slice(0, 60),
      couponId: typeof p.couponId === "string" ? p.couponId : "",
      couponPct: typeof p.couponPct === "number" && Number.isFinite(p.couponPct) ? p.couponPct : Number.NaN,
    });
    if (out.length >= MAX_PARTNERS) break;
  }
  return out;
}
