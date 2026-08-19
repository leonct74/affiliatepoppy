// The exact bytes we send Stripe. There is no SDK to get this right for us, and the first
// live approval failed on precisely this: the request shape for promotion codes depends on
// the API version, and we were letting the merchant's account decide which one.

import { describe, expect, it } from "vitest";
import { STRIPE_API_VERSION, StripeApiError, StripeClient } from "../../shared/src/stripe-api";

function capture(reply: unknown = { id: "promo_1", code: "X", active: true }, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
  return { calls, client: new StripeClient({ apiKey: "rk_test_x", fetchImpl }) };
}

describe("talking to Stripe", () => {
  it("pins the API version on every call, so the merchant's account default can't change the wire shape", async () => {
    const { calls, client } = capture();
    await client.getCoupon("co_1");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["stripe-version"]).toBe(STRIPE_API_VERSION);
    expect(STRIPE_API_VERSION).toBe("2025-09-30.clover");
  });

  it("creates a promotion code in the polymorphic form — `promotion[coupon]`, never bare `coupon`", async () => {
    // Live failure, first approval: "Received unknown parameter: coupon".
    const { calls, client } = capture();
    await client.createPromotionCode("co_5off", "OLIVER7K3M", "idem-1");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/promotion_codes");
    expect(body.get("promotion[type]")).toBe("coupon");
    expect(body.get("promotion[coupon]")).toBe("co_5off");
    expect(body.get("code")).toBe("OLIVER7K3M");
    expect(body.has("coupon")).toBe(false);
    expect((calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("idem-1");
  });

  it("creates the programme coupon as a one-off percentage", async () => {
    const { calls, client } = capture({ id: "co_1" });
    await client.createCoupon(5, "AffiliatePoppy 5% off");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("percent_off")).toBe("5");
    expect(body.get("duration")).toBe("once");
  });

  it("turns Stripe's error into one sentence with the status attached", async () => {
    const { client } = capture({ error: { message: "Received unknown parameter: coupon", type: "invalid_request_error" } }, 400);
    await expect(client.createPromotionCode("co_1", "X")).rejects.toMatchObject({
      message: "Received unknown parameter: coupon",
      status: 400,
    } satisfies Partial<StripeApiError>);
  });
});

describe("acting on a connected account (P7)", () => {
  it("sends the Stripe-Account header for that account, and not otherwise", async () => {
    const { calls, client } = capture();
    await client.getCoupon("co_1");
    await client.forAccount("acct_dev1").getCoupon("co_1");
    const h = (i: number) => calls[i]!.init.headers as Record<string, string>;
    expect(h(0)["stripe-account"]).toBeUndefined();
    expect(h(1)["stripe-account"]).toBe("acct_dev1");
    expect(client.forAccount("acct_dev1").account).toBe("acct_dev1");
    expect(client.account).toBe("");
  });
});
