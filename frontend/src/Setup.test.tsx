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
import { host } from "./host";
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
  stripe: { couponId: "", lastEventAt: 0, livemode: false, partners: [] },
  offer: "Earn 10% of every sale you bring in.",
  plan: { pro: true },
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

  it("answers every question Stripe asks during webhook creation — scope, API version, events, address", () => {
    // Founder, live setup (2026-08-20): "it doesn't say what API version to choose, it
    // doesn't say what event scope to select". Stripe's creation flow asks both; a merchant
    // who has never done this stalls exactly there.
    setup();
    expect(screen.getByText('"Your account"')).toBeInTheDocument();
    expect(screen.getByText("2026-07-29.dahlia")).toBeInTheDocument();
    expect(screen.getByText("https://abc123.lambda-url.eu-west-1.on.aws/")).toBeInTheDocument();
    expect(screen.getByText("checkout.session.completed")).toBeInTheDocument();
    expect(screen.getByText("invoice.paid")).toBeInTheDocument();
    expect(screen.getByText("charge.refunded")).toBeInTheDocument();
  });

  it("says up front that test and live are one-at-a-time, and names the way between them", () => {
    // Founder, after doing the real switch (2026-08-20): the old wording explained the
    // separation but not the ACTION. What a merchant needs to know is: practise in test if
    // you like, and TEAR DOWN before going live — the poppy keeps one ledger, and mixing
    // pretend commissions with real ones would make it worthless.
    setup();
    expect(screen.getByText(/test mode or in live mode — one at a time, never both/i)).toBeInTheDocument();
    expect(screen.getByText(/first tear the test setup down/i)).toBeInTheDocument();
    expect(screen.getByText(/mixing pretend commissions with real ones/i)).toBeInTheDocument();
  });

  it("asks for a key that can do ONE narrow group of things, and says so", () => {
    // The merchant is being asked for API access to their own payment processor. The honest
    // framing — one permission group, cannot move money — is what makes that reasonable.
    // The recipe matches Stripe's REAL key page (live, 2026-08-20): resources come grouped,
    // granular rows grey out, Billing is the group — and the marketplace column is named.
    setup();
    expect(screen.getByText(/for my own use/i)).toBeInTheDocument();
    expect(screen.getByText(/greyed out; that's normal/i)).toBeInTheDocument();
    expect(screen.getByText("Billing — Write")).toBeInTheDocument();
    expect(screen.getByText(/charges, refunds and payouts are separate groups/i)).toBeInTheDocument();
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
      stripe: { couponId: "co_1", lastEventAt: 0, livemode: false, partners: [] },
    });
    setup({ config: stored });
    // …and which Stripe world it lives in, permanently — not only in the moment it was saved.
    // (Founder, first live test: "it doesn't say anything about live or testing".)
    expect(screen.getByText(/saved, ends …9zx8 — test mode/i)).toBeInTheDocument();
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
          'That key can\'t create discount codes. In Stripe, edit the key (or make a new one) and set the "Billing" permission group to Write — it covers coupons and promotion codes and cannot move money. Then save the key here again.',
      },
    });
    setup();
    await userEvent.type(screen.getByPlaceholderText("rk_…"), "rk_test_noperms");
    await userEvent.click(screen.getByRole("button", { name: /save key/i }));
    expect(await screen.findByText(/set the "billing" permission group to write/i)).toBeInTheDocument();
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

  it("offers a plain-English starting point for the terms, built from the live numbers", async () => {
    // Founder: "what would a user even write in there?" An empty box labelled "terms" is where
    // people freeze. The starting point names the things every affiliate wants to know, uses
    // the programme's own numbers (so it can never contradict the page), and marks the parts
    // only the merchant can fill.
    showSettings();
    await userEvent.click(await screen.findByRole("button", { name: /give me a starting point/i }));
    const box = screen.getByRole("textbox", { name: /your terms/i }) as HTMLTextAreaElement;
    expect(box.value).toContain("You earn 10% of what a customer pays");
    expect(box.value).toContain("5% off");
    expect(box.value).toContain("Refunds");
    expect(box.value).toContain("[Fill in:");
    expect(box.value).toContain("Olly Digital");
    // Once there's text, the button steps out of the way — it's a starting point, not a reset.
    expect(screen.queryByRole("button", { name: /give me a starting point/i })).not.toBeInTheDocument();
  });

  it("previews the affiliate's first screen, so the merchant isn't guessing", async () => {
    showSettings(config({ branding: { ...config().branding, offerCopy: "Earn 20% forever" } }));
    const preview = (await screen.findByLabelText(/preview of your affiliate page/i)) as HTMLElement;
    expect(preview).toHaveTextContent("Olly Digital");
    expect(preview).toHaveTextContent("Earn 20% forever");
  });
});

describe("the D19c lock on personalisation", () => {
  const freeConfig = (): ProgramConfig => ({ ...config(), plan: { pro: false } });
  const showSettings = (c: ProgramConfig) => render(<Settings config={c} onSaved={vi.fn().mockResolvedValue(undefined)} />);

  it("keeps the fields VISIBLE but disabled — a locked form is a demo, not a wall", async () => {
    vi.spyOn(host, "purchaseInfo").mockResolvedValue({ productId: "pro", name: "Pro", price: { amountMinor: 900, currency: "eur", kind: "subscription", interval: "month" }, owned: false });
    showSettings(freeConfig());
    const offer = (await screen.findByRole("textbox", { name: /your offer/i })) as HTMLTextAreaElement;
    expect(offer).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /your terms/i })).toBeDisabled();
    // The name and the deal stay FREE: a portal saying "Your name here" punishes the
    // publisher, and a locked deal would make the free tier useless rather than motivating.
    expect(screen.getByDisplayValue("Olly Digital")).toBeEnabled();
    expect(screen.getByDisplayValue("5")).toBeEnabled();
    // And it says what unlocking buys, with the live price.
    expect(await screen.findByText(/€9\.00\/mo/)).toBeInTheDocument();
    expect(screen.getByText(/removes the "affiliatepoppy free" notice/i)).toBeInTheDocument();
  });

  it("buys through the host bridge and persists the plan, in that order", async () => {
    vi.spyOn(host, "purchaseInfo").mockResolvedValue({ productId: "pro", name: "Pro", price: null, owned: false });
    const buy = vi.spyOn(host, "buyProduct").mockResolvedValue({ owned: true });
    const persist = vi.spyOn(api, "setPlan").mockResolvedValue({ pro: true });
    showSettings(freeConfig());
    await userEvent.click(await screen.findByRole("button", { name: /unlock pro/i }));
    expect(buy).toHaveBeenCalledWith("pro");
    expect(persist).toHaveBeenCalledWith(true);
  });

  it("says plainly when the payment didn't complete — and persists nothing", async () => {
    vi.spyOn(host, "purchaseInfo").mockResolvedValue({ productId: "pro", name: "Pro", price: null, owned: false });
    vi.spyOn(host, "buyProduct").mockResolvedValue({ owned: false });
    const persist = vi.spyOn(api, "setPlan");
    showSettings(freeConfig());
    await userEvent.click(await screen.findByRole("button", { name: /unlock pro/i }));
    expect(await screen.findByText(/didn't complete — nothing was charged/i)).toBeInTheDocument();
    expect(persist).not.toHaveBeenCalled();
  });

  it("shows no lock at all on Pro", async () => {
    showSettings(config());
    expect(await screen.findByDisplayValue("5")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unlock pro/i })).not.toBeInTheDocument();
  });
});
