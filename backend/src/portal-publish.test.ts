// Publishing to the platform portal — the poppy's half of the Q1 handshake.
//
// What is protected: the token is saved BEFORE the slug (a slug without a token is a page
// nobody can ever update); Pro and the merchant's name gate the flow with sentences, not
// stack traces; the platform's refusals become words a merchant can act on; and a failed
// background update never breaks the merchant's own save.

import { describe, expect, it } from "vitest";
import { publishPortal, pushPortalUpdate, type PortalPublishDeps } from "./portal-publish";

function deps(over: Partial<PortalPublishDeps> = {}, replies: { status: number; body?: unknown }[] = []) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const saved: string[] = [];
  const state = { slug: "", token: "" };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const r = replies.shift() ?? { status: 200, body: { token: "apt_x", url: "https://affiliates.agentspoppy.com/olly" } };
    return new Response(JSON.stringify(r.body ?? { ok: true }), { status: r.status });
  }) as typeof fetch;
  const d: PortalPublishDeps = {
    planPro: async () => true,
    config: async () => ({
      settings: { discountPct: 5, commissionPct: 10, firstPaymentOnly: false, autoApprove: true },
      branding: { merchantName: "Olly Digital", accentColor: "#bccf9e", logoDataUri: "", offerCopy: "", termsText: "t" },
    }),
    portalSlug: async () => state.slug,
    savePortalSlug: async (slug) => {
      saved.push(`slug:${slug}`);
      state.slug = slug;
    },
    saveToken: async (token) => {
      saved.push(`token:${token}`);
      state.token = token;
    },
    readToken: async () => state.token,
    fetchImpl,
    ...over,
  };
  return { d, calls, saved, state };
}

describe("publishing", () => {
  it("registers, then saves the token BEFORE the slug, and hands back the friendly link", async () => {
    const { d, calls, saved } = deps();
    const out = await publishPortal(d, "  Olly ");
    expect(calls[0]!.url).toContain("/api/portal/register");
    expect(calls[0]!.body.slug).toBe("olly");
    expect(calls[0]!.body).toHaveProperty("branding");
    expect(calls[0]!.body).toHaveProperty("deal");
    expect(saved).toEqual(["token:apt_x", "slug:olly"]);
    expect(out.url).toBe("https://affiliates.agentspoppy.com/olly");
  });

  it("is Pro-gated in the backend, with a sentence", async () => {
    const { d } = deps({ planPro: async () => false });
    await expect(publishPortal(d, "olly")).rejects.toThrow(/part of AffiliatePoppy Pro/);
  });

  it("turns the platform's refusals into words: taken names and bad names", async () => {
    const taken = deps({}, [{ status: 409, body: { error: "slug_taken" } }]);
    await expect(publishPortal(taken.d, "olly")).rejects.toThrow(/already taken/);
    const bad = deps({}, [{ status: 422, body: { error: "bad_slug" } }]);
    await expect(publishPortal(bad.d, "x")).rejects.toThrow(/lowercase letters, digits and hyphens/);
    expect(taken.saved).toEqual([]); // nothing persisted on failure
  });
});

describe("the background update", () => {
  it("pushes the current payload with the stored token", async () => {
    const { d, calls, state } = deps();
    state.slug = "olly";
    state.token = "apt_x";
    expect(await pushPortalUpdate(d)).toBe(true);
    expect(calls[0]!.url).toContain("/api/portal/merchant");
    expect(calls[0]!.body.token).toBe("apt_x");
  });

  it("does nothing when unpublished, and survives a platform failure quietly", async () => {
    const idle = deps();
    expect(await pushPortalUpdate(idle.d)).toBe(false);
    expect(idle.calls).toHaveLength(0);
    const down = deps({}, [{ status: 503 }]);
    down.state.slug = "olly";
    down.state.token = "apt_x";
    expect(await pushPortalUpdate(down.d)).toBe(false); // returns false, never throws
  });
});
