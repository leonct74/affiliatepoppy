// The small slice of the Stripe REST API this poppy calls: create the program's coupon,
// issue an affiliate their promotion code, and retire a code.
//
// WHY NO SDK: three endpoints, form-encoded, over fetch. The `stripe` package would be a
// megabyte of dependency inside a Lambda zip and a supply-chain surface on a path that holds
// the merchant's API key. Node 20 has fetch; the whole client is below.
//
// THE KEY: a RESTRICTED key with write access to promotion codes and nothing else (D11). It
// lives in the merchant's own SSM parameter store, is read only by the Lambda that needs it,
// and is never returned to any UI. If this file ever needs a broader permission, that is a
// design change to argue in DESIGN.md — not a scope to widen quietly.

const API_BASE = "https://api.stripe.com/v1";

/**
 * PINNED. Without this header Stripe answers in whatever API version the MERCHANT's account
 * defaults to — which differs from merchant to merchant and moves under us when they upgrade.
 * The first live approval failed exactly that way: the founder's account was on a version
 * where `coupon` had become `promotion[coupon]` ("Received unknown parameter: coupon"). Pin
 * the version this file is written against, and every merchant gets the same wire shape.
 *
 * 2025-09-30.clover is the release that made the change (Stripe changelog: "Promotion Codes
 * now reference Coupons using a polymorphic field for promotions"). Moving the pin is a
 * deliberate act: re-read the changelog for /coupons and /promotion_codes first.
 */
export const STRIPE_API_VERSION = "2025-09-30.clover";

export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface StripeClientOptions {
  apiKey: string;
  /** Injected so every call is testable without touching Stripe. */
  fetchImpl?: typeof fetch;
}

/** Stripe's form encoding: nested objects as `a[b]`, arrays as `a[0]`. We only need scalars. */
function encodeForm(params: Record<string, string | number | boolean | undefined>): string {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    body.set(k, String(v));
  }
  return body.toString();
}

export interface Coupon {
  id: string;
  percent_off?: number | null;
  duration?: string;
  valid?: boolean;
}

export interface PromotionCode {
  id: string;
  code: string;
  active: boolean;
  /** Since 2025-09-30.clover a code points at a "promotion", of which a coupon is one kind. */
  promotion?: { type: "coupon"; coupon: string };
}

export class StripeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: StripeClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_API_VERSION,
    };
    // A retried create must never mint a second code for the same affiliate. Stripe replays
    // the original response for 24h against the same key.
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

    const query = method === "GET" && params ? `?${encodeForm(params)}` : "";
    let res: Response;
    try {
      res = await this.fetchImpl(`${API_BASE}${path}${query}`, {
        method,
        headers,
        body: method === "POST" ? encodeForm(params ?? {}) : undefined,
      });
    } catch (e) {
      // Never let a raw transport error reach a merchant or an affiliate.
      throw new StripeApiError(`Stripe could not be reached (${(e as Error).message})`, 0, "network");
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new StripeApiError("Stripe sent a response we could not read.", res.status, "malformed");
    }
    if (!res.ok) {
      const err = (body as { error?: { message?: string; code?: string; type?: string } }).error;
      throw new StripeApiError(
        err?.message ?? `Stripe refused the request (${res.status}).`,
        res.status,
        err?.code ?? err?.type ?? "error",
      );
    }
    return body as T;
  }

  /** The program's ONE coupon; every affiliate's promotion code points at it. */
  createCoupon(percentOff: number, name: string, idempotencyKey?: string): Promise<Coupon> {
    return this.call<Coupon>(
      "POST",
      "/coupons",
      {
        percent_off: percentOff,
        // `once` — the discount applies to the first payment. Renewals bill full price, and
        // the commission on them is our ledger's job, not the coupon's (DESIGN.md §4.3).
        duration: "once",
        name,
      },
      idempotencyKey,
    );
  }

  getCoupon(couponId: string): Promise<Coupon> {
    return this.call<Coupon>("GET", `/coupons/${encodeURIComponent(couponId)}`);
  }

  /** One affiliate's code. `code` is what their audience types. */
  createPromotionCode(couponId: string, code: string, idempotencyKey?: string): Promise<PromotionCode> {
    return this.call<PromotionCode>(
      "POST",
      "/promotion_codes",
      // The polymorphic form (2025-09-30.clover+): a promotion of type coupon.
      { "promotion[type]": "coupon", "promotion[coupon]": couponId, code },
      idempotencyKey,
    );
  }

  /** Retire a code: it stops working at checkout; the ledger it already earned is untouched. */
  deactivatePromotionCode(promotionCodeId: string): Promise<PromotionCode> {
    return this.call<PromotionCode>("POST", `/promotion_codes/${encodeURIComponent(promotionCodeId)}`, {
      active: false,
    });
  }

  /** Is this code already taken? (Stripe rejects duplicates; we check before suggesting one.) */
  async findPromotionCode(code: string): Promise<PromotionCode | undefined> {
    const list = await this.call<{ data?: PromotionCode[] }>("GET", "/promotion_codes", { code, limit: 1 });
    return list.data?.[0];
  }

  /**
   * Is this a usable key, and which mode is it in? Deliberately a READ: a check must never
   * write to a merchant's Stripe account. The real proof that the key can do the ONE thing we
   * need — write promotion codes — is the coupon create that follows in connectStripe(), which
   * needs the same scope and is a write we have to make anyway. `permissionProblem()` below
   * turns Stripe's refusal of THAT into the sentence the merchant needs.
   */
  async check(): Promise<{ livemode: boolean }> {
    const list = await this.call<{ data?: { livemode?: boolean }[] }>("GET", "/promotion_codes", { limit: 1 });
    return { livemode: !!list.data?.[0]?.livemode };
  }
}

/**
 * When Stripe refuses a write because the restricted key lacks the scope, say so in words the
 * merchant can act on — including which permission, and that keys can't be edited after the
 * fact (live lesson, first run: a merchant created a key with no permission and had no way to
 * know until an affiliate needed a code).
 */
export function permissionProblem(e: unknown): string | undefined {
  const err = e as StripeApiError;
  if (!(err instanceof StripeApiError)) return undefined;
  if (err.status === 401) return "Stripe doesn't recognise that key. Check you copied the whole thing.";
  if (err.status === 403 || /permission/i.test(err.message)) {
    return (
      'That key can\'t create discount codes. Stripe keys can\'t be edited afterwards, so make a NEW ' +
      'restricted key with "Promotion codes" set to Write (everything else None) and paste that one.'
    );
  }
  return undefined;
}
