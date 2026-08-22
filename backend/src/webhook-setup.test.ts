// D20 webhook automation. What is protected: idempotency by the metadata stamp (a rerun
// never duplicates a destination), the only-at-creation secret rule surfacing as WORDS with
// both ways out, and Stripe's permission refusal becoming the exact key edit to make.
import { describe, expect, it } from "vitest";
import { StripeApiError, type StripeClient, type WebhookEndpoint } from "../../shared/src/stripe-api";
import { ensureWebhooks, WEBHOOK_EVENTS, type WebhookPlanItem } from "./webhook-setup";

function fakeStripe(opts: {
  existing?: WebhookEndpoint[];
  listError?: Error;
  createError?: Error;
  noSecret?: boolean;
}) {
  const created: Array<Record<string, unknown>> = [];
  const stripe = {
    async listWebhookEndpoints() {
      if (opts.listError) throw opts.listError;
      return opts.existing ?? [];
    },
    async createWebhookEndpoint(args: Record<string, unknown>) {
      if (opts.createError) throw opts.createError;
      created.push(args);
      return { id: `we_${created.length}`, url: String(args.url), ...(opts.noSecret ? {} : { secret: `whsec_${args.role}` }) };
    },
  } as unknown as StripeClient;
  return { stripe, created };
}

function item(role: WebhookPlanItem["role"], over: Partial<WebhookPlanItem> = {}) {
  const stored: string[] = [];
  const it: WebhookPlanItem & { secrets: string[] } = {
    role,
    url: role === "feed" ? "https://agentspoppy.com/api/portal/stripe/olly" : "https://recv.example/",
    connect: role === "connect",
    stored: false,
    secrets: stored,
    store: async (s) => {
      stored.push(s);
    },
    ...over,
  };
  return it;
}

describe("ensureWebhooks", () => {
  it("creates every missing destination with the pinned version and the three events, and stores each secret", async () => {
    const { stripe, created } = fakeStripe({});
    const receiver = item("receiver");
    const connect = item("connect");
    const feed = item("feed");
    const report = await ensureWebhooks(stripe, [receiver, connect, feed]);
    expect(report.created).toHaveLength(3);
    expect(report.problems).toEqual([]);
    expect(created.map((c) => c.role)).toEqual(["receiver", "connect", "feed"]);
    expect(created[1]).toMatchObject({ connect: true, apiVersion: "2026-07-29.dahlia", events: WEBHOOK_EVENTS });
    expect(receiver.secrets).toEqual(["whsec_receiver"]);
    expect(feed.secrets).toEqual(["whsec_feed"]);
  });

  it("NEVER creates over a hand-made setup: a stored secret with no stamped endpoint is left untouched", async () => {
    // The founder's live install (2026-08-22): webhooks made manually before the button
    // existed. Creating "our" endpoint would duplicate deliveries and overwrite the stored
    // secret, breaking the original destination silently.
    const { stripe, created } = fakeStripe({
      existing: [{ id: "we_manual", url: "https://recv.example/" }], // no metadata stamp
    });
    const receiver = item("receiver", { stored: true });
    const report = await ensureWebhooks(stripe, [receiver]);
    expect(created).toHaveLength(0);
    expect(receiver.secrets).toEqual([]);
    expect(report.skipped[0]).toMatch(/set up by hand earlier/);
    expect(report.skipped[0]).toMatch(/left untouched/);
  });

  it("recognises its own earlier work by the metadata stamp and skips it", async () => {
    const { stripe, created } = fakeStripe({
      existing: [{ id: "we_1", url: "https://recv.example/", metadata: { affiliatepoppy: "receiver" } }],
    });
    const report = await ensureWebhooks(stripe, [item("receiver", { stored: true })]);
    expect(report.skipped).toEqual(["Sales tracking (your account): already set up."]);
    expect(created).toHaveLength(0);
  });

  it("an endpoint that exists WITHOUT a stored secret becomes words with both ways out — never a silent re-create", async () => {
    const { stripe, created } = fakeStripe({
      existing: [{ id: "we_1", url: "https://recv.example/", description: "AffiliatePoppy — Sales tracking (your account)", metadata: { affiliatepoppy: "receiver" } }],
    });
    const report = await ensureWebhooks(stripe, [item("receiver")]);
    expect(created).toHaveLength(0);
    expect(report.problems[0]).toMatch(/secret isn't stored here/);
    expect(report.problems[0]).toMatch(/Delete the destination/);
    expect(report.problems[0]).toMatch(/manual card/);
  });

  it("a permission refusal quotes Stripe verbatim and names the exact key edit", async () => {
    const { stripe } = fakeStripe({
      listError: new StripeApiError("This API key does not have access to webhook_endpoints", 403, "permission"),
    });
    const report = await ensureWebhooks(stripe, [item("receiver")]);
    expect(report.problems[0]).toContain("This API key does not have access to webhook_endpoints");
    expect(report.problems[0]).toMatch(/"Webhook Endpoints" to Write/);
    expect(report.created).toEqual([]);
  });

  it("one failing create never stops the rest", async () => {
    let calls = 0;
    const stripe = {
      async listWebhookEndpoints() {
        return [];
      },
      async createWebhookEndpoint(args: Record<string, unknown>) {
        calls++;
        if (args.role === "receiver") throw new StripeApiError("boom", 500, "error");
        return { id: "we_x", url: String(args.url), secret: "whsec_ok" };
      },
    } as unknown as StripeClient;
    const report = await ensureWebhooks(stripe, [item("receiver"), item("feed")]);
    expect(calls).toBe(2);
    expect(report.problems).toHaveLength(1);
    expect(report.created).toEqual(["Public page ledger feed: created and connected."]);
  });

  it("a creation that comes back without a secret is a problem, not a stored empty string", async () => {
    const { stripe } = fakeStripe({ noSecret: true });
    const feed = item("feed");
    const report = await ensureWebhooks(stripe, [feed]);
    expect(report.problems[0]).toMatch(/no signing secret/);
    expect(feed.secrets).toEqual([]);
  });
});
