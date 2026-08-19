// Issuing a code — the operation where a mistake sends one affiliate's earnings to another.
//
// A code is the WHOLE of attribution in this product (D1: no cookies, nothing on the
// merchant's site). So the rule that matters more than any other is the one about
// collisions: if the code we are about to hand someone could already mean somebody else, we
// throw it away and try again rather than reuse it.

import { describe, expect, it } from "vitest";
import { CODE_PATTERN, normalizeCode, suggestCode } from "../../shared/src/codes";
import { CodeIssueError, issueCodeFor, mintOnPartners, type CodeIssuer, type CodeRegistry } from "../../shared/src/issue";

/**
 * Deterministic "randomness" so a test can predict the code that comes out — but DIFFERENT on
 * each call, exactly like the real generator. A generator that repeated itself would make
 * every retry produce the same code, which is a property of the fake, not of the product.
 */
const fixedRandom = (chars: string) => {
  let call = 0;
  return (n: number) => {
    const seq = call === 0 ? chars : `${chars.slice(0, Math.max(1, chars.length - 1))}${"BCDEFGH"[call - 1]}`;
    call += 1;
    return seq.slice(0, n).padEnd(n, "X");
  };
};

class FakeStripe implements CodeIssuer {
  taken = new Set<string>();
  created: { code: string; couponId: string; idempotencyKey?: string }[] = [];
  /** Codes that will lose a race: `findPromotionCode` misses them, the create rejects. */
  raced = new Set<string>();

  async findPromotionCode(code: string) {
    return this.taken.has(code) ? { id: `promo_${code}`, code } : undefined;
  }
  async createPromotionCode(couponId: string, code: string, idempotencyKey?: string) {
    this.created.push({ code, couponId, idempotencyKey });
    if (this.raced.has(code)) throw new Error("A promotion code with that code already exists.");
    this.taken.add(code);
    return { id: `promo_${code}`, code };
  }
}

class FakeRegistry implements CodeRegistry {
  owners = new Map<string, string>();
  profiles = new Map<string, { code: string; promotionCodeId: string; status: string }>();

  async mapCode(code: string, promotionCodeId: string, affId: string) {
    const owner = this.owners.get(code);
    // The real store's conditional put: a code may only ever mean ONE affiliate.
    if (owner && owner !== affId) throw new Error("ConditionalCheckFailedException");
    this.owners.set(code, affId);
  }
  async updateAffiliate(affId: string, patch: { code: string; promotionCodeId: string; status: "active" }) {
    this.profiles.set(affId, { ...patch });
  }
}

const issue = (over: Partial<Parameters<typeof issueCodeFor>[0]> = {}) => {
  const issuer = over.issuer ?? new FakeStripe();
  const registry = over.registry ?? new FakeRegistry();
  return {
    issuer: issuer as FakeStripe,
    registry: registry as FakeRegistry,
    run: () =>
      issueCodeFor({
        affId: "aff-oliver",
        displayName: "Oliver",
        couponId: "co_5off",
        issuer,
        registry,
        random: fixedRandom("7K3M"),
        ...over,
      }),
  };
};

describe("the code an affiliate gets", () => {
  it("reads like a partnership: their name, then random characters", () => {
    // A random string reads like spam and nobody shares it; the name half is what makes a
    // code worth putting in a video description.
    expect(suggestCode("Oliver", fixedRandom("7K3M"))).toBe("OLIVER7K3M");
  });

  it("avoids the characters people mistype when a code is read aloud", () => {
    // 0/O and 1/I/L: the four that get transcribed wrongly from a video or a screenshot.
    const suffixes = Array.from({ length: 200 }, () => suggestCode("A", undefined, 6).slice(1));
    expect(suffixes.join("")).not.toMatch(/[01OIL]/);
  });

  it("is always usable, even from a name that survives normalisation as nothing", () => {
    for (const name of ["", "🎥🎥", "!!", "x"]) {
      expect(CODE_PATTERN.test(suggestCode(name, fixedRandom("7K3MQ9")))).toBe(true);
    }
  });

  it("is compared case- and punctuation-insensitively", () => {
    expect(normalizeCode(" oliver-7k3m ")).toBe("OLIVER7K3M");
  });
});

describe("issuing it", () => {
  it("creates the code in Stripe, claims it, and activates the affiliate", async () => {
    const h = issue();
    const result = await h.run();
    expect(result).toEqual({ code: "OLIVER7K3M", promotionCodeId: "promo_OLIVER7K3M" });
    expect(h.registry.owners.get("OLIVER7K3M")).toBe("aff-oliver");
    expect(h.registry.profiles.get("aff-oliver")).toMatchObject({ code: "OLIVER7K3M", status: "active" });
  });

  it("carries an idempotency key, so a retried enrolment cannot mint a second code", async () => {
    // The portal calls enrolment on every sign-in. Without this, a flaky network would give
    // one affiliate several live codes and the merchant a mess to reconcile.
    const h = issue();
    await h.run();
    expect(h.issuer.created[0]?.idempotencyKey).toBe("ap-aff-oliver-OLIVER7K3M");
  });

  it("tries another code when the first is already taken in Stripe", async () => {
    const issuer = new FakeStripe();
    issuer.taken.add("OLIVER7K3M");
    const h = issue({ issuer, random: fixedRandom("QQQQ") as never });
    // The second attempt uses fresh randomness; with our fixed generator it differs by the
    // suggestion path, so simply assert a code came out and it isn't the taken one.
    const result = await h.run();
    expect(result.code).not.toBe("OLIVER7K3M");
    expect(h.registry.owners.get(result.code)).toBe("aff-oliver");
  });

  it("retries when Stripe itself reports the code already exists (a race we lost)", async () => {
    const issuer = new FakeStripe();
    issuer.raced.add("OLIVER7K3M");
    const h = issue({ issuer });
    const result = await h.run();
    expect(result.code).not.toBe("OLIVER7K3M");
  });

  it("ABANDONS a code our own map says belongs to someone else", async () => {
    // The rule that protects the ledger: handing Oliver a code that already maps to Maria
    // would credit her sales to him. Better an orphaned Stripe code than stolen earnings.
    const registry = new FakeRegistry();
    registry.owners.set("OLIVER7K3M", "aff-maria");
    const h = issue({ registry });
    const result = await h.run();
    expect(result.code).not.toBe("OLIVER7K3M");
    expect(registry.owners.get("OLIVER7K3M")).toBe("aff-maria"); // untouched
    expect(registry.owners.get(result.code)).toBe("aff-oliver");
  });

  it("uses a code the merchant chose by hand, when it's free", async () => {
    const h = issue({ preferred: "summer-sale" });
    expect((await h.run()).code).toBe("SUMMERSALE");
  });

  it("does not retry a rejected preferred code verbatim — it would fail forever", async () => {
    const issuer = new FakeStripe();
    issuer.taken.add("SUMMERSALE");
    const h = issue({ issuer, preferred: "summer-sale" });
    const result = await h.run();
    expect(result.code).not.toBe("SUMMERSALE");
  });

  it("says plainly what's missing when the programme has no coupon yet", async () => {
    // The merchant hasn't connected Stripe. This message is shown to an affiliate mid-signup,
    // so it has to explain rather than blame them.
    await expect(issue({ couponId: "" }).run()).rejects.toBeInstanceOf(CodeIssueError);
    await expect(issue({ couponId: "" }).run()).rejects.toThrow(/isn't set up in Stripe yet/);
  });

  it("gives up cleanly after a run of collisions instead of looping forever", async () => {
    const registry = new FakeRegistry();
    // Every code we could possibly suggest is already someone else's.
    registry.mapCode = async () => {
      throw new Error("ConditionalCheckFailedException");
    };
    await expect(issue({ registry, attempts: 3 }).run()).rejects.toBeInstanceOf(CodeIssueError);
  });

  it("surfaces a real Stripe failure rather than silently trying again", async () => {
    // A revoked key or a deleted coupon is not a collision: retrying hides the actual problem
    // from the merchant, who is the only person who can fix it.
    const issuer = new FakeStripe();
    issuer.createPromotionCode = async () => {
      throw new Error("Invalid API Key provided");
    };
    await expect(issue({ issuer }).run()).rejects.toThrow(/Invalid API Key/);
  });
});

describe("minting the same code on developers' accounts (P7)", () => {
  const partners = [
    { account: "acct_a", couponId: "co_a", label: "Dev A" },
    { account: "acct_b", couponId: "co_b", label: "Dev B" },
  ];
  function harness(failOn: Record<string, string> = {}) {
    const created: { account: string; couponId: string; code: string; key?: string }[] = [];
    const mapped: string[] = [];
    const patched: Record<string, string>[] = [];
    const stripe = {
      forAccount: (account: string) => ({
        async findPromotionCode(code: string) {
          return failOn[account] === "exists" ? { id: `promo_${account}_found`, code } : undefined;
        },
        async createPromotionCode(couponId: string, code: string, key?: string) {
          if (failOn[account] === "exists") throw new Error("Promotion code already exists");
          if (failOn[account]) throw new Error(failOn[account]!);
          created.push({ account, couponId, code, key });
          return { id: `promo_${account}`, code };
        },
      }),
    };
    const registry = {
      async mapPromotionCode(id: string) { mapped.push(id); },
      async updateAffiliate(_: string, patch: { promotionCodeIds: Record<string, string> }) { patched.push(patch.promotionCodeIds); },
    };
    return { created, mapped, patched, stripe, registry };
  }

  it("mints on every participating account with THAT account's coupon and the same code string", async () => {
    const h = harness();
    const r = await mintOnPartners({ affId: "aff-1", code: "OLIVER7K3M", partners, already: {}, stripe: h.stripe, registry: h.registry });
    expect(h.created).toEqual([
      { account: "acct_a", couponId: "co_a", code: "OLIVER7K3M", key: "ap-aff-1-OLIVER7K3M-acct_a" },
      { account: "acct_b", couponId: "co_b", code: "OLIVER7K3M", key: "ap-aff-1-OLIVER7K3M-acct_b" },
    ]);
    expect(r.promotionCodeIds).toEqual({ acct_a: "promo_acct_a", acct_b: "promo_acct_b" });
    expect(h.mapped).toEqual(["promo_acct_a", "promo_acct_b"]);
    expect(h.patched).toEqual([{ acct_a: "promo_acct_a", acct_b: "promo_acct_b" }]);
    expect(r.failures).toEqual([]);
  });

  it("mints only what is missing on a re-run, and writes nothing when nothing changed", async () => {
    const h = harness();
    const r = await mintOnPartners({ affId: "aff-1", code: "X", partners, already: { acct_a: "promo_old" }, stripe: h.stripe, registry: h.registry });
    expect(h.created.map((c) => c.account)).toEqual(["acct_b"]);
    expect(r.promotionCodeIds).toEqual({ acct_a: "promo_old", acct_b: "promo_acct_b" });
    const again = await mintOnPartners({ affId: "aff-1", code: "X", partners, already: r.promotionCodeIds, stripe: h.stripe, registry: h.registry });
    expect(h.patched).toHaveLength(1); // the second run found nothing to do
    expect(again.failures).toEqual([]);
  });

  it("reports one developer's failure and still mints on the others — never all-or-nothing", async () => {
    const h = harness({ acct_a: "This key can't act on that account." });
    const r = await mintOnPartners({ affId: "aff-1", code: "X", partners, already: {}, stripe: h.stripe, registry: h.registry });
    expect(r.promotionCodeIds).toEqual({ acct_b: "promo_acct_b" });
    expect(r.failures).toEqual([{ account: "acct_a", couponId: "co_a", label: "Dev A", message: "This key can't act on that account." }]);
  });

  it("adopts a code that already exists on the account (an interrupted earlier run)", async () => {
    const h = harness({ acct_a: "exists" });
    const r = await mintOnPartners({ affId: "aff-1", code: "X", partners, already: {}, stripe: h.stripe, registry: h.registry });
    expect(r.promotionCodeIds.acct_a).toBe("promo_acct_a_found");
    expect(r.failures).toEqual([]);
  });
});
