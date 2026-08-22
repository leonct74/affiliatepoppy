// Calls to our own backend, proxied by the host (capability: backend:invoke). The frontend
// has no AWS SDK, no Stripe key, no Node and no network of its own — everything privileged
// goes through the bridge.

import { friendlyBackendError } from "./errors";
import { host, type BackendInvoke } from "./host";
import type {
  Partner,
  PartnerTotal,
  SyncReport,
  Affiliate,
  DeploymentStatus,
  LedgerEntry,
  Meta,
  Payout,
  PortalBranding,
  ProgramConfig,
  ProgramSettings,
  SecretStatus,
} from "./types";

/** Every backend call goes through here so a failure reads as the backend's own sentence,
 *  never the bridge's `backend 500: {json}` wire format (errors.ts). */
function invoke<T>(request: BackendInvoke, timeoutMs?: number): Promise<T> {
  return host.invokeBackend<T>(request, timeoutMs).catch((e) => {
    throw friendlyBackendError(e);
  });
}

export const api = {
  meta: (): Promise<Meta> => invoke({ method: "GET", path: "/meta" }),

  /** The live deployment state, read from CloudFormation on every call. */
  status: (): Promise<DeploymentStatus> => invoke({ method: "GET", path: "/status" }),

  /** Kicks off the deploy; AWS carries on with it in the background. */
  deploy: (): Promise<{ operation: string; stackName: string }> =>
    invoke({ method: "POST", path: "/deploy" }),

  /** Removes everything AffiliatePoppy created. Waits for AWS to finish. `external` reports
   *  the world outside AWS: the public page closing and the Stripe destinations' removal. */
  teardown: (): Promise<{ ok: true; removed: string[]; external?: string[] }> =>
    invoke({ method: "POST", path: "/teardown" }, 15 * 60_000),

  config: (): Promise<ProgramConfig> => invoke({ method: "GET", path: "/config" }),

  saveConfig: (body: {
    settings?: ProgramSettings;
    branding?: PortalBranding;
  }): Promise<{ settings: ProgramSettings; branding: PortalBranding; couponChanged: boolean }> =>
    invoke({ method: "PUT", path: "/config", body }),

  /**
   * Store one Stripe secret. It goes into the merchant's own parameter store and never comes
   * back — the reply says only that it was saved, plus the last four characters.
   */
  saveSecret: (
    which: "webhookSecret" | "apiKey" | "connectSecret",
    value: string,
  ): Promise<SecretStatus & { connection?: { ok: boolean; livemode: boolean; message?: string } }> =>
    invoke({ method: "PUT", path: `/secrets/${which}`, body: { value } }, 60_000),

  checkStripe: (): Promise<{ ok: boolean; livemode: boolean; couponId: string; message?: string }> =>
    invoke({ method: "POST", path: "/stripe/check" }, 60_000),

  affiliates: (): Promise<{ affiliates: Affiliate[] }> => invoke({ method: "GET", path: "/affiliates" }),

  approve: (affId: string, code?: string): Promise<{ affiliate: Affiliate }> =>
    invoke({ method: "POST", path: `/affiliates/${encodeURIComponent(affId)}/approve`, body: { code } }, 60_000),

  retire: (affId: string): Promise<{ affiliate: Affiliate }> =>
    invoke({ method: "POST", path: `/affiliates/${encodeURIComponent(affId)}/retire` }, 60_000),

  /** Set (or clear, with null) one affiliate's own commission rate. */
  setRate: (affId: string, pct: number | null): Promise<{ affiliate: Affiliate }> =>
    invoke({ method: "PUT", path: `/affiliates/${encodeURIComponent(affId)}/rate`, body: { pct } }),

  ledger: (affId: string): Promise<{ entries: LedgerEntry[] }> =>
    invoke({ method: "GET", path: `/affiliates/${encodeURIComponent(affId)}/ledger` }),

  payouts: (): Promise<{ payouts: Payout[] }> => invoke({ method: "GET", path: "/payouts" }),

  /** Record a payout the merchant has already made by hand (we never move money). */
  markPaid: (body: {
    affId: string;
    currency: string;
    amountCents: number;
    batchId: string;
    note?: string;
  }): Promise<{ recorded: boolean }> => invoke({ method: "POST", path: "/payouts", body }),

  /** The CSV — written by the BACKEND, because a sandboxed frontend cannot download a file. */
  /** Builds the CSVs and returns one-shot tokens; see download.ts for how they become files. */
  exportCsv: (): Promise<{ rows: number; files: { token: string; filename: string }[] }> =>
    invoke({ method: "POST", path: "/export" }, 5 * 60_000),

  /** P10: claim a name on affiliates.agentspoppy.com — Pro only; the backend enforces too. */
  publishPortal: (slug: string): Promise<{ slug: string; url: string }> =>
    invoke({ method: "POST", path: "/portal/publish", body: { slug } }, 60_000),

  /** Change the published address — refused once publishers exist; the old one redirects. */
  renamePortal: (slug: string): Promise<{ slug: string; url: string }> =>
    invoke({ method: "POST", path: "/portal/rename", body: { slug } }, 60_000),

  /** Q3: hand the platform the ledger-feed webhook's signing secret (pass-through). */
  portalFeedSecret: (secret: string): Promise<{ day: string }> =>
    invoke({ method: "POST", path: "/portal/feed-secret", body: { secret } }, 60_000),

  /** D20: create the Stripe webhook destinations with the merchant's own key — no forms. */
  autoWebhooks: (): Promise<{ created: string[]; skipped: string[]; problems: string[] }> =>
    invoke({ method: "POST", path: "/webhooks/auto" }, 2 * 60_000),

  /** Fresh signing secrets for the app-created destinations (hygiene, or repair after a
   *  secret was rolled in Stripe's dashboard). */
  rotateWebhooks: (): Promise<{ created: string[]; skipped: string[]; problems: string[] }> =>
    invoke({ method: "POST", path: "/webhooks/rotate" }, 2 * 60_000),

  /** Persist what the commerce plane said about Pro, so the portal Lambda knows (D19c). */
  setPlan: (pro: boolean): Promise<{ pro: boolean }> =>
    invoke({ method: "PUT", path: "/plan", body: { pro } }),

  // ── P7: developers selling through the merchant's Stripe platform ───────────────────
  partners: (): Promise<{ partners: Partner[]; totals: PartnerTotal[] }> =>
    invoke({ method: "GET", path: "/partners" }),
  addPartner: (account: string, label: string): Promise<{ partners: Partner[]; sync: SyncReport }> =>
    invoke({ method: "POST", path: "/partners", body: { account, label } }, 5 * 60_000),
  removePartner: (account: string): Promise<{ partners: Partner[] }> =>
    invoke({ method: "DELETE", path: `/partners/${encodeURIComponent(account)}` }, 5 * 60_000),
  syncCodes: (): Promise<SyncReport> => invoke({ method: "POST", path: "/partners/sync" }, 5 * 60_000),
};
