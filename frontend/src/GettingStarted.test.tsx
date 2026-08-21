// The first tab, before the programme is open.
//
// Founder (2026-08-14): the first tab should be the destination — Affiliates — and when there
// is nothing there yet, explain what to do, in order, and take the merchant there. Not the
// Stripe instructions themselves: those are one click away.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GettingStarted } from "./GettingStarted";
import type { DeploymentStatus, ProgramConfig } from "./types";

const status = (over: Partial<DeploymentStatus> = {}): DeploymentStatus => ({
  phase: "none",
  stackName: "AffiliatePoppyStack",
  region: "eu-west-1",
  inProgress: false,
  currentTemplateKey: "t",
  updateAvailable: false,
  ...over,
});

const config = (over: Partial<ProgramConfig> = {}): ProgramConfig => ({
  settings: { discountPct: 5, commissionPct: 10, firstPaymentOnly: false, autoApprove: false, maxAffiliates: 1000 },
  branding: { merchantName: "", accentColor: "#bccf9e", logoDataUri: "", offerCopy: "", termsText: "" },
  stripe: { couponId: "", lastEventAt: 0, livemode: false, partners: [] },
  offer: "",
  plan: { pro: true },
  portal: { slug: "", url: "", feedUrl: "", feedDay: "" },
  secrets: { webhookSecret: { stored: false, hint: "" }, apiKey: { stored: false, hint: "" } },
  ...over,
});

describe("before anything is set up", () => {
  it("lists the four steps in the order they must happen, and only step 1 is actionable", () => {
    render(<GettingStarted status={status()} config={null} onGo={vi.fn()} />);
    const text = document.body.textContent ?? "";
    // The order matters: storage must exist before Stripe details have anywhere to go, and
    // before Settings has a table to save into.
    expect(text.indexOf("Create the storage")).toBeLessThan(text.indexOf("Connect your Stripe"));
    expect(text.indexOf("Connect your Stripe")).toBeLessThan(text.indexOf("Decide your deal"));
    expect(text.indexOf("Decide your deal")).toBeLessThan(text.indexOf("Share your link"));
    expect(screen.getAllByRole("button", { name: /go to setup/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /go to settings/i })).not.toBeInTheDocument();
  });

  it("takes the merchant to Setup from step 1", async () => {
    const go = vi.fn();
    render(<GettingStarted status={status()} config={null} onGo={go} />);
    await userEvent.click(screen.getByRole("button", { name: /go to setup/i }));
    expect(go).toHaveBeenCalledWith("setup");
  });
});

describe("as the merchant works through it", () => {
  it("marks storage done and unlocks Stripe and Settings once the stack is ready", () => {
    render(<GettingStarted status={status({ phase: "ready" })} config={config()} onGo={vi.fn()} />);
    expect(screen.getAllByText(/^Done$/)).toHaveLength(1);
    // Two actionable steps now: connect Stripe, decide the deal.
    expect(screen.getByRole("button", { name: /go to setup/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /go to settings/i })).toBeInTheDocument();
  });

  it("marks Stripe done only when BOTH the webhook secret and the coupon exist", () => {
    // Half a Stripe connection is no connection: codes can't be issued without the coupon,
    // and sales can't be counted without the webhook secret.
    const half = config({ secrets: { webhookSecret: { stored: true, hint: "…1" }, apiKey: { stored: true, hint: "…2" } } });
    render(<GettingStarted status={status({ phase: "ready" })} config={half} onGo={vi.fn()} />);
    expect(screen.getAllByText(/^Done$/)).toHaveLength(1); // storage only

    const full = config({
      secrets: { webhookSecret: { stored: true, hint: "…1" }, apiKey: { stored: true, hint: "…2" } },
      stripe: { couponId: "co_1", lastEventAt: 0, livemode: false, partners: [] },
    });
    render(<GettingStarted status={status({ phase: "ready" })} config={full} onGo={vi.fn()} />);
    expect(screen.getAllByText(/^Done$/)).toHaveLength(2 + 1); // +1 from the first render above
  });

  it("SHOWS the link once the programme is open — the link is the product, never a hop away", () => {
    const open = config({
      secrets: { webhookSecret: { stored: true, hint: "…1" }, apiKey: { stored: true, hint: "…2" } },
      stripe: { couponId: "co_1", lastEventAt: 0, livemode: false, partners: [] },
      branding: { merchantName: "Olly Digital", accentColor: "#bccf9e", logoDataUri: "", offerCopy: "", termsText: "" },
    });
    render(
      <GettingStarted
        status={status({ phase: "ready", portalUrl: "https://portal.lambda-url.eu-west-1.on.aws/" })}
        config={open}
        onGo={vi.fn()}
      />,
    );
    expect(screen.getByText(/this is it — the page anyone can join your affiliate programme on/i)).toBeInTheDocument();
    expect(screen.getByText("https://portal.lambda-url.eu-west-1.on.aws/")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open it/i })).toBeInTheDocument();
  });
});

describe("step 3 says which half of the deal is missing", () => {
  it("points at the empty merchant name once numbers exist — never leaves the merchant guessing", () => {
    // Live lesson (2026-08-20): percentages saved, name empty, step silently stayed open.
    render(<GettingStarted status={status({ phase: "ready" })} config={config()} onGo={vi.fn()} />);
    expect(screen.getByText(/what's missing is "your name, as your partners know it"/i)).toBeInTheDocument();
  });

  it("completes once the name is filled in", () => {
    const named = config({ branding: { merchantName: "Olly Digital", accentColor: "#bccf9e", logoDataUri: "", offerCopy: "", termsText: "" } });
    render(<GettingStarted status={status({ phase: "ready" })} config={named} onGo={vi.fn()} />);
    expect(screen.queryByText(/what's missing is/i)).not.toBeInTheDocument();
  });
});
