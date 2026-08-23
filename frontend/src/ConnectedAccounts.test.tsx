// The Connected accounts tab — P7. Two things matter: a merchant who is NOT a marketplace is
// told in the first paragraph they can ignore the whole tab, and a merchant who is gets the
// three actions (add an account, create missing codes, second secret) with honest outcomes —
// in the product's own words, never AgentsPoppy's ("connected account", not "developer").

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { ConnectedAccounts } from "./ConnectedAccounts";
import type { DeploymentStatus, ProgramConfig } from "./types";

const status: DeploymentStatus = {
  phase: "ready", stackName: "s", region: "eu-west-1", inProgress: false, currentTemplateKey: "t",
  updateAvailable: false, receiverUrl: "https://abc.lambda-url.eu-west-1.on.aws/",
};
const config = (over: Partial<ProgramConfig["stripe"]> = {}, connect?: { stored: boolean; hint: string }): ProgramConfig => ({
  settings: { discountPct: 5, commissionPct: 10, firstPaymentOnly: false, autoApprove: false, maxAffiliates: 1000, notifyEmail: "" },
  branding: { merchantName: "Olly", accentColor: "#bccf9e", logoDataUri: "", offerCopy: "", termsText: "" },
  stripe: { couponId: "co_1", lastEventAt: 0, livemode: false, partners: [], ...over },
  offer: "",
  plan: { pro: true },
  portal: { slug: "", url: "", feedUrl: "", feedDay: "" },
  secrets: { webhookSecret: { stored: true, hint: "…1" }, apiKey: { stored: true, hint: "…2" }, ...(connect ? { connectSecret: connect } : {}) },
});

beforeEach(() => vi.restoreAllMocks());

describe("for a merchant who isn't a marketplace", () => {
  it("says in the first paragraph that the whole tab can be ignored — and never says 'developer'", () => {
    render(<ConnectedAccounts status={status} config={config()} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByText(/you can ignore this tab entirely/i)).toBeInTheDocument();
    // The product's own voice: "connected account", never "developer" — the one exception is
    // Stripe's menu path ("Developers → Webhooks"), which must be quoted as Stripe spells it.
    const ownWords = (document.body.textContent ?? "").replace(/Developers → Webhooks/g, "");
    expect(ownWords).not.toMatch(/developer/i);
  });

  it("asks for Stripe first when the programme isn't connected yet", () => {
    const notReady = config({ couponId: "" });
    render(<ConnectedAccounts status={status} config={notReady} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByText(/connect your stripe on the setup tab first/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("acct_…")).not.toBeInTheDocument();
  });
});

describe("for a marketplace", () => {
  it("adds an account, creates the codes there, and says what happened", async () => {
    vi.spyOn(api, "addPartner").mockResolvedValue({
      partners: [{ account: "acct_1AbCdEfGhIjK", label: "Olly's Tools", couponId: "co_dev", couponPct: 5 }],
      sync: { minted: 3, failures: [] },
    });
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<ConnectedAccounts status={status} config={config()} onChanged={changed} />);
    await userEvent.type(screen.getByPlaceholderText("acct_…"), "acct_1AbCdEfGhIjK");
    await userEvent.type(screen.getByPlaceholderText(/olly's tools/i), "Olly's Tools");
    await userEvent.click(screen.getByRole("button", { name: /add account/i }));

    expect(api.addPartner).toHaveBeenCalledWith("acct_1AbCdEfGhIjK", "Olly's Tools");
    expect(await screen.findByText(/created 3 codes on your connected accounts/i)).toBeInTheDocument();
    expect(screen.getByText("Olly's Tools")).toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
  });

  it("names every code that could NOT be created, per account — never a silent partial", async () => {
    vi.spyOn(api, "syncCodes").mockResolvedValue({
      minted: 1,
      failures: [{ account: "acct_1AbCdEfGhIjK", label: "Dev A", message: "This key can't act on that account.", affiliate: "Oliver" }],
    });
    const withPartner = config({ partners: [{ account: "acct_1AbCdEfGhIjK", label: "Dev A", couponId: "co_a", couponPct: 5 }] });
    render(<ConnectedAccounts status={status} config={withPartner} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    await userEvent.click(screen.getByRole("button", { name: /create any missing codes/i }));
    expect(await screen.findByText(/1 couldn't be created/i)).toBeInTheDocument();
    expect(screen.getByText(/this key can't act on that account/i)).toBeInTheDocument();
    expect(screen.getByText("Oliver")).toBeInTheDocument();
  });

  it("explains the SECOND webhook is the connected-accounts kind, and saves its own secret", async () => {
    const save = vi.spyOn(api, "saveSecret").mockResolvedValue({ stored: true, hint: "…9" });
    render(<ConnectedAccounts status={status} config={config()} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByText(/choose/i)).toBeInTheDocument();
    expect(screen.getAllByText("Connected accounts").length).toBeGreaterThan(0);
    // …and the key recipe is stated where the failure would otherwise happen — BOTH Connect
    // permissions, because Stripe's refusal named coupon_write as its own thing (live lesson).
    // "second column" spans <strong> boundaries — assert on the whole card's text instead.
    expect(document.body.textContent).toMatch(/second column/i);
    expect(document.body.textContent).toMatch(/Billing/);
    await userEvent.type(screen.getByPlaceholderText("whsec_…"), "whsec_connect");
    await userEvent.click(screen.getByRole("button", { name: /save signing secret/i }));
    expect(save).toHaveBeenCalledWith("connectSecret", "whsec_connect");
  });

  it("removing an account keeps what it owes on the ledger, and says so", async () => {
    vi.spyOn(api, "removePartner").mockResolvedValue({ partners: [] });
    const withPartner = config({ partners: [{ account: "acct_1AbCdEfGhIjK", label: "Dev A", couponId: "co_a", couponPct: 5 }] });
    render(<ConnectedAccounts status={status} config={withPartner} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(await screen.findByText(/anything it owes you stays on the ledger/i)).toBeInTheDocument();
  });
});
