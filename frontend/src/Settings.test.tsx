// The address-change card's feedback. Born from a live failure (founder, 2026-08-22: "it is
// crap, I can't change it"): the name he typed failed the pattern, the button went grey, and
// NOTHING on screen said why. A disabled control with no sentence beside it is a dead end, so
// every reason the button can be off is pinned here.
import { describe, expect, it } from "vitest";
import { slugProblem } from "./Settings";

describe("why the address can't be moved to this name", () => {
  it("says nothing at all for an empty field — an empty box explains itself", () => {
    expect(slugProblem("", "old-name")).toBeNull();
  });

  it("accepts a good name silently", () => {
    expect(slugProblem("affiliates-personal-portal", "old-name")).toBeNull();
    expect(slugProblem("shop123", "old-name")).toBeNull();
  });

  it("names the trailing hyphen AND where it comes from — a typed space becomes one", () => {
    // The exact live failure: typing a name with a trailing space normalises to "name-",
    // which fails the pattern. Without this sentence the button is simply dead.
    const msg = slugProblem("affiliates-personal-portal-", "old-name");
    expect(msg).toMatch(/can't start or end with a hyphen/);
    expect(msg).toMatch(/space at the end/);
    expect(slugProblem("-leading", "old-name")).toMatch(/hyphen/);
  });

  it("says a too-short name is too short, rather than nothing", () => {
    expect(slugProblem("ab", "old-name")).toMatch(/at least 3/i);
  });

  it("catches the no-op rename instead of leaving a dead button", () => {
    expect(slugProblem("same-name", "same-name")).toMatch(/already your address/);
  });

  it("every rejected name yields a sentence — no silent refusals", () => {
    for (const bad of ["ab", "-x", "x-", "a".repeat(31), "same"]) {
      expect(slugProblem(bad, "same")).toBeTruthy();
    }
  });
});
