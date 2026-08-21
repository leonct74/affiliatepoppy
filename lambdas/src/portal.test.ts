// The affiliate portal: what a signed-out visitor may see, what a signed-in affiliate may
// see, and the one rule that must never bend — an affiliate sees THEIR numbers and nobody
// else's, decided from the verified token rather than from anything the browser sent.
//
// The page assertions run the real served HTML through jsdom rather than matching strings,
// because what matters is what a partner's browser actually renders (and, for the escaping
// test, what it does NOT execute).

import { JSDOM, VirtualConsole } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";
import type { AffiliateProfile, LedgerEntry, Totals } from "../../shared/src/ledger";
import { CodeIssueError } from "../../shared/src/issue";
import { DEFAULT_BRANDING, DEFAULT_SETTINGS, type PortalBranding, type ProgramSettings } from "../../shared/src/settings";
import type { AffiliateClaims } from "./auth";
import { route, type HttpRequest, type PortalDeps } from "./portal";

const OLIVER: AffiliateClaims = { sub: "aff-oliver", email: "oliver@example.com", name: "Oliver", exp: 0, tokenUse: "id" };
const MARIA: AffiliateClaims = { sub: "aff-maria", email: "maria@example.com", name: "Maria", exp: 0, tokenUse: "id" };

class FakeDeps implements PortalDeps {
  pro = false;
  async planPro() {
    return this.pro;
  }
  region = "eu-west-1";
  clientId = "client-123";
  settingsValue: ProgramSettings = { ...DEFAULT_SETTINGS };
  brandingValue: PortalBranding = { ...DEFAULT_BRANDING, merchantName: "Olly Digital" };
  coupon = "co_5off";
  affiliates = new Map<string, AffiliateProfile>();
  totals = new Map<string, Totals[]>();
  entries = new Map<string, LedgerEntry[]>();
  caller: AffiliateClaims | undefined = OLIVER;
  rateLimited = false;
  issueFails: Error | undefined;
  /** Every Stripe-touching issuance we attempted — a manual-approval programme makes none. */
  issued: string[] = [];

  async authenticate() {
    return this.caller;
  }
  async branding() {
    return this.brandingValue;
  }
  async settings() {
    return this.settingsValue;
  }
  async couponId() {
    return this.coupon;
  }
  async affiliate(affId: string) {
    return this.affiliates.get(affId);
  }
  async countAffiliates() {
    return this.affiliates.size;
  }
  async createAffiliate(profile: AffiliateProfile) {
    if (this.affiliates.has(profile.affId)) throw new Error("already exists");
    this.affiliates.set(profile.affId, profile);
  }
  async issueCode({ affId }: { affId: string; displayName: string; couponId: string }) {
    if (this.issueFails) throw this.issueFails;
    this.issued.push(affId);
    const profile = this.affiliates.get(affId)!;
    this.affiliates.set(affId, { ...profile, code: "OLIVER7K3M", promotionCodeId: "promo_1", status: "active" });
  }
  async totalsFor(affId: string) {
    return this.totals.get(affId) ?? [];
  }
  async ledgerFor(affId: string) {
    return this.entries.get(affId) ?? [];
  }
  /** Which affiliate's list was written — the isolation test reads this back. */
  placementsWritten: { affId: string; placements: { url: string; note: string }[] }[] = [];
  async setPlacements(affId: string, placements: { url: string; note: string }[]) {
    this.placementsWritten.push({ affId, placements });
    const profile = this.affiliates.get(affId);
    if (profile) this.affiliates.set(affId, { ...profile, placements });
  }
  async allowEnrolment() {
    return !this.rateLimited;
  }
  today() {
    return "2026-08-14";
  }
}

let deps: FakeDeps;
beforeEach(() => {
  deps = new FakeDeps();
});

const request = (over: Partial<HttpRequest> = {}): HttpRequest => ({
  method: "GET",
  path: "/",
  headers: { authorization: "Bearer token" },
  body: "",
  sourceIp: "203.0.113.7",
  ...over,
});

const body = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;

describe("the page's own script", () => {
  it("RUNS without a syntax error, and shows the signup form", async () => {
    // First live deploy, 2026-08-14: the page rendered BLANK. Every string-level test passed —
    // the HTML was fine — but a `\/` inside a regex inside a TS template literal had been
    // eaten, the regex swallowed the rest of the line, and the whole script died before it
    // could un-hide the form. Only EXECUTING the served script can catch that class of bug,
    // so this test does: real DOM, scripts on, and the assertion is "the form is visible".
    const res = await route(request(), deps);
    const errors: string[] = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errors.push(e.message));
    const dom = new JSDOM(res.body, {
      runScripts: "dangerously",
      url: "https://portal.test/",
      virtualConsole: vc,
      beforeParse(w) {
        // No network in a test: the page's refresh-token attempt must just fail quietly.
        (w as unknown as { fetch: unknown }).fetch = async () => ({ ok: false, json: async () => ({}) });
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(errors, errors.join("\n")).toEqual([]);
    const doc = dom.window.document;
    expect(doc.getElementById("public")?.classList.contains("hide")).toBe(false);
    expect(doc.getElementById("joinCard")?.classList.contains("hide")).toBe(false);
    // And the boot actually ran: the offer sentence was written into the page by the script.
    expect(doc.getElementById("offer")?.textContent).toContain("Earn 10%");
  });
});

describe("the public page", () => {
  it("wears the merchant's name and offer — ours appears ONLY as the free-plan notice (D10 + D19c)", async () => {
    // D10 (white label) and D19c (the free-plan banner) collide by design: the one place our
    // name may appear on a free merchant's page is the plan notice — that pressure is the
    // conversion lever. On the PAID plan, D10 holds absolutely (asserted in the D19c tests).
    const deps = new FakeDeps();
    const res = await route({ method: "GET", path: "/", headers: {}, body: "", sourceIp: "" }, deps);
    const withoutNotice = res.body.replace(/<div class="planNote">.*?<\/div>/s, "");
    expect(withoutNotice).not.toMatch(/AffiliatePoppy|AgentsPoppy/);
  });

  it("carries no affiliate's data at all, signed out or not", async () => {
    deps.affiliates.set("aff-oliver", profileFor("aff-oliver"));
    deps.totals.set("aff-oliver", [{ currency: "eur", earnedCents: 12345, refundedCents: 0, paidCents: 0 }]);
    const res = await route(request(), deps);
    expect(res.body).not.toContain("oliver@example.com");
    expect(res.body).not.toContain("12345");
    expect(res.body).not.toContain("OLIVER7K3M");
  });

  it("renders the logo inline when there is one, and no broken image when there isn't", async () => {
    const withoutLogo = new JSDOM((await route(request(), deps)).body).window.document;
    expect(withoutLogo.querySelector("img.logo")).toBeNull();

    deps.brandingValue = { ...deps.brandingValue, logoDataUri: "data:image/png;base64,AAAA" };
    const withLogo = new JSDOM((await route(request(), deps)).body).window.document;
    expect(withLogo.querySelector("img.logo")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("never lets branding text become markup", async () => {
    // The merchant types this. Careless (a stray quote in their terms) or hostile, it must
    // stay TEXT: their partners are the people who would be served whatever it turned into.
    //
    // The two escapes being proved are different: `merchantName` lands in HTML, `termsText`
    // lands in a JS string literal — where JSON.stringify alone would leave `</script>` intact
    // and end the page's own script early.
    deps.brandingValue = {
      ...deps.brandingValue,
      merchantName: `</h1><script>window.pwned=1</script><h1 class="x" data-x="`,
      termsText: "</script><script>alert(1)</script>",
    };
    const res = await route(request(), deps);
    const doc = new JSDOM(res.body).window.document;

    // Exactly one script — the page's own. Anything else means we served theirs.
    expect(doc.querySelectorAll("script")).toHaveLength(1);
    // And the hostile name survived as the heading's TEXT, tags and all.
    expect(doc.querySelector("h1")?.textContent).toBe(deps.brandingValue.merchantName);
  });

  it("tells a visitor honestly when the programme isn't open for business yet", async () => {
    deps.coupon = "";
    const res = await route(request(), deps);
    expect(res.body).toContain("still being set up");
  });

  it("is never framed and never cached — it is a sign-in surface", async () => {
    const res = await route(request(), deps);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("who may read what", () => {
  beforeEach(() => {
    deps.affiliates.set("aff-oliver", profileFor("aff-oliver"));
    deps.affiliates.set("aff-maria", { ...profileFor("aff-maria"), code: "MARIA88" });
    deps.totals.set("aff-oliver", [{ currency: "eur", earnedCents: 1000, refundedCents: 0, paidCents: 0 }]);
    deps.totals.set("aff-maria", [{ currency: "eur", earnedCents: 999_999, refundedCents: 0, paidCents: 0 }]);
    deps.entries.set("aff-maria", [entry("aff-maria", "cs_maria", 999_999)]);
  });

  it("refuses every API call without a verified token", async () => {
    deps.caller = undefined;
    for (const req of [request({ path: "/api/me" }), request({ method: "POST", path: "/api/enroll" })]) {
      expect((await route(req, deps)).statusCode).toBe(401);
    }
  });

  it("shows an affiliate only their OWN numbers", async () => {
    // The isolation rule. Note there is no affiliate id in the request at all — the only
    // identity in play is the token's subject, which is why this cannot be tampered with.
    deps.caller = OLIVER;
    const mine = body(await route(request({ path: "/api/me" }), deps));
    expect(mine.totals[0].earnedCents).toBe(1000);
    expect(JSON.stringify(mine)).not.toContain("999999");
    expect(JSON.stringify(mine)).not.toContain("MARIA88");

    deps.caller = MARIA;
    const hers = body(await route(request({ path: "/api/me" }), deps));
    expect(hers.totals[0].earnedCents).toBe(999_999);
    expect(hers.affiliate.code).toBe("MARIA88");
  });

  it("reports what they are owed, not just what they earned", async () => {
    deps.totals.set("aff-oliver", [{ currency: "eur", earnedCents: 1000, refundedCents: 200, paidCents: 300 }]);
    const mine = body(await route(request({ path: "/api/me" }), deps));
    expect(mine.totals[0].owedCents).toBe(500);
  });

  it("says plainly that someone hasn't joined yet, rather than 500-ing", async () => {
    deps.affiliates.delete("aff-oliver");
    const res = await route(request({ path: "/api/me" }), deps);
    expect(res.statusCode).toBe(404);
    expect(body(res).error).toMatch(/haven't joined/);
  });

  it("shows the newest history first", async () => {
    deps.entries.set("aff-oliver", [
      { ...entry("aff-oliver", "cs_old", 100), day: "2026-01-01" },
      { ...entry("aff-oliver", "cs_new", 200), day: "2026-08-01" },
    ]);
    const mine = body(await route(request({ path: "/api/me" }), deps));
    expect(mine.entries.map((e: { day: string }) => e.day)).toEqual(["2026-08-01", "2026-01-01"]);
  });
});

describe("joining", () => {
  const enrol = () => route(request({ method: "POST", path: "/api/enroll" }), deps);

  it("issues the code immediately when the merchant chose auto-approve (D8)", async () => {
    deps.settingsValue = { ...deps.settingsValue, autoApprove: true };
    const res = body(await enrol());
    expect(res.affiliate).toMatchObject({ status: "active", code: "OLIVER7K3M" });
    expect(deps.issued).toEqual(["aff-oliver"]);
  });

  it("parks them for review — and touches Stripe not at all — when approval is manual", async () => {
    deps.settingsValue = { ...deps.settingsValue, autoApprove: false };
    const res = body(await enrol());
    expect(res.affiliate).toMatchObject({ status: "pending", code: "" });
    expect(deps.issued).toEqual([]);
  });

  it("is idempotent — the portal calls it on every sign-in", async () => {
    deps.settingsValue = { ...deps.settingsValue, autoApprove: true };
    await enrol();
    await enrol();
    expect(deps.affiliates.size).toBe(1);
    expect(deps.issued).toEqual(["aff-oliver"]); // and no second code was minted
  });

  it("heals a half-finished signup instead of dead-ending it", async () => {
    // Verified their email, but the code failed to issue that day. Their next visit fixes it
    // — there is no other way for them to ask, and no merchant action involved.
    deps.affiliates.set("aff-oliver", { ...profileFor("aff-oliver"), code: "", status: "active" });
    const res = body(await enrol());
    expect(res.affiliate.code).toBe("OLIVER7K3M");
  });

  it("keeps a retired affiliate retired — rejoining is the merchant's call, not theirs", async () => {
    deps.settingsValue = { ...deps.settingsValue, autoApprove: true };
    deps.affiliates.set("aff-oliver", { ...profileFor("aff-oliver"), code: "", status: "retired" });
    const res = body(await enrol());
    expect(res.affiliate.status).toBe("retired");
    expect(deps.issued).toEqual([]);
  });

  it("still confirms the signup worked when only the CODE failed", async () => {
    // Their account exists; telling them the whole thing failed would send them round again.
    deps.settingsValue = { ...deps.settingsValue, autoApprove: true };
    deps.issueFails = new CodeIssueError("This programme's discount isn't set up in Stripe yet.");
    const res = await enrol();
    expect(res.statusCode).toBe(200);
    expect(body(res).warning).toMatch(/isn't set up in Stripe/);
    expect(body(res).affiliate).toMatchObject({ status: "pending" });
  });

  it("closes the door politely when the programme is full", async () => {
    deps.settingsValue = { ...deps.settingsValue, maxAffiliates: 1 };
    deps.affiliates.set("someone-else", profileFor("someone-else"));
    const res = await enrol();
    expect(res.statusCode).toBe(409);
    expect(body(res).error).toMatch(/number of affiliates it can take/);
  });

  it("rate-limits a flood from one address without blaming the person reading it", async () => {
    deps.rateLimited = true;
    const res = await enrol();
    expect(res.statusCode).toBe(429);
    expect(body(res).error).toMatch(/try again in a little while/i);
  });

  it("does not re-check the cap for someone who has already joined", async () => {
    // Otherwise a full programme locks out its own existing affiliates at sign-in.
    deps.settingsValue = { ...deps.settingsValue, maxAffiliates: 1, autoApprove: true };
    await enrol();
    deps.affiliates.set("someone-else", profileFor("someone-else"));
    expect((await enrol()).statusCode).toBe(200);
  });
});

describe("where they share their code (optional, theirs to declare)", () => {
  const put = (placements: unknown) =>
    route(request({ method: "PUT", path: "/api/placements", body: JSON.stringify({ placements }) }), deps);

  beforeEach(() => {
    deps.affiliates.set("aff-oliver", profileFor("aff-oliver"));
    deps.affiliates.set("aff-maria", profileFor("aff-maria"));
  });

  it("is presented as OPTIONAL on the page — a favour to the merchant, never a requirement", async () => {
    // Founder's rule (2026-08-14): some partners will make the effort because it strengthens
    // the partnership; those who don't must lose nothing and feel no pressure. So the label
    // says so before the form does anything.
    const doc = new JSDOM((await route(request(), deps)).body).window.document;
    const card = doc.getElementById("placesCard")!;
    expect(card.textContent).toMatch(/optional — you don't need to fill this in/i);
    // Founder (2026-08-14): generic — "the merchant", not the merchant's own name.
    expect(card.textContent).toMatch(/nice for the merchant to know/i);
    expect(card.textContent).not.toMatch(/Olly Digital/);
    // …and there is no `required` anywhere in that form.
    expect(card.querySelectorAll("[required]")).toHaveLength(0);
  });

  it("writes ONLY the caller's own list — the affiliate id comes from the token, never the body", async () => {
    deps.caller = OLIVER;
    await put([{ url: "https://youtube.com/watch?v=abc", note: "my review" }]);
    expect(deps.placementsWritten).toEqual([
      { affId: "aff-oliver", placements: [{ url: "https://youtube.com/watch?v=abc", note: "my review" }] },
    ]);
    // Maria's row is untouched, whatever Oliver sent.
    expect(deps.affiliates.get("aff-maria")!.placements).toEqual([]);
  });

  it("comes back on /api/me, so the affiliate sees what they declared", async () => {
    await put([{ url: "https://instagram.com/p/xyz", note: "" }]);
    const me = body(await route(request({ path: "/api/me" }), deps));
    expect(me.affiliate.placements).toEqual([{ url: "https://instagram.com/p/xyz", note: "" }]);
  });

  it("keeps only real web links — the MERCHANT is the one who will click these", async () => {
    // A `javascript:` href opened from the poppy would run in the merchant's own frame.
    const res = body(
      await put([
        { url: "javascript:alert(1)", note: "x" },
        { url: "not a url", note: "" },
        { url: "https://blog.example.com/post", note: "blog" },
        { url: "ftp://files.example.com", note: "" },
      ]),
    );
    expect(res.placements).toEqual([{ url: "https://blog.example.com/post", note: "blog" }]);
  });

  it("drops duplicates and caps the list, so a paste-happy affiliate can't bloat their row", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ url: `https://example.com/p/${i}`, note: "" }));
    const res = body(await put([...many, { url: "https://example.com/p/0/", note: "again" }]));
    expect(res.placements).toHaveLength(20);
    expect(res.placements.filter((p: { url: string }) => p.url.startsWith("https://example.com/p/0"))).toHaveLength(1);
  });

  it("clears the list when they send an empty one — declaring nothing is always allowed", async () => {
    await put([{ url: "https://youtube.com/@oliver", note: "" }]);
    const res = body(await put([]));
    expect(res.placements).toEqual([]);
  });

  it("refuses without a token, like everything else under /api", async () => {
    deps.caller = undefined;
    expect((await put([])).statusCode).toBe(401);
  });
});

function profileFor(affId: string): AffiliateProfile {
  return {
    affId,
    email: `${affId}@example.com`,
    displayName: affId,
    status: "pending",
    code: "",
    promotionCodeId: "",
    createdDay: "2026-08-01",
    placements: [],
  };
}

function entry(affId: string, ledgerId: string, amountCents: number): LedgerEntry {
  return {
    affId,
    ledgerId,
    kind: "sale",
    amountCents,
    baseCents: amountCents * 10,
    currency: "eur",
    pct: 10,
    orderRef: ledgerId,
    day: "2026-08-01",
  };
}

describe("the free-plan notice (D19c)", () => {
  it("names the free plan, vouches for the numbers, and offers the owner the upgrade", async () => {
    const deps = new FakeDeps();
    const res = await route({ method: "GET", path: "/", headers: {}, body: "", sourceIp: "" }, deps);
    expect(res.body).toContain("AffiliatePoppy Free");
    // The one sentence that must never disappear: publishers reading this notice must not
    // doubt their earnings — "testing" wording cost that trust, so we vouch explicitly.
    expect(res.body).toContain("fully tracked and real");
    expect(res.body).toContain("Programme owner? Upgrade to Pro");
  });

  it("disappears entirely on the paid plan", async () => {
    const deps = new FakeDeps();
    deps.pro = true;
    const res = await route({ method: "GET", path: "/", headers: {}, body: "", sourceIp: "" }, deps);
    expect(res.body).not.toContain("AffiliatePoppy Free");
    expect(res.body).not.toContain('<div class="planNote">');
    // …and with the notice gone, the white label is absolute: no trace of us anywhere.
    expect(res.body).not.toMatch(/AffiliatePoppy|AgentsPoppy/);
  });
});
