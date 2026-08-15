// The Setup and Settings tabs.
//
// The Setup tab is where a merchant hands over two Stripe secrets, which is the most
// trust-dependent moment in the whole product. Two rules are tested here because breaking
// either would be a quiet betrayal rather than a visible bug:
//
//  · a secret is never rendered back — the poppy is a window people screen-share;
//  · saving the API key proves it works THERE, not silently later when an affiliate is
//    waiting for a code that will never arrive.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { Settings } from "./Settings";
import { Setup } from "./Setup";
import type { DeploymentStatus, ProgramConfig } from "./types";

const status = (over: Partial<DeploymentStatus> = {}): DeploymentStatus => ({
  phase: "ready",
  stackName: "AffiliatePoppyStack",
  region: "eu-west-1",
  inProgress: false,
  currentTemplateKey: "template-1",
  updateAvailable: false,
  receiverUrl: "https://abc123.lambda-url.eu-west-1.on.aws/",
  portalUrl: "https://xyz789.lambda-url.eu-west-1.on.aws/",
  ...over,
});

const config = (over: Partial<ProgramConfig> = {}): ProgramConfig => ({
  settings: { discountPct: 5, commissionPct: 10, firstPaymentOnly: false, autoApprove: false, maxAffiliates: 1000 },
  branding: { merchantName: "Olly Digital", accentColor: "#bccf9e", logoDataUri: "", offerCopy: "", termsText: "" },
  stripe: { couponId: "", lastEventAt: 0, livemode: false },
  offer: "Earn 10% of every sale you bring in.",
  secrets: { webhookSecret: { stored: false, hint: "" }, apiKey: { stored: false, hint: "" } },
  ...over,
});

beforeEach(() => vi.restoreAllMocks());

const setup = (props: { status?: DeploymentStatus; config?: ProgramConfig } = {}) =>
  render(
    <Setup
      status={props.status ?? status()}
      config={props.config ?? config()}
      onDeploy={vi.fn().mockResolvedValue(undefined)}
      onConfigChanged={vi.fn().mockResolvedValue(undefined)}
    />,
  );

describe("the guided path", () => {
  it("shows what it costs, and that idle costs nothing (AGENTS.md 'show the money')", () => {
    setup();
    expect(screen.getByText(/under \$1 a month/i)).toBeInTheDocument();
    expect(screen.getByText(/\$0 while nothing is happening/i)).toBeInTheDocument();
  });

  it("won't ask for Stripe details before there is anywhere to put them", () => {
    setup({ status: status({ phase: "none", receiverUrl: undefined, portalUrl: undefined }) });
    expect(screen.getByText(/finish step 1 first/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("whsec_…")).not.toBeInTheDocument();
  });

  it("gives the merchant the exact webhook address and the events to tick", () => {
    setup();
    expect(screen.getByText("https://abc123.lambda-url.eu-west-1.on.aws/")).toBeInTheDocument();
    expect(screen.getByText("checkout.session.completed")).toBeInTheDocument();
    expect(screen.getByText("invoice.paid")).toBeInTheDocument();
    expect(screen.getByText("charge.refunded")).toBeInTheDocument();
  });

  it("says up front that test and live are separate worlds", () => {
    // Founder question, first test run: "I need to create a testing webhook, don't I?" Yes —
    // and nobody should have to ask. Stripe keeps the two modes entirely apart, so a merchant
    // must pick one deliberately, and know that going live is a redo, not a switch.
    setup();
    expect(screen.getByText(/test mode or live mode — pick one and stay in it/i)).toBeInTheDocument();
    expect(screen.getByText(/codes issued in test mode don't carry over/i)).toBeInTheDocument();
  });

  it("asks for a key that can do ONE thing, and says so", () => {
    // The merchant is being asked for API access to their own payment processor. The honest
    // framing — one permission, cannot move money — is what makes that reasonable.
    setup();
    // Stripe's create-key flow is three screens, and a merchant stalled on the first run:
    // made the key, pasted it, and only then discovered there had been a permissions step. So
    // the tab walks all three, and says the permission is the one that can't be fixed later.
    expect(screen.getByText(/providing this key to a third-party application/i)).toBeInTheDocument();
    expect(screen.getByText(/each with none \/ read \/ write/i)).toBeInTheDocument();
    expect(screen.getByText(/can't be edited/i)).toBeInTheDocument();
    expect(screen.getByText("Promotion codes — Write")).toBeInTheDocument();
    expect(screen.getByText(/cannot move money, read customers, or refund anything/i)).toBeInTheDocument();
  });

  it("shares the portal link, and admits when it isn't fully open yet", () => {
    setup();
    expect(screen.getByText("https://xyz789.lambda-url.eu-west-1.on.aws/")).toBeInTheDocument();
    expect(screen.getByText(/they'll get their code as soon as stripe is connected/i)).toBeInTheDocument();
  });
});

describe("handing over a secret", () => {
  it("never shows it back — only that it's saved, and the last four characters", () => {
    const stored = config({
      secrets: { webhookSecret: { stored: true, hint: "…1234" }, apiKey: { stored: true, hint: "…9zx8" } },
      stripe: { couponId: "co_1", lastEventAt: 0, livemode: false },
    });
    setup({ config: stored });
    expect(screen.getByText(/saved, ends …9zx8/i)).toBeInTheDocument();
    // The input is empty: there is nothing here to read over anyone's shoulder.
    expect(screen.getByPlaceholderText("rk_…")).toHaveValue("");
  });

  it("checks the key with Stripe as it saves, and says which mode it's in", async () => {
    const save = vi
      .spyOn(api, "saveSecret")
      .mockResolvedValue({ stored: true, hint: "…9zx8", connection: { ok: true, livemode: false } });
    setup();
    await userEvent.type(screen.getByPlaceholderText("rk_…"), "rk_test_abc9zx8");
    await userEvent.click(screen.getByRole("button", { name: /save key/i }));

    expect(save).toHaveBeenCalledWith("apiKey", "rk_test_abc9zx8");
    expect(await screen.findByText(/your key works \(test mode\)/i)).toBeInTheDocument();
  });

  it("tells the merchant a key WITHOUT the write permission is the wrong key — never 'works'", async () => {
    // The old check was a read, which a permission-less key could pass; the merchant was told
    // "your key works" and would have found out otherwise only when an affiliate needed a code.
    vi.spyOn(api, "saveSecret").mockResolvedValue({
      stored: true,
      hint: "…9zx8",
      connection: {
        ok: false,
        livemode: false,
        message:
          'That key can\'t create discount codes. Stripe keys can\'t be edited afterwards, so make a NEW restricted key with "Promotion codes" set to Write (everything else None) and paste that one.',
      },
    });
    setup();
    await userEvent.type(screen.getByPlaceholderText("rk_…"), "rk_test_noperms");
    await userEvent.click(screen.getByRole("button", { name: /save key/i }));
    expect(await screen.findByText(/make a new restricted key with "promotion codes" set to write/i)).toBeInTheDocument();
    expect(screen.queryByText(/your key works/i)).not.toBeInTheDocument();
  });

  it("says plainly when Stripe rejects the key, rather than reporting success", async () => {
    vi.spyOn(api, "saveSecret").mockResolvedValue({
      stored: true,
      hint: "…9zx8",
      connection: { ok: false, livemode: false, message: "Invalid API Key provided" },
    });
    setup();
    await userEvent.type(screen.getByPlaceholderText("rk_…"), "rk_test_wrong");
    await userEvent.click(screen.getByRole("button", { name: /save key/i }));
    expect(await screen.findByText(/invalid api key provided/i)).toBeInTheDocument();
  });

  it("keeps the save button off until something is actually pasted", () => {
    setup();
    expect(screen.getByRole("button", { name: /save signing secret/i })).toBeDisabled();
  });
});

describe("the settings the founder insisted on owning", () => {
  const showSettings = (c = config()) => render(<Settings config={c} onSaved={vi.fn().mockResolvedValue(undefined)} />);

  it("puts both percentages in the merchant's hands (D9)", async () => {
    showSettings();
    expect(await screen.findByDisplayValue("5")).toBeInTheDocument(); // discount
    expect(screen.getByDisplayValue("10")).toBeInTheDocument(); // commission
  });

  it("explains the commission base, so 10% is never ambiguous", async () => {
    showSettings();
    expect(await screen.findByText(/after their discount and without tax/i)).toBeInTheDocument();
  });

  it("warns that changing the discount keeps existing codes on their old deal", async () => {
    // Stripe coupons are immutable, so this is not a limitation to hide — it is the promise
    // the merchant already made to everyone holding a code.
    showSettings();
    const discount = await screen.findByDisplayValue("5");
    await userEvent.clear(discount);
    await userEvent.type(discount, "8");
    expect(screen.getByText(/codes people already have keep the deal they were given/i)).toBeInTheDocument();
  });

  it("saves the whole shape of the programme in one call", async () => {
    const save = vi.spyOn(api, "saveConfig").mockResolvedValue({
      settings: config().settings,
      branding: config().branding,
      couponChanged: false,
    });
    showSettings();
    await userEvent.click(await screen.findByRole("button", { name: /save settings/i }));

    const sent = save.mock.calls[0]![0];
    expect(sent.settings).toMatchObject({ discountPct: 5, commissionPct: 10, autoApprove: false });
    expect(sent.branding).toMatchObject({ merchantName: "Olly Digital" });
  });

  it("tells the merchant when a new discount was created in Stripe", async () => {
    vi.spyOn(api, "saveConfig").mockResolvedValue({
      settings: config().settings,
      branding: config().branding,
      couponChanged: true,
    });
    showSettings();
    await userEvent.click(await screen.findByRole("button", { name: /save settings/i }));
    expect(await screen.findByText(/a new discount was created in stripe/i)).toBeInTheDocument();
  });

  it("previews the affiliate's first screen, so the merchant isn't guessing", async () => {
    showSettings(config({ branding: { ...config().branding, offerCopy: "Earn 20% forever" } }));
    const preview = (await screen.findByLabelText(/preview of your affiliate page/i)) as HTMLElement;
    expect(preview).toHaveTextContent("Olly Digital");
    expect(preview).toHaveTextContent("Earn 20% forever");
  });
});
