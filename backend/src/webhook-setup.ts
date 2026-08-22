// D20 webhook automation: create the Stripe webhook destinations FOR the merchant, with the
// merchant's own restricted key, instead of walking them through Stripe's form three times.
// Every live mishap the manual path produced — wrong scope, wrong API version, missing
// events, mislaid secret — becomes impossible, because the machine answers Stripe's form.
//
// Idempotent by metadata: each destination is stamped `affiliatepoppy=<role>` at creation,
// and a later run recognises its own work. The hard rule about secrets: Stripe reveals a
// destination's signing secret ONLY in the creation response. An endpoint that exists
// without a stored secret can therefore not be healed silently — the report says so in
// words, with the two ways out (delete it and rerun, or paste the secret in the manual
// card). The manual cards stay, as the fallback for keys without webhook permission.

import type { StripeClient, WebhookEndpoint } from "../../shared/src/stripe-api";
import { StripeApiError } from "../../shared/src/stripe-api";
import { WEBHOOK_API_VERSION } from "../../shared/src/stripe-events";

/** The three events every card has always instructed — the automation mirrors them exactly. */
export const WEBHOOK_EVENTS = ["checkout.session.completed", "invoice.paid", "charge.refunded"];

export type WebhookRole = "receiver" | "connect" | "feed";

export const ROLE_LABEL: Record<WebhookRole, string> = {
  receiver: "Sales tracking (your account)",
  connect: "Connected accounts",
  feed: "Public page ledger feed",
};

export interface WebhookPlanItem {
  role: WebhookRole;
  url: string;
  connect: boolean;
  /** Is this role's secret already where it belongs? (SSM, or the platform for the feed.) */
  stored: boolean;
  /** Store the freshly minted secret where this role keeps it. */
  store(secret: string): Promise<void>;
}

export interface EnsureWebhooksReport {
  created: string[];
  skipped: string[];
  problems: string[];
}

/**
 * Bring the merchant's Stripe destinations in line with the plan. Per item: exists with a
 * stored secret → skip; exists without one → a problem in words; missing → create and store.
 * A permission refusal on the FIRST Stripe call aborts with the how-to-fix sentence, since
 * nothing later could succeed either.
 */
export async function ensureWebhooks(stripe: StripeClient, plan: WebhookPlanItem[]): Promise<EnsureWebhooksReport> {
  const report: EnsureWebhooksReport = { created: [], skipped: [], problems: [] };
  if (plan.length === 0) return report;

  let existing: WebhookEndpoint[];
  try {
    existing = await stripe.listWebhookEndpoints();
  } catch (e) {
    report.problems.push(permissionSentence(e));
    return report;
  }

  for (const item of plan) {
    const label = ROLE_LABEL[item.role];
    const mine = existing.find((w) => w.metadata?.affiliatepoppy === item.role && w.status !== "disabled");
    if (mine && mine.url !== item.url) {
      // An app-created destination pointing at an OUTDATED address (the merchant renamed
      // their portal, so the feed URL moved). Replace it — same motion as a rotation.
      try {
        await stripe.deleteWebhookEndpoint(mine.id);
        const created = await stripe.createWebhookEndpoint({
          url: item.url,
          events: WEBHOOK_EVENTS,
          apiVersion: WEBHOOK_API_VERSION,
          description: `AffiliatePoppy — ${label}`,
          role: item.role,
          connect: item.connect,
        });
        if (!created.secret) throw new StripeApiError("Stripe sent no signing secret for the new destination.", 0, "no_secret");
        await item.store(created.secret);
        report.created.push(`${label}: moved to the new address and reconnected.`);
      } catch (e) {
        report.problems.push(`${label}: ${permissionSentence(e)} — press the button again to finish the move.`);
      }
      continue;
    }
    if (mine) {
      if (item.stored) {
        report.skipped.push(`${label}: already set up.`);
      } else {
        report.problems.push(
          `${label}: a destination from an earlier run exists in Stripe, but its secret isn't stored here — and Stripe only reveals it at creation. Delete the destination "${mine.description || mine.url}" in Stripe → Webhooks and press this again, or paste its secret in the manual card.`,
        );
      }
      continue;
    }
    // A stored secret with no stamped endpoint = the merchant set this up BY HAND before the
    // button existed. That pipeline works; creating "our" endpoint over it would duplicate
    // deliveries and orphan their original destination's secret. Leave it alone.
    if (item.stored) {
      report.skipped.push(`${label}: already connected (set up by hand earlier) — left untouched.`);
      continue;
    }
    try {
      const created = await stripe.createWebhookEndpoint({
        url: item.url,
        events: WEBHOOK_EVENTS,
        apiVersion: WEBHOOK_API_VERSION,
        description: `AffiliatePoppy — ${label}`,
        role: item.role,
        connect: item.connect,
      });
      if (!created.secret) {
        report.problems.push(`${label}: Stripe created the destination but sent no signing secret — delete it in Stripe and try again.`);
        continue;
      }
      await item.store(created.secret);
      report.created.push(`${label}: created and connected.`);
    } catch (e) {
      report.problems.push(`${label}: ${permissionSentence(e)}`);
    }
  }
  return report;
}

/**
 * Rotate the signing secrets of the destinations THIS APP created: delete each stamped
 * endpoint and create a fresh one, storing the new secret in the same motion. Two uses,
 * both said in the UI: routine secret hygiene, and REPAIR after someone rolled a secret in
 * Stripe's dashboard (the app cannot detect a stale secret — Stripe never re-reveals one —
 * so this is the honest recovery). Hand-made destinations are never touched: rolling those
 * is the merchant's own act in Stripe, and the new secret goes in the manual card.
 */
export async function rotateWebhooks(stripe: StripeClient, plan: WebhookPlanItem[]): Promise<EnsureWebhooksReport> {
  const report: EnsureWebhooksReport = { created: [], skipped: [], problems: [] };
  if (plan.length === 0) return report;

  let existing: WebhookEndpoint[];
  try {
    existing = await stripe.listWebhookEndpoints();
  } catch (e) {
    report.problems.push(permissionSentence(e));
    return report;
  }

  for (const item of plan) {
    const label = ROLE_LABEL[item.role];
    const mine = existing.find((w) => w.metadata?.affiliatepoppy === item.role && w.status !== "disabled");
    if (!mine) {
      report.skipped.push(
        item.stored
          ? `${label}: set up by hand, so the app can't rotate it — roll the secret in Stripe's dashboard and paste the new whsec_… in the manual card.`
          : `${label}: nothing to rotate yet.`,
      );
      continue;
    }
    try {
      await stripe.deleteWebhookEndpoint(mine.id);
    } catch (e) {
      report.problems.push(`${label}: ${permissionSentence(e)}`);
      continue;
    }
    try {
      const created = await stripe.createWebhookEndpoint({
        url: item.url,
        events: WEBHOOK_EVENTS,
        apiVersion: WEBHOOK_API_VERSION,
        description: `AffiliatePoppy — ${label}`,
        role: item.role,
        connect: item.connect,
      });
      if (!created.secret) throw new StripeApiError("Stripe sent no signing secret for the new destination.", 0, "no_secret");
      await item.store(created.secret);
      report.created.push(`${label}: rotated — new secret installed.`);
    } catch (e) {
      // The old destination is already gone; the merchant must know this role is DOWN
      // until a re-press succeeds — never bury a half-finished rotation in a quiet log.
      report.problems.push(
        `${label}: the old destination was removed but the new one couldn't be finished (${(e as Error).message}) — press the button again to complete it; until then these events aren't being received.`,
      );
    }
  }
  return report;
}

/** Stripe's refusal, verbatim, plus the one edit that fixes the common case. */
function permissionSentence(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof StripeApiError && (e.status === 401 || e.status === 403 || /permission|access/i.test(message))) {
    return `Stripe wouldn't let your key manage webhooks: "${message}" — edit your restricted key in Stripe (Developers → API keys) and set "Webhook Endpoints" to Write (both columns if you use connected accounts), then press this again. The manual cards below still work meanwhile.`;
  }
  return message;
}
