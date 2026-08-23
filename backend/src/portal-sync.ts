// The Q4 minting handshake, poppy side: the platform queues sign-ups from the published
// portal; THIS process polls for them, imports them as ordinary affiliates, mints codes
// with the merchant's own key through the existing approve path, and writes the result
// back. The Stripe key never leaves the merchant's AWS — which is exactly why this is a
// poll and not a platform-initiated push (DESIGN.md P10-Q4, decided).
//
// Everything here is best-effort and quiet: the loop runs every minute for the lifetime of
// the app, and a platform hiccup must cost nothing but a one-line warn. What must NOT be
// quiet is a mint failure — that is a publisher stuck on "being prepared", so it is
// collected and surfaced in the sync report.

import { sanitizeChannels } from "../../shared/src/ledger";
import type { AffiliateProfile } from "../../shared/src/ledger";
import { PORTAL_BASE } from "./portal-publish";

export const PLATFORM_AFF_PREFIX = "pp_";

/** The platform uid behind an imported affiliate, or "" for the poppy's own sign-ups. */
export function platformUid(affId: string): string {
  return affId.startsWith(PLATFORM_AFF_PREFIX) ? affId.slice(PLATFORM_AFF_PREFIX.length) : "";
}

/** What the platform needs to know once a code exists (or a rate/status changed). */
export function activePatch(profile: AffiliateProfile): Record<string, unknown> {
  return {
    status: "active",
    code: profile.code,
    promotionCodeId: profile.promotionCodeId,
    promotionCodeIdList: Object.values(profile.promotionCodeIds ?? {}),
    pctOverride: typeof profile.pctOverride === "number" ? profile.pctOverride : null,
  };
}

export interface PortalPatchDeps {
  portalSlug(): Promise<string>;
  readToken(): Promise<string>;
  fetchImpl?: typeof fetch;
}

/** Write one publisher's state back to the platform. Best-effort by design — never throws;
 *  the next sync pass reconciles anything that was missed. */
export async function postPublisherPatch(
  deps: PortalPatchDeps,
  uid: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  try {
    const [slug, token] = await Promise.all([deps.portalSlug(), deps.readToken()]);
    if (!slug || !token) return false;
    const doFetch = deps.fetchImpl ?? fetch;
    const res = await doFetch(`${PORTAL_BASE}/api/portal/publisher`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, token, uid, ...patch }),
    });
    if (!res.ok) console.warn(`[affiliatepoppy] publisher write-back refused (${res.status}) for ${uid}`);
    return res.ok;
  } catch (e) {
    console.warn("[affiliatepoppy] publisher write-back failed:", (e as Error).message);
    return false;
  }
}

export interface PortalSyncDeps extends PortalPatchDeps {
  settings(): Promise<{ autoApprove: boolean; maxAffiliates: number }>;
  affiliate(affId: string): Promise<AffiliateProfile | undefined>;
  countAffiliates(): Promise<number>;
  createAffiliate(profile: AffiliateProfile): Promise<void>;
  /** Backfill on an already-imported affiliate — today only what they said at sign-up, which
   *  older rows were imported without. */
  updateAffiliate(affId: string, patch: { channels: string }): Promise<void>;
  /** The poppy's own approve path — issues the code, mints on partners, posts back. */
  approve(affId: string): Promise<AffiliateProfile>;
  today(): string;
}

export interface SyncReport {
  checked: number;
  imported: number;
  minted: number;
  /** Sign-ups left waiting because the merchant's affiliate cap is reached. */
  skippedFull: number;
  errors: string[];
}

/**
 * One pass of the handshake. Returns null when this install isn't published (nothing to do)
 * or the platform can't be reached (the next minute's pass will try again).
 */
export async function syncPlatformSignups(deps: PortalSyncDeps): Promise<SyncReport | null> {
  const [slug, token] = await Promise.all([deps.portalSlug(), deps.readToken()]);
  if (!slug || !token) return null;

  let signups: Array<{ uid: string; email: string; name: string; status: string; channels?: string }>;
  try {
    const doFetch = deps.fetchImpl ?? fetch;
    const res = await doFetch(`${PORTAL_BASE}/api/portal/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, token }),
    });
    if (!res.ok) {
      console.warn(`[affiliatepoppy] portal poll refused (${res.status})`);
      return null;
    }
    signups = ((await res.json()) as { signups?: typeof signups }).signups ?? [];
  } catch (e) {
    console.warn("[affiliatepoppy] portal poll failed:", (e as Error).message);
    return null;
  }

  const settings = await deps.settings();
  const report: SyncReport = { checked: signups.length, imported: 0, minted: 0, skippedFull: 0, errors: [] };

  for (const s of signups) {
    if (!s.uid) continue;
    const affId = PLATFORM_AFF_PREFIX + s.uid;
    let profile = await deps.affiliate(affId);

    if (!profile) {
      // The same cap the poppy's own sign-up page enforces — it is the merchant's protection
      // against a flood minting codes and running up their bill (D8).
      if ((await deps.countAffiliates()) >= settings.maxAffiliates) {
        report.skippedFull++;
        continue;
      }
      await deps.createAffiliate({
        affId,
        email: s.email,
        displayName: s.name || s.email.split("@")[0] || "publisher",
        ...(s.channels ? { channels: sanitizeChannels(s.channels) } : {}),
        status: "pending",
        code: "",
        promotionCodeId: "",
        createdDay: deps.today(),
        placements: [],
      });
      report.imported++;
      profile = await deps.affiliate(affId);
      if (!profile) continue;
    }

    // Whatever they told us at sign-up arrives with every poll, so a row imported before the
    // question existed picks it up on the next pass rather than staying blank forever.
    const channels = sanitizeChannels(s.channels);
    if (channels && channels !== (profile.channels ?? "")) {
      await deps.updateAffiliate(affId, { channels });
      profile = { ...profile, channels };
    }

    // Turned down here. Say so to the platform (in case an earlier write-back was missed) and
    // never mint — not even under auto-approve, which would otherwise undo the merchant's
    // decision the minute after they made it.
    if (profile.status === "declined") {
      await postPublisherPatch(deps, s.uid, { status: "declined" });
      continue;
    }

    // Already minted here but the platform still lists them — an earlier write-back was
    // missed. Reconcile instead of re-minting.
    if (profile.code) {
      await postPublisherPatch(deps, s.uid, activePatch(profile));
      continue;
    }
    if (profile.status === "retired") {
      await postPublisherPatch(deps, s.uid, { status: "retired" });
      continue;
    }

    // Mint when either side has said yes: the programme auto-approves, the platform recorded
    // the join as approved, or the merchant already approved this person here by hand.
    const mayMint = settings.autoApprove || s.status === "approved" || profile.status === "active";
    if (!mayMint) continue;
    try {
      await deps.approve(affId); // approve() posts the active patch back itself
      report.minted++;
    } catch (e) {
      report.errors.push(`${profile.displayName || s.email}: ${(e as Error).message}`);
    }
  }
  return report;
}
