// The Q4 minting handshake, poppy side. What is protected: keys never leave (the poppy
// POLLS and MINTS; the platform only queues and receives), the merchant's approval rules
// and cap apply to platform sign-ups exactly as to the poppy's own, a missed write-back
// reconciles on the next pass instead of re-minting, and one bad mint never stops the loop.

import { describe, expect, it } from "vitest";
import type { AffiliateProfile } from "../../shared/src/ledger";
import { activePatch, platformUid, postPublisherPatch, syncPlatformSignups, type PortalSyncDeps } from "./portal-sync";

function profileOf(over: Partial<AffiliateProfile> = {}): AffiliateProfile {
  return {
    affId: "pp_u1",
    email: "p@example.com",
    displayName: "Olly",
    status: "pending",
    code: "",
    promotionCodeId: "",
    createdDay: "2026-08-21",
    placements: [],
    ...over,
  };
}

function harness(opts: {
  signups?: Array<{ uid: string; email: string; name: string; status: string; channels?: string }>;
  autoApprove?: boolean;
  maxAffiliates?: number;
  existing?: AffiliateProfile[];
  approveFails?: boolean;
  pollStatus?: number;
}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const created: AffiliateProfile[] = [];
  const patched: Array<{ affId: string; channels: string }> = [];
  const approved: string[] = [];
  const profiles = new Map<string, AffiliateProfile>((opts.existing ?? []).map((p) => [p.affId, p]));

  const deps: PortalSyncDeps = {
    portalSlug: async () => "olly",
    readToken: async () => "apt_x",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      if (String(url).includes("/poll")) {
        return new Response(JSON.stringify({ signups: opts.signups ?? [] }), { status: opts.pollStatus ?? 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
    settings: async () => ({ autoApprove: opts.autoApprove ?? false, maxAffiliates: opts.maxAffiliates ?? 100 }),
    affiliate: async (affId) => profiles.get(affId),
    countAffiliates: async () => profiles.size,
    createAffiliate: async (p) => {
      created.push(p);
      profiles.set(p.affId, p);
    },
    updateAffiliate: async (affId, patch) => {
      patched.push({ affId, ...patch });
      const existing = profiles.get(affId);
      if (existing) profiles.set(affId, { ...existing, ...patch });
    },
    approve: async (affId) => {
      if (opts.approveFails) throw new Error("Stripe said no");
      approved.push(affId);
      const p = profileOf({ affId, status: "active", code: "OLLY7K3M", promotionCodeId: "promo_9" });
      profiles.set(affId, p);
      return p;
    },
    today: () => "2026-08-21",
  };
  return { deps, calls, created, approved, patched };
}

const SIGNUP = { uid: "u1", email: "p@example.com", name: "Olly", status: "pending" };

describe("one pass of the handshake", () => {
  it("does nothing at all for an unpublished install", async () => {
    const h = harness({});
    h.deps.portalSlug = async () => "";
    expect(await syncPlatformSignups(h.deps)).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it("imports a pending sign-up but does NOT mint while approval is manual — the merchant decides", async () => {
    const h = harness({ signups: [SIGNUP] });
    const report = await syncPlatformSignups(h.deps);
    expect(report).toEqual({ checked: 1, imported: 1, minted: 0, skippedFull: 0, errors: [] });
    expect(h.created[0]).toMatchObject({ affId: "pp_u1", status: "pending", email: "p@example.com" });
    expect(h.approved).toHaveLength(0);
  });

  it("mints when the platform recorded the join as approved, or when the programme auto-approves", async () => {
    const platformApproved = harness({ signups: [{ ...SIGNUP, status: "approved" }] });
    expect((await syncPlatformSignups(platformApproved.deps))?.minted).toBe(1);
    expect(platformApproved.approved).toEqual(["pp_u1"]);

    const auto = harness({ signups: [SIGNUP], autoApprove: true });
    expect((await syncPlatformSignups(auto.deps))?.minted).toBe(1);
  });

  it("respects the merchant's affiliate cap exactly like the poppy's own sign-up page (D8)", async () => {
    const h = harness({
      signups: [SIGNUP],
      maxAffiliates: 1,
      existing: [profileOf({ affId: "other", email: "x@example.com" })],
    });
    const report = await syncPlatformSignups(h.deps);
    expect(report?.skippedFull).toBe(1);
    expect(h.created).toHaveLength(0);
  });

  it("reconciles an already-minted publisher with a write-back instead of re-minting", async () => {
    const h = harness({
      signups: [{ ...SIGNUP, status: "approved" }],
      existing: [profileOf({ status: "active", code: "OLLY7K3M", promotionCodeId: "promo_9", promotionCodeIds: { acct_1: "promo_p1" } })],
    });
    const report = await syncPlatformSignups(h.deps);
    expect(report?.minted).toBe(0);
    expect(h.approved).toHaveLength(0);
    const writeBack = h.calls.find((c) => c.url.includes("/publisher"));
    expect(writeBack?.body).toMatchObject({
      slug: "olly",
      uid: "u1",
      status: "active",
      code: "OLLY7K3M",
      promotionCodeId: "promo_9",
      promotionCodeIdList: ["promo_p1"],
    });
  });

  it("collects a mint failure as words and keeps going — a stuck publisher must be visible", async () => {
    const h = harness({ signups: [{ ...SIGNUP, status: "approved" }], approveFails: true });
    const report = await syncPlatformSignups(h.deps);
    expect(report?.errors).toEqual(["Olly: Stripe said no"]);
  });

  it("treats a platform outage as 'try next minute', never as an exception", async () => {
    const h = harness({ pollStatus: 503 });
    expect(await syncPlatformSignups(h.deps)).toBeNull();
  });
});

describe("the write-back and the pure bits", () => {
  it("posts slug+token+uid+patch, and never throws on refusal", async () => {
    const calls: Record<string, unknown>[] = [];
    const ok = await postPublisherPatch(
      {
        portalSlug: async () => "olly",
        readToken: async () => "apt_x",
        fetchImpl: (async (_u: unknown, init?: RequestInit) => {
          calls.push(JSON.parse(String(init?.body)));
          return new Response("{}", { status: 403 });
        }) as typeof fetch,
      },
      "u1",
      { status: "retired" },
    );
    expect(ok).toBe(false);
    expect(calls[0]).toEqual({ slug: "olly", token: "apt_x", uid: "u1", status: "retired" });
  });

  it("platformUid only recognises the pp_ prefix; activePatch carries the D9 override or null", () => {
    expect(platformUid("pp_abc")).toBe("abc");
    expect(platformUid("cognito-sub")).toBe("");
    expect(activePatch(profileOf({ code: "X", promotionCodeId: "p", pctOverride: 15 }))).toMatchObject({
      status: "active",
      pctOverride: 15,
    });
    expect(activePatch(profileOf()).pctOverride).toBeNull();
  });
});

describe("what the applicant said, and what the merchant decided", () => {
  it("carries the sign-up answer onto the affiliate, and backfills a row imported before we asked", async () => {
    const withChannels = { ...SIGNUP, channels: "YouTube and a newsletter" };

    const fresh = harness({ signups: [withChannels] });
    await syncPlatformSignups(fresh.deps);
    expect(fresh.created[0]?.channels).toBe("YouTube and a newsletter");

    // The same publisher, imported by an older build that never stored the answer.
    const older = harness({ signups: [withChannels], existing: [profileOf()] });
    await syncPlatformSignups(older.deps);
    expect(older.patched).toEqual([{ affId: "pp_u1", channels: "YouTube and a newsletter" }]);
  });

  it("never mints for someone the merchant declined — not even under auto-approve", async () => {
    const h = harness({
      signups: [SIGNUP],
      autoApprove: true,
      existing: [profileOf({ status: "declined" })],
    });
    const report = await syncPlatformSignups(h.deps);
    expect(report?.minted).toBe(0);
    expect(h.approved).toEqual([]);
    // ...and the platform is told again, so the applicant's page answers them either way.
    expect(h.calls.filter((c) => c.url.includes("/publisher")).map((c) => c.body.status)).toEqual(["declined"]);
  });
});
