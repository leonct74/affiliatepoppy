// The family's onboarding banner: paste-into-any-AI, built from THIS install's live state.
// What is protected: the prompt must carry the real addresses and numbers (a generic guide
// would send merchants clicking through screens that don't match), and it must encode the
// Stripe lessons that cost live debugging time — the Billing-group key page, the
// connected-accounts webhook scope, and tear-down-before-live.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HelperBanner } from "./HelperBanner";
import { buildHelperPrompt } from "./helper-prompt";
import type { DeploymentStatus, ProgramConfig } from "./types";

const status: DeploymentStatus = {
  phase: "ready", stackName: "s", region: "eu-west-1", inProgress: false, currentTemplateKey: "t",
  updateAvailable: false,
  receiverUrl: "https://recv.lambda-url.eu-west-1.on.aws/",
  portalUrl: "https://portal.lambda-url.eu-west-1.on.aws/",
};
const config: ProgramConfig = {
  settings: { discountPct: 7, commissionPct: 12, firstPaymentOnly: false, autoApprove: false, maxAffiliates: 1000 },
  branding: { merchantName: "Olly", accentColor: "#bccf9e", logoDataUri: "", offerCopy: "", termsText: "" },
  stripe: { couponId: "co_1", lastEventAt: 0, livemode: false, partners: [] },
  offer: "",
  secrets: { webhookSecret: { stored: true, hint: "…1" }, apiKey: { stored: true, hint: "…2" } },
};

describe("the helper prompt", () => {
  it("carries this install's real addresses and numbers — never a generic guide", () => {
    const p = buildHelperPrompt(status, config);
    expect(p).toContain("https://recv.lambda-url.eu-west-1.on.aws/");
    expect(p).toContain("https://portal.lambda-url.eu-west-1.on.aws/");
    expect(p).toContain("currently 7%");
    expect(p).toContain("currently 12%");
  });

  it("encodes the Stripe lessons that cost live debugging time", () => {
    const p = buildHelperPrompt(status, config);
    expect(p).toMatch(/BILLING group to Write/i);
    expect(p).toMatch(/scope "Connected accounts"/);
    expect(p).toMatch(/tear everything down|tear it all down|Remove tab\) before setting up live|must tear/i);
    expect(p).toMatch(/checkout\.session\.completed, invoice\.paid, charge\.refunded/);
    // The pinned webhook version — "latest" would freeze whatever Stripe shipped last month,
    // untested (founder's catch, 2026-08-20).
    expect(p).toContain("2026-07-29.dahlia");
  });

  it("tells the AI where the merchant actually is, and never promises money movement", () => {
    expect(buildHelperPrompt(null, null)).toContain("Nothing is set up yet");
    const p = buildHelperPrompt(status, config);
    expect(p).toContain("the programme is open");
    expect(p).toMatch(/can never move, hold, or receive money/i);
  });

  it("copies on the button — and stops pulsing once used", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    render(<HelperBanner status={status} config={config} />);
    const button = screen.getByRole("button", { name: /copy the helper prompt/i });
    expect(button.className).toContain("poppy-helper-pulse");
    await userEvent.click(button);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("AffiliatePoppy"));
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copied/i }).className).not.toContain("poppy-helper-pulse");
  });
});
