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
