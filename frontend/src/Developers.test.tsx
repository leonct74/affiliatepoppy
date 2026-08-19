// The optional platform card — P7. Two things matter: a merchant who is NOT a platform is
// told so in one line and never sees the machinery, and a merchant who is gets the three
// actions (second secret, add a developer, create missing codes) with honest outcomes.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { Developers } from "./Developers";
import type { DeploymentStatus, ProgramConfig } from "./types";

const status: DeploymentStatus = {
  phase: "ready", stackName: "s", region: "eu-west-1", inProgress: false, currentTemplateKey: "t",
  updateAvailable: false, receiverUrl: "https://abc.lambda-url.eu-west-1.on.aws/",
};
const config = (over: Partial<ProgramConfig["stripe"]> = {}, connect?: { stored: boolean; hint: string }): ProgramConfig => ({
  settings: { discountPct: 5, commissionPct: 10, firstPaymentOnly: false, autoApprove: false, maxAffiliates: 1000 },
  branding: { merchantName: "Olly", accentColor: "#bccf9e", logoDataUri: "", offerCopy: "", termsText: "" },
  stripe: { couponId: "co_1", lastEventAt: 0, livemode: false, partners: [], ...over },
  offer: "",
  secrets: { webhookSecret: { stored: true, hint: "…1" }, apiKey: { stored: true, hint: "…2" }, ...(connect ? { connectSecret: connect } : {}) },
});

beforeEach(() => vi.restoreAllMocks());

describe("for a merchant who isn't a platform", () => {
  it("is one line and a button — the machinery stays folded away", () => {
    render(<Developers status={status} config={config()} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByText(/if that isn't you, skip this/i)).toBeInTheDocument();
    expect(screen.getByText("Not used")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("acct_…")).not.toBeInTheDocument();
  });
});

describe("for a platform", () => {
  it("adds a developer, creates the codes there, and says what happened", async () => {
    vi.spyOn(api, "addPartner").mockResolvedValue({
      partners: [{ account: "acct_1AbCdEfGhIjK", label: "Olly's Tools", couponId: "co_dev", couponPct: 5 }],
      sync: { minted: 3, failures: [] },
    });
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<Developers status={status} config={config()} onChanged={changed} />);
    await userEvent.click(screen.getByRole("button", { name: /i run a platform/i }));
    await userEvent.type(screen.getByPlaceholderText("acct_…"), "acct_1AbCdEfGhIjK");
    await userEvent.type(screen.getByPlaceholderText(/olly's tools/i), "Olly's Tools");
    await userEvent.click(screen.getByRole("button", { name: /add developer/i }));

    expect(api.addPartner).toHaveBeenCalledWith("acct_1AbCdEfGhIjK", "Olly's Tools");
    expect(await screen.findByText(/created 3 codes on developers' accounts/i)).toBeInTheDocument();
    expect(screen.getByText("Olly's Tools")).toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
  });

  it("names every code that could NOT be created, per developer — never a silent partial", async () => {
    vi.spyOn(api, "syncCodes").mockResolvedValue({
      minted: 1,
      failures: [{ account: "acct_1AbCdEfGhIjK", label: "Dev A", message: "This key can't act on that account.", affiliate: "Oliver" }],
    });
    const withPartner = config({ partners: [{ account: "acct_1AbCdEfGhIjK", label: "Dev A", couponId: "co_a", couponPct: 5 }] });
    render(<Developers status={status} config={withPartner} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    await userEvent.click(screen.getByRole("button", { name: /manage developers/i }));
    await userEvent.click(screen.getByRole("button", { name: /create any missing codes/i }));
    expect(await screen.findByText(/1 couldn't be created/i)).toBeInTheDocument();
    expect(screen.getByText(/this key can't act on that account/i)).toBeInTheDocument();
    expect(screen.getByText("Oliver")).toBeInTheDocument();
  });

  it("explains the SECOND webhook is the connected-accounts kind, and saves its own secret", async () => {
    const save = vi.spyOn(api, "saveSecret").mockResolvedValue({ stored: true, hint: "…9" });
    render(<Developers status={status} config={config()} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    await userEvent.click(screen.getByRole("button", { name: /i run a platform/i }));
    expect(screen.getByText(/choose/i)).toBeInTheDocument();
    expect(screen.getByText("Connected accounts")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("whsec_…"), "whsec_connect");
    await userEvent.click(screen.getByRole("button", { name: /save signing secret/i }));
    expect(save).toHaveBeenCalledWith("connectSecret", "whsec_connect");
  });

  it("removing a developer keeps what they owe on the ledger, and says so", async () => {
    vi.spyOn(api, "removePartner").mockResolvedValue({ partners: [] });
    const withPartner = config({ partners: [{ account: "acct_1AbCdEfGhIjK", label: "Dev A", couponId: "co_a", couponPct: 5 }] });
    render(<Developers status={status} config={withPartner} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    await userEvent.click(screen.getByRole("button", { name: /manage developers/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(await screen.findByText(/what they owe you stays on the ledger/i)).toBeInTheDocument();
  });
});
