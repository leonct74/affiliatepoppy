// Issuing an affiliate their code — the one operation that touches Stripe, DynamoDB and the
// affiliate's identity at once, so it lives in one place and both callers share it: the
// portal (self-service enrolment) and the poppy (a merchant approving someone by hand).
//
// The failure that matters is a COLLISION. Two affiliates called Oliver, or a code an
// aggregator already burned through, must never end up pointing at the wrong person's
// earnings — so a code is only accepted when Stripe accepts it as new AND our own map
// accepts it as unclaimed. Anything else, we try a different code rather than reuse one.

import { normalizeCode, suggestCode, type RandomChars } from "./codes";

/** The Stripe operations issuance needs — satisfied by StripeClient, faked in tests. */
export interface CodeIssuer {
  findPromotionCode(code: string): Promise<{ id: string; code: string } | undefined>;
  createPromotionCode(couponId: string, code: string, idempotencyKey?: string): Promise<{ id: string; code: string }>;
}

/** The storage side: claim the code for this affiliate, then record it on their profile. */
export interface CodeRegistry {
  mapCode(code: string, promotionCodeId: string, affId: string): Promise<void>;
  updateAffiliate(affId: string, patch: { code: string; promotionCodeId: string; status: "active" }): Promise<void>;
}

export interface IssueParams {
  affId: string;
  /** Their name or channel — the readable half of the code. */
  displayName: string;
  /** The program's single coupon; every affiliate's code points at it. */
  couponId: string;
  issuer: CodeIssuer;
  registry: CodeRegistry;
  /** A code the merchant typed by hand, instead of a generated one. */
  preferred?: string;
  random?: RandomChars;
  attempts?: number;
}

export class CodeIssueError extends Error {}

/**
 * Give an affiliate a working code, and return it.
 *
 * Idempotent in the way that matters: the Stripe create carries an idempotency key derived
 * from the affiliate and the code, so a retried enrolment replays the original promotion code
 * instead of minting a second one, and `mapCode` accepts a re-map to the SAME affiliate while
 * refusing one to a different affiliate.
 */
export async function issueCodeFor(params: IssueParams): Promise<{ code: string; promotionCodeId: string }> {
  if (!params.couponId) {
    throw new CodeIssueError("This programme's discount isn't set up in Stripe yet, so codes can't be issued.");
  }
  const attempts = params.attempts ?? 5;
  let candidate = params.preferred ? normalizeCode(params.preferred) : "";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const code = candidate || suggestCode(params.displayName, params.random);
    candidate = ""; // a rejected preferred code is not retried verbatim

    // Cheap pre-check: a code someone already holds in Stripe would fail the create anyway,
    // and asking first keeps the error out of the affiliate's face.
    const existing = await params.issuer.findPromotionCode(code);
    if (existing) continue;

    let promotionCodeId: string;
    try {
      const created = await params.issuer.createPromotionCode(params.couponId, code, `ap-${params.affId}-${code}`);
      promotionCodeId = created.id;
    } catch (e) {
      // Stripe raced us to the same code — try another. Anything else is real and must surface.
      if (/already exists|code_already_exists/i.test((e as Error).message)) continue;
      throw e;
    }

    try {
      await params.registry.mapCode(code, promotionCodeId, params.affId);
    } catch {
      // Our own map says this code belongs to someone else. The Stripe code we just made is
      // orphaned rather than dangerous (it points at no affiliate, so it credits nobody) and
      // the merchant can retire it; taking someone else's earnings would be far worse.
      continue;
    }

    await params.registry.updateAffiliate(params.affId, { code, promotionCodeId, status: "active" });
    return { code, promotionCodeId };
  }

  throw new CodeIssueError("Couldn't find a free code to issue. Try again, or set one by hand.");
}

// ── P7: the same code on every participating developer's account ─────────────────────────

/** The Stripe side of minting on a connected account: a client that can act as that account. */
export interface AccountIssuer {
  forAccount(account: string): CodeIssuer;
}

/** The storage side: remember each account's promotion-code id and point it at the affiliate. */
export interface PartnerRegistry {
  mapPromotionCode(promotionCodeId: string, affId: string): Promise<void>;
  updateAffiliate(affId: string, patch: { promotionCodeIds: Record<string, string> }): Promise<void>;
}

export interface MintOnPartnersParams {
  affId: string;
  /** The code as already issued on the merchant's own account — the SAME string goes everywhere. */
  code: string;
  /** Each participating developer, with the coupon as created on THEIR account. */
  partners: { account: string; couponId: string; label: string }[];
  /** acct → promo id already minted (a re-run mints only what is missing). */
  already: Record<string, string>;
  stripe: AccountIssuer;
  registry: PartnerRegistry;
}

export interface MintOnPartnersResult {
  /** acct → promo id, for every account that now has the code (old and new). */
  promotionCodeIds: Record<string, string>;
  /** Accounts the code could NOT be minted on, in words the merchant can act on. */
  failures: { account: string; label: string; message: string }[];
}

/**
 * Mint an already-issued code on each participating connected account.
 *
 * A Stripe promotion code lives on ONE account, so a code that should work at a developer's
 * checkout has to be created there as well — same string, that account's coupon. Idempotent
 * per account (Stripe idempotency key + "already exists" → look it up), and partial failure is
 * reported rather than thrown: the merchant's own account already has the code, and one
 * developer's misconfiguration must not stop the other nine from working.
 */
export async function mintOnPartners(params: MintOnPartnersParams): Promise<MintOnPartnersResult> {
  const promotionCodeIds = { ...params.already };
  const failures: MintOnPartnersResult["failures"] = [];

  for (const partner of params.partners) {
    if (promotionCodeIds[partner.account]) continue;
    if (!partner.couponId) {
      failures.push({ ...partner, message: "No discount coupon exists on this account yet — save Settings again to create it." });
      continue;
    }
    const issuer = params.stripe.forAccount(partner.account);
    try {
      let id: string;
      try {
        const created = await issuer.createPromotionCode(
          partner.couponId,
          params.code,
          `ap-${params.affId}-${params.code}-${partner.account}`,
        );
        id = created.id;
      } catch (e) {
        if (!/already exists|code_already_exists/i.test((e as Error).message)) throw e;
        // Minted on a previous, interrupted run — or by hand. Either way it is the right code.
        const found = await issuer.findPromotionCode(params.code);
        if (!found) throw e;
        id = found.id;
      }
      await params.registry.mapPromotionCode(id, params.affId);
      promotionCodeIds[partner.account] = id;
    } catch (e) {
      failures.push({ ...partner, message: (e as Error).message });
    }
  }

  if (Object.keys(promotionCodeIds).length !== Object.keys(params.already).length) {
    await params.registry.updateAffiliate(params.affId, { promotionCodeIds });
  }
  return { promotionCodeIds, failures };
}
