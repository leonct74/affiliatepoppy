// D20 webhook automation. What is protected: idempotency by the metadata stamp (a rerun
// never duplicates a destination), the only-at-creation secret rule surfacing as WORDS with
// both ways out, and Stripe's permission refusal becoming the exact key edit to make.
import { describe, expect, it } from "vitest";
import { StripeApiError, type StripeClient, type WebhookEndpoint } from "../../shared/src/stripe-api";
import { ensureWebhooks, rotateWebhooks, WEBHOOK_EVENTS, type WebhookPlanItem } from "./webhook-setup";

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

describe("a renamed address", () => {
  it("replaces an app-created destination whose URL went stale — the feed follows the address", async () => {
    const created: Array<Record<string, unknown>> = [];
    const deleted: string[] = [];
    const stripe = {
      async listWebhookEndpoints() {
        return [{ id: "we_old", url: "https://agentspoppy.com/api/portal/stripe/affiliates-portal", metadata: { affiliatepoppy: "feed" } }];
      },
      async deleteWebhookEndpoint(id: string) {
        deleted.push(id);
        return { id, deleted: true };
      },
      async createWebhookEndpoint(args: Record<string, unknown>) {
        created.push(args);
        return { id: "we_new", url: String(args.url), secret: "whsec_fresh" };
      },
    } as unknown as StripeClient;
    const feed = item("feed", { stored: true, url: "https://agentspoppy.com/api/portal/stripe/olly-digital" });
    const report = await ensureWebhooks(stripe, [feed]);
    expect(deleted).toEqual(["we_old"]);
    expect(created[0]).toMatchObject({ url: "https://agentspoppy.com/api/portal/stripe/olly-digital" });
    expect(feed.secrets).toEqual(["whsec_fresh"]);
    expect(report.created).toEqual(["Public page ledger feed: moved to the new address and reconnected."]);
  });
});

describe("rotateWebhooks", () => {
  const withDelete = (opts: Parameters<typeof fakeStripe>[0] & { deleteError?: Error } = {}) => {
    const base = fakeStripe(opts);
    const deleted: string[] = [];
    (base.stripe as unknown as Record<string, unknown>).deleteWebhookEndpoint = async (id: string) => {
      if (opts.deleteError) throw opts.deleteError;
      deleted.push(id);
      return { id, deleted: true };
    };
    return { ...base, deleted };
  };

  it("deletes the stamped destination and installs a fresh secret in one motion", async () => {
    const h = withDelete({
      existing: [{ id: "we_old", url: "https://recv.example/", metadata: { affiliatepoppy: "receiver" } }],
    });
    const receiver = item("receiver", { stored: true });
    const report = await rotateWebhooks(h.stripe, [receiver]);
    expect(h.deleted).toEqual(["we_old"]);
    expect(receiver.secrets).toEqual(["whsec_receiver"]);
    expect(report.created).toEqual(["Sales tracking (your account): rotated — new secret installed."]);
  });

  it("never touches a hand-made setup — it points at Stripe's own roll + the manual card instead", async () => {
    const h = withDelete({ existing: [{ id: "we_manual", url: "https://recv.example/" }] });
    const report = await rotateWebhooks(h.stripe, [item("receiver", { stored: true })]);
    expect(h.deleted).toEqual([]);
    expect(report.skipped[0]).toMatch(/set up by hand/);
    expect(report.skipped[0]).toMatch(/manual card/);
  });

  it("a rotation that deletes but fails to recreate says the role is DOWN and how to finish", async () => {
    const h = withDelete({
      existing: [{ id: "we_old", url: "https://recv.example/", metadata: { affiliatepoppy: "receiver" } }],
      createError: new StripeApiError("boom", 500, "error"),
    });
    const receiver = item("receiver", { stored: true });
    const report = await rotateWebhooks(h.stripe, [receiver]);
    expect(h.deleted).toEqual(["we_old"]);
    expect(receiver.secrets).toEqual([]);
    expect(report.problems[0]).toMatch(/aren't being received/);
    expect(report.problems[0]).toMatch(/press the button again/);
  });
});
