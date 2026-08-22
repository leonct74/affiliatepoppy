// Publishing the programme to the platform portal — P10-Q1, the poppy's half of D19b.
//
// "Publishing" means: claim a name on affiliates.agentspoppy.com, and keep the public page
// there fed with the CURRENT branding and deal. The platform hands back a per-merchant token
// exactly once; it goes into the merchant's own SSM next to the Stripe secrets, and every
// later update presents it. Nothing else leaves the merchant's AWS in Q1 — publishers,
// codes and the ledger stay here until the later phases move the publisher-facing view.
//
// Open to every plan since D20 (2026-08-22): the free page carries the AffiliatePoppy Free
// notice — the banner is the conversion engine, so free publishing is what SELLS Pro. The
// plan rides on every register/update so the platform knows which face to render.

export interface PortalPublishDeps {
  planPro(): Promise<boolean>;
  config(): Promise<{
    settings: { discountPct: number; commissionPct: number; firstPaymentOnly: boolean; autoApprove: boolean };
    branding: { merchantName: string; accentColor: string; logoDataUri: string; offerCopy: string; termsText: string };
  }>;
  portalSlug(): Promise<string>;
  savePortalSlug(slug: string): Promise<void>;
  saveToken(token: string): Promise<void>;
  readToken(): Promise<string>;
  fetchImpl?: typeof fetch;
}

/** Overridable for tests and for a future self-hosted portal; the default is the platform. */
export const PORTAL_BASE = process.env.AFFILIATEPOPPY_PORTAL_BASE?.trim() || "https://agentspoppy.com";

function payload(cfg: Awaited<ReturnType<PortalPublishDeps["config"]>>, pro: boolean): Record<string, unknown> {
  return {
    branding: cfg.branding,
    deal: {
      discountPct: cfg.settings.discountPct,
      commissionPct: cfg.settings.commissionPct,
      firstPaymentOnly: cfg.settings.firstPaymentOnly,
      autoApprove: cfg.settings.autoApprove,
    },
    // D20: every plan publishes; the platform renders the free-plan notice from this.
    plan: pro ? "pro" : "free",
  };
}

export async function publishPortal(deps: PortalPublishDeps, rawSlug: string): Promise<{ slug: string; url: string }> {
  const slug = rawSlug.trim().toLowerCase();
  if (!slug) throw new Error("Pick a name for your portal address first.");
  const cfg = await deps.config();
  if (!cfg.branding.merchantName) throw new Error("Fill in your name in Settings first — the page is built around it.");

  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${PORTAL_BASE}/api/portal/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, ...payload(cfg, await deps.planPro()) }),
    });
  } catch (e) {
    throw new Error(`Couldn't reach agentspoppy.com (${(e as Error).message}). Nothing was published — try again.`);
  }
  const body = (await res.json().catch(() => ({}))) as { token?: string; url?: string; error?: string };
  if (res.status === 409) throw new Error(`"${slug}" is already taken — pick another name.`);
  if (res.status === 422) throw new Error("That name can't be used: lowercase letters, digits and hyphens, 3–30 characters.");
  if (!res.ok || !body.token) throw new Error("The portal service refused the request — try again in a moment.");

  // Token FIRST, slug second: a saved slug with no token would leave updates impossible,
  // while a saved token with no slug is merely unused.
  await deps.saveToken(body.token);
  await deps.savePortalSlug(slug);
  return { slug, url: body.url ?? `https://affiliates.agentspoppy.com/${slug}` };
}

/**
 * Q3: hand the platform the signing secret for THIS programme's ledger feed — the extra
 * webhook endpoint the merchant created in their own Stripe, pointing at the platform.
 * Pass-through only: the secret is never stored in the merchant's AWS and never echoed
 * back; the platform holds it to verify the events that feed the publishers' independent
 * ledger (D19b's guarantee).
 */
export async function sendPortalWebhookSecret(deps: PortalPublishDeps, rawSecret: string): Promise<void> {
  const secret = rawSecret.trim();
  if (!/^whsec_[A-Za-z0-9]{8,128}$/.test(secret)) {
    throw new Error('That doesn\'t look like a Stripe signing secret — it starts with "whsec_". Copy it from the webhook destination you just created.');
  }
  const slug = await deps.portalSlug();
  if (!slug) throw new Error("Publish your portal first — the feed belongs to your permanent address.");
  const token = await deps.readToken();
  if (!token) throw new Error("This install has no portal token. Publish your portal again and retry.");

  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${PORTAL_BASE}/api/portal/merchant`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, token, webhookSecret: secret }),
    });
  } catch (e) {
    throw new Error(`Couldn't reach agentspoppy.com (${(e as Error).message}). Nothing changed — try again.`);
  }
  if (res.status === 422) throw new Error("The platform refused that secret — copy the whole whsec_… value and try again.");
  if (res.status === 403) throw new Error("The platform didn't recognise this programme's token — if you rebuilt your storage, publish the portal again first.");
  if (!res.ok) throw new Error("The portal service refused the request — try again in a moment.");
}

/**
 * Push the current branding/deal to the published page. Called after every Settings save;
 * best-effort BY DESIGN — a platform hiccup must never fail the merchant's own save. The
 * next save (or publish) tries again.
 */
export async function pushPortalUpdate(deps: PortalPublishDeps): Promise<boolean> {
  const slug = await deps.portalSlug();
  if (!slug) return false;
  const token = await deps.readToken();
  if (!token) return false;
  try {
    const doFetch = deps.fetchImpl ?? fetch;
    const res = await doFetch(`${PORTAL_BASE}/api/portal/merchant`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, token, ...payload(await deps.config(), await deps.planPro()) }),
    });
    if (!res.ok) console.warn(`[affiliatepoppy] portal update refused (${res.status}) for ${slug}`);
    return res.ok;
  } catch (e) {
    console.warn("[affiliatepoppy] portal update failed:", (e as Error).message);
    return false;
  }
}
