// Publishing to the platform portal — the poppy's half of the Q1 handshake.
//
// What is protected: the token is saved BEFORE the slug (a slug without a token is a page
// nobody can ever update); Pro and the merchant's name gate the flow with sentences, not
// stack traces; the platform's refusals become words a merchant can act on; and a failed
// background update never breaks the merchant's own save.

import { describe, expect, it } from "vitest";
import { closePortal, publishPortal, pushPortalUpdate, renamePortal, sendPortalWebhookSecret, type PortalPublishDeps } from "./portal-publish";

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
    expect(calls[0]!.body.plan).toBe("pro");
    expect(saved).toEqual(["token:apt_x", "slug:olly"]);
    expect(out.url).toBe("https://affiliates.agentspoppy.com/olly");
  });

  it("D20: free installs publish too — the register carries plan 'free' so the page gets its banner", async () => {
    const { d, calls } = deps({ planPro: async () => false });
    await publishPortal(d, "olly");
    expect(calls[0]!.body.plan).toBe("free");
  });

  it("turns the platform's refusals into words: taken names and bad names", async () => {
    const taken = deps({}, [{ status: 409, body: { error: "slug_taken" } }]);
    await expect(publishPortal(taken.d, "olly")).rejects.toThrow(/already taken/);
    const bad = deps({}, [{ status: 422, body: { error: "bad_slug" } }]);
    await expect(publishPortal(bad.d, "x")).rejects.toThrow(/lowercase letters, digits and hyphens/);
    expect(taken.saved).toEqual([]); // nothing persisted on failure
  });
});

describe("renaming the address", () => {
  it("moves the slug locally only after the platform said yes, keeping the token", async () => {
    const { d, calls, state } = deps({}, [{ status: 200, body: { slug: "olly-digital", url: "https://affiliates.agentspoppy.com/olly-digital" } }]);
    state.slug = "affiliates-portal";
    state.token = "apt_x";
    const out = await renamePortal(d, " Olly-Digital ");
    expect(calls[0]!.url).toContain("/api/portal/rename");
    expect(calls[0]!.body).toEqual({ slug: "affiliates-portal", token: "apt_x", newSlug: "olly-digital" });
    expect(state.slug).toBe("olly-digital");
    expect(state.token).toBe("apt_x"); // unchanged — the poppy keeps its stored token
    expect(out.url).toBe("https://affiliates.agentspoppy.com/olly-digital");
  });

  it("the platform's refusals become sentences — especially the one that protects publishers", async () => {
    const busy = deps({}, [{ status: 409, body: { error: "has_publishers" } }]);
    busy.state.slug = "olly";
    busy.state.token = "apt_x";
    await expect(renamePortal(busy.d, "new-name")).rejects.toThrow(/already joined through this address/);
    expect(busy.state.slug).toBe("olly"); // nothing moved locally

    const taken = deps({}, [{ status: 409, body: { error: "slug_taken" } }]);
    taken.state.slug = "olly";
    taken.state.token = "apt_x";
    await expect(renamePortal(taken.d, "new-name")).rejects.toThrow(/already taken/);
  });

  it("demands an existing publication first", async () => {
    const { d, calls } = deps();
    await expect(renamePortal(d, "new-name")).rejects.toThrow(/claim your address first/);
    expect(calls).toHaveLength(0);
  });
});

describe("the ledger-feed secret (Q3)", () => {
  it("passes the secret straight through with slug and token — and ONLY those fields", async () => {
    const { d, calls, state } = deps();
    state.slug = "olly";
    state.token = "apt_x";
    await sendPortalWebhookSecret(d, "  whsec_Abc123456789  ");
    expect(calls[0]!.url).toContain("/api/portal/merchant");
    expect(calls[0]!.body).toEqual({ slug: "olly", token: "apt_x", webhookSecret: "whsec_Abc123456789" });
    // No branding/deal riding along: a secret delivery must never blank the page.
    expect(calls[0]!.body).not.toHaveProperty("branding");
  });

  it("refuses things that are not signing secrets, before any network call", async () => {
    const { d, calls, state } = deps();
    state.slug = "olly";
    state.token = "apt_x";
    for (const bad of ["", "sk_live_abc12345", "whsec_", "whsec_has spaces"]) {
      await expect(sendPortalWebhookSecret(d, bad)).rejects.toThrow(/whsec_/);
    }
    expect(calls).toHaveLength(0);
  });

  it("demands a published portal first, and turns platform refusals into words", async () => {
    const unpublished = deps();
    await expect(sendPortalWebhookSecret(unpublished.d, "whsec_Abc123456789")).rejects.toThrow(/Publish your portal first/);
    const badToken = deps({}, [{ status: 403, body: { error: "bad_token" } }]);
    badToken.state.slug = "olly";
    badToken.state.token = "apt_x";
    await expect(sendPortalWebhookSecret(badToken.d, "whsec_Abc123456789")).rejects.toThrow(/didn't recognise/);
  });
});

describe("closing the page at teardown", () => {
  it("presents the token while it still exists, and reports the page's new state in words", async () => {
    const { d, calls, state } = deps({}, [{ status: 200, body: { closed: true, slug: "olly" } }]);
    state.slug = "olly";
    state.token = "apt_x";
    const out = await closePortal(d);
    expect(calls[0]!.url).toContain("/api/portal/close");
    expect(calls[0]!.body).toEqual({ slug: "olly", token: "apt_x" });
    expect(out.done).toBe(true);
    expect(out.note).toMatch(/programme has closed/);
    expect(out.note).toMatch(/keep seeing what they earned/);
  });

  it("nothing published — or storage already gone from an earlier pass — is SUCCESS, silently", async () => {
    const idle = deps();
    expect(await closePortal(idle.d)).toEqual({ done: true, note: "" });
    const gone = deps({
      portalSlug: async () => {
        throw new Error("Requested resource not found");
      },
    });
    expect(await closePortal(gone.d)).toEqual({ done: true, note: "" });
    expect(idle.calls).toEqual([]); // no network for a page that was never claimed
    expect(gone.calls).toEqual([]);
  });

  it("never throws: an unreachable platform becomes a sentence that says the page is STILL UP", async () => {
    const { d, state } = deps({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    });
    state.slug = "olly";
    state.token = "apt_x";
    const out = await closePortal(d);
    expect(out.done).toBe(false);
    expect(out.note).toMatch(/still up/);
    expect(out.note).toMatch(/affiliates\.agentspoppy\.com\/olly/);
  });

  it("a 404 counts as closed — teardown re-runs must not fail on work already done", async () => {
    const { d, state } = deps({}, [{ status: 404, body: { error: "not_found" } }]);
    state.slug = "olly";
    state.token = "apt_x";
    expect((await closePortal(d)).done).toBe(true);
  });

  it("an unrecognised token says so, and that the page needs support to come down", async () => {
    const { d, state } = deps({}, [{ status: 403, body: { error: "bad_token" } }]);
    state.slug = "olly";
    state.token = "apt_bad";
    const out = await closePortal(d);
    expect(out.done).toBe(false);
    expect(out.note).toMatch(/contact support/);
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
