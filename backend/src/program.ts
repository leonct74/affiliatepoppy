// The merchant's side of the programme: connecting Stripe, setting the economics, approving
// and retiring affiliates, reading the ledger, and recording what they have paid.
//
// Everything here runs in the SIDECAR (the merchant's own machine, using their brokered AWS
// credentials) rather than in a Lambda, because it is admin work: it happens when a person
// clicks something, not when Stripe calls. That also keeps the Stripe API key out of the hot
// webhook path — the receiver Lambda cannot read it at all.

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { issueCodeFor, mintOnPartners, type MintOnPartnersResult } from "../../shared/src/issue";
import { isAccountId, type Partner } from "../../shared/src/partners";
import type { AffiliateProfile, Payout, Totals } from "../../shared/src/ledger";
import { DynamoLedger } from "../../shared/src/ledger-store";
import { owedCents } from "../../shared/src/money";
import {
  defaultOfferCopy,
  sanitizeBranding,
  sanitizeSettings,
  type PortalBranding,
  type ProgramSettings,
} from "../../shared/src/settings";
import { StripeClient, permissionProblem } from "../../shared/src/stripe-api";
import { dayOf } from "../../shared/src/stripe-events";
import { PORTAL_BASE, publishPortal, pushPortalUpdate, sendPortalWebhookSecret, type PortalPublishDeps } from "./portal-publish";
import { activePatch, platformUid, postPublisherPatch, syncPlatformSignups, type SyncReport as PortalSyncReport } from "./portal-sync";
import { putSecret, readSecret } from "./secrets";
import type { AttributionContext } from "./tags";

/** What syncCodes() did, and what it couldn't — shown to the merchant, never swallowed. */
export interface SyncReport {
  minted: number;
  failures: (MintOnPartnersResult["failures"][number] & { affiliate: string })[];
}

/** One affiliate, as the poppy's Affiliates and Ledger tabs show them. */
export interface AffiliateView extends AffiliateProfile {
  totals: (Totals & { owedCents: number })[];
}

export class Program {
  private readonly ledger: DynamoLedger;

  constructor(
    db: DynamoDBClient,
    tableName: string,
    private readonly ssm: SSMClient,
    private readonly attribution?: AttributionContext,
  ) {
    this.ledger = new DynamoLedger(db, tableName);
  }

  /** The publish/update flows' view of this install (portal-publish.ts). */
  private portalDeps(): PortalPublishDeps {
    return {
      planPro: () => this.ledger.planPro(),
      config: () => this.ledger.config(),
      portalSlug: () => this.ledger.portalSlug(),
      savePortalSlug: (slug) => this.ledger.savePortalSlug(slug),
      saveToken: async (token) => {
        await putSecret(this.ssm, "portalToken", token, this.attribution ?? { accountId: "", connectionId: "" });
      },
      readToken: () => readSecret(this.ssm, "portalToken"),
    };
  }

  /** P10: claim a name on affiliates.agentspoppy.com and start feeding the page. */
  async publishPortal(slug: string): Promise<{ slug: string; url: string }> {
    return publishPortal(this.portalDeps(), slug);
  }

  /** Q3: hand the platform the signing secret of the merchant's ledger-feed webhook.
   *  Pass-through — validated, delivered, and only a day-stamp kept here. */
  async portalFeedSecret(secret: string): Promise<{ day: string }> {
    await sendPortalWebhookSecret(this.portalDeps(), secret);
    const day = dayOf(Math.floor(Date.now() / 1000));
    await this.ledger.savePortalFeedDay(day);
    return { day };
  }

  /** Q4: tell the platform what happened to one of ITS publishers (mint, rate, retirement).
   *  Best-effort — the poll loop reconciles anything missed. */
  private async postPlatformPatch(affId: string, patch: Record<string, unknown>): Promise<void> {
    const uid = platformUid(affId);
    if (!uid) return; // an ordinary Lambda-portal affiliate — nothing to sync
    await postPublisherPatch(this.portalDeps(), uid, patch);
  }

  /** Q4: one pass of the minting handshake — poll the platform for sign-ups, import them,
   *  mint where allowed, write results back. Called by the server's minute loop. */
  async syncPlatformPortal(): Promise<PortalSyncReport | null> {
    const base = this.portalDeps();
    return syncPlatformSignups({
      portalSlug: base.portalSlug,
      readToken: base.readToken,
      settings: async () => {
        const { settings } = await this.ledger.config();
        return { autoApprove: settings.autoApprove, maxAffiliates: settings.maxAffiliates };
      },
      affiliate: (affId) => this.ledger.affiliate(affId),
      countAffiliates: async () => (await this.ledger.listAffiliates()).length,
      createAffiliate: (profile) => this.ledger.createAffiliate(profile),
      approve: (affId) => this.approve(affId),
      today: () => dayOf(Math.floor(Date.now() / 1000)),
    });
  }

  /** A Stripe client using the merchant's stored key, or null when they haven't connected. */
  private async stripe(): Promise<StripeClient | null> {
    const apiKey = await readSecret(this.ssm, "apiKey");
    return apiKey ? new StripeClient({ apiKey }) : null;
  }

  async config(): Promise<{
    settings: ProgramSettings;
    branding: PortalBranding;
    stripe: { couponId: string; lastEventAt: number; livemode: boolean; partners: Partner[] };
    /** The offer as affiliates will actually read it — generated when the merchant left it blank. */
    offer: string;
    /** D19c: the paid plan. Free = personalisation locked, portal carries the free-plan notice. */
    plan: { pro: boolean };
    /** P10: the platform portal, when published; feed* is the Q3 Stripe-fed ledger state. */
    portal: { slug: string; url: string; feedUrl: string; feedDay: string };
  }> {
    const [{ settings, branding }, stripe, pro, slug, feedDay] = await Promise.all([
      this.ledger.config(),
      this.ledger.stripeState(),
      this.ledger.planPro(),
      this.ledger.portalSlug(),
      this.ledger.portalFeedDay(),
    ]);
    return {
      settings,
      branding,
      stripe,
      offer: branding.offerCopy || defaultOfferCopy(settings),
      plan: { pro },
      portal: {
        slug,
        url: slug ? `https://affiliates.agentspoppy.com/${slug}` : "",
        feedUrl: slug ? `${PORTAL_BASE}/api/portal/stripe/${slug}` : "",
        feedDay,
      },
    };
  }

  /** Persist what the commerce plane said about the Pro purchase (the UI checks, we remember —
   *  the portal Lambda has no way to ask the store, so this row is how it knows). */
  async setPlan(pro: boolean): Promise<{ pro: boolean }> {
    await this.ledger.savePlan(pro);
    // D20: the published page's banner follows the plan — flip it now, not at the next save.
    // Best-effort like every push; the next save reconciles a miss.
    await pushPortalUpdate(this.portalDeps());
    return { pro };
  }

  /**
   * Save the programme's economics and branding.
   *
   * Changing the DISCOUNT creates a NEW Stripe coupon rather than editing the old one, because
   * Stripe coupons are immutable — and that is honest anyway: codes already in the wild keep
   * the deal they were given, which is what the merchant promised the people holding them. The
   * UI says so in as many words.
   */
  async saveConfig(input: { settings?: unknown; branding?: unknown }): Promise<{
    settings: ProgramSettings;
    branding: PortalBranding;
    couponChanged: boolean;
  }> {
    const current = await this.ledger.config();
    const settings = sanitizeSettings(input.settings ?? current.settings);
    let branding = sanitizeBranding(input.branding ?? current.branding);
    // D19c: personalisation is the paid half. On the free plan the merchant's NAME still saves
    // (a portal reading "Your name here" would punish the publisher, not the merchant) — the
    // rest of the look stays at its current values whatever the client sent. UI says why.
    if (!(await this.ledger.planPro())) {
      branding = { ...current.branding, merchantName: branding.merchantName };
    }
    await this.ledger.saveConfig(settings, branding);

    let couponChanged = false;
    const stripe = await this.stripe();
    const state = await this.ledger.stripeState();
    if (stripe && settings.discountPct !== (await this.couponPct(state.couponId, stripe))) {
      const coupon = await stripe.createCoupon(
        settings.discountPct,
        `${branding.merchantName || "Affiliate"} ${settings.discountPct}% off`,
      );
      await this.ledger.saveCoupon(coupon.id, settings.discountPct);
      couponChanged = true;
    }
    // P7: the coupon on each developer's account must give the same discount — a changed
    // discount means a new coupon THERE too, and every code re-minted against it.
    if (stripe && state.partners.length) await this.ensurePartnerCoupons(stripe, settings, branding, state.partners);
    // P10: keep the published page current. Best-effort — the merchant's save already succeeded.
    await pushPortalUpdate(this.portalDeps());
    return { settings, branding, couponChanged };
  }

  // ── P7: participating developers (connected accounts) ────────────────────────────────

  /**
   * Make sure each partner has a coupon at the CURRENT discount on their own account. A
   * partner whose coupon is missing or stale gets a new one; the codes are minted against it
   * by syncCodes(). Failures are recorded on the partner (couponId "") rather than thrown, so
   * one developer's problem never blocks saving the merchant's settings.
   */
  private async ensurePartnerCoupons(
    stripe: StripeClient,
    settings: ProgramSettings,
    branding: PortalBranding,
    partners: Partner[],
  ): Promise<{ partners: Partner[]; errors: Map<string, string> }> {
    const next: Partner[] = [];
    // Stripe's own words, per account — the live lesson here is that swallowing these cost a
    // debugging round-trip: the founder saw our guess instead of Stripe's actual refusal.
    const errors = new Map<string, string>();
    for (const partner of partners) {
      if (partner.couponId && partner.couponPct === settings.discountPct) {
        next.push(partner);
        continue;
      }
      try {
        const coupon = await stripe
          .forAccount(partner.account)
          .createCoupon(settings.discountPct, `${branding.merchantName || "Affiliate"} ${settings.discountPct}% off`);
        next.push({ ...partner, couponId: coupon.id, couponPct: settings.discountPct });
      } catch (e) {
        errors.set(partner.account, (e as Error).message);
        next.push({ ...partner, couponId: "", couponPct: Number.NaN });
      }
    }
    await this.ledger.savePartners(next);
    return { partners: next, errors };
  }

  async partners(): Promise<Partner[]> {
    return (await this.ledger.stripeState()).partners;
  }

  /** Add a developer's connected account: create the coupon there, then mint every active code. */
  async addPartner(account: string, label: string): Promise<{ partners: Partner[]; sync: SyncReport }> {
    const clean = account.trim();
    if (!isAccountId(clean)) throw new Error("That doesn't look like a Stripe account id — it starts with acct_ and is in Stripe → Connect → Accounts.");
    const state = await this.ledger.stripeState();
    if (state.partners.some((p) => p.account === clean)) throw new Error("That developer is already in your programme.");
    const stripe = await this.stripe();
    if (!stripe) throw new Error("Connect your Stripe account first.");
    const { settings, branding } = await this.ledger.config();
    const { partners, errors } = await this.ensurePartnerCoupons(stripe, settings, branding, [
      ...state.partners,
      { account: clean, label: label.trim().slice(0, 60), couponId: "", couponPct: Number.NaN },
    ]);
    const added = partners.find((p) => p.account === clean)!;
    if (!added.couponId) {
      // The coupon is the first thing that needs the key to act on that account. If it can't,
      // say so now — in STRIPE's words — and leave the developer out of the list.
      await this.ledger.savePartners(partners.filter((p) => p.account !== clean));
      const reason = errors.get(clean) ?? "Stripe refused without a reason.";
      throw new Error(
        `Stripe wouldn't act on ${clean}: "${reason}" — usually the key: a restricted key has a SEPARATE ` +
          `Connected-accounts permission column, and "Promotion codes: Write" must be set THERE too.`,
      );
    }
    return { partners, sync: await this.syncCodes() };
  }

  /** Remove a developer: codes minted there are retired; the ledger keeps what they owe. */
  async removePartner(account: string): Promise<Partner[]> {
    const state = await this.ledger.stripeState();
    const stripe = await this.stripe();
    if (stripe) {
      for (const profile of await this.ledger.listAffiliates()) {
        const id = profile.promotionCodeIds?.[account];
        if (!id) continue;
        try {
          await stripe.forAccount(account).deactivatePromotionCode(id);
        } catch {
          /* the account may already have cut us off — the list entry goes either way */
        }
        const { [account]: _gone, ...rest } = profile.promotionCodeIds ?? {};
        await this.ledger.updateAffiliate(profile.affId, { promotionCodeIds: rest });
      }
    }
    const partners = state.partners.filter((p) => p.account !== account);
    await this.ledger.savePartners(partners);
    return partners;
  }

  /**
   * Mint every active affiliate's code on every partner account where it is missing. Safe to
   * run any time; it does nothing when there is nothing to do. This is also the recovery path
   * for any partner minting that failed at approval or enrolment.
   */
  async syncCodes(): Promise<SyncReport> {
    const stripe = await this.stripe();
    const { partners } = await this.ledger.stripeState();
    const report: SyncReport = { minted: 0, failures: [] };
    if (!stripe || !partners.length) return report;
    for (const profile of await this.ledger.listAffiliates()) {
      if (profile.status !== "active" || !profile.code) continue;
      const before = Object.keys(profile.promotionCodeIds ?? {}).length;
      const result = await mintOnPartners({
        affId: profile.affId,
        code: profile.code,
        partners,
        already: profile.promotionCodeIds ?? {},
        stripe,
        registry: this.ledger,
      });
      report.minted += Object.keys(result.promotionCodeIds).length - before;
      for (const f of result.failures) report.failures.push({ ...f, affiliate: profile.displayName });
    }
    return report;
  }

  /** P7 / D15b: per developer, what the merchant has advanced on their sales — what they owe back. */
  async partnerTotals(): Promise<{ account: string; label: string; currency: string; advancedCents: number }[]> {
    const [{ partners }, totals] = await Promise.all([this.ledger.stripeState(), this.ledger.partnerTotals()]);
    const label = new Map(partners.map((p) => [p.account, p.label]));
    return totals.map((t) => ({
      account: t.account,
      label: label.get(t.account) ?? "",
      currency: t.currency,
      advancedCents: t.earnedCents - t.refundedCents,
    }));
  }

  /** The discount the live coupon actually gives, or NaN when there isn't one yet. */
  private async couponPct(couponId: string, stripe: StripeClient): Promise<number> {
    if (!couponId) return Number.NaN;
    try {
      const coupon = await stripe.getCoupon(couponId);
      return typeof coupon.percent_off === "number" ? coupon.percent_off : Number.NaN;
    } catch {
      // A coupon deleted in the Stripe dashboard: treat it as absent so the next save
      // recreates one, rather than leaving the programme unable to issue codes.
      return Number.NaN;
    }
  }

  /**
   * Check the stored key works and make sure the programme's coupon exists. Called after the
   * merchant pastes their secrets, so a wrong key is caught THERE — not later, invisibly, when
   * an affiliate's code fails to issue.
   */
  async connectStripe(): Promise<{ ok: boolean; livemode: boolean; couponId: string; message?: string }> {
    const stripe = await this.stripe();
    if (!stripe) return { ok: false, livemode: false, couponId: "", message: "No Stripe key saved yet." };
    let livemode = false;
    try {
      ({ livemode } = await stripe.check());
    } catch (e) {
      return { ok: false, livemode: false, couponId: "", message: permissionProblem(e) ?? (e as Error).message };
    }
    // The coupon create is the REAL proof the key can do its one job: it needs exactly the
    // "Promotion codes: Write" scope. A key that passes the read above but fails here is the
    // wrong key, and the merchant is told so in words — never "ok".
    try {
      const { settings, branding } = await this.ledger.config();
      const state = await this.ledger.stripeState();
      let couponId = state.couponId;
      if (Number.isNaN(await this.couponPct(couponId, stripe))) {
        const coupon = await stripe.createCoupon(
          settings.discountPct,
          `${branding.merchantName || "Affiliate"} ${settings.discountPct}% off`,
        );
        couponId = coupon.id;
        await this.ledger.saveCoupon(couponId, settings.discountPct);
      }
      return { ok: true, livemode, couponId };
    } catch (e) {
      return { ok: false, livemode, couponId: "", message: permissionProblem(e) ?? (e as Error).message };
    }
  }

  /** Every affiliate with their totals — one Query for the directory, one for all totals. */
  async affiliates(): Promise<AffiliateView[]> {
    const [profiles, totals] = await Promise.all([this.ledger.listAffiliates(), this.ledger.allTotals()]);
    return profiles.map((profile) => ({
      ...profile,
      totals: totals
        .filter((t) => t.affId === profile.affId)
        .map((t) => ({
          currency: t.currency,
          earnedCents: t.earnedCents,
          refundedCents: t.refundedCents,
          paidCents: t.paidCents,
          owedCents: owedCents(t),
        })),
    }));
  }

  /** Approve someone who signed up while the programme was on manual approval (D8). */
  async approve(affId: string, preferredCode?: string): Promise<AffiliateProfile> {
    const profile = await this.ledger.affiliate(affId);
    if (!profile) throw new Error("That affiliate isn't in your programme.");
    if (profile.code) return profile; // already has a code — approving again changes nothing

    const stripe = await this.stripe();
    if (!stripe) throw new Error("Connect your Stripe account first — a code can't be created without it.");
    const { couponId } = await this.ledger.stripeState();
    const { code } = await issueCodeFor({
      affId,
      displayName: profile.displayName,
      couponId,
      issuer: stripe,
      registry: this.ledger,
      ...(preferredCode ? { preferred: preferredCode } : {}),
    });
    // P7: the same code on every participating developer's account. A developer-side failure
    // is reported through syncCodes() — the affiliate's own code is already working.
    const { partners } = await this.ledger.stripeState();
    if (partners.length) await mintOnPartners({ affId, code, partners, already: {}, stripe, registry: this.ledger });
    const approved = (await this.ledger.affiliate(affId))!;
    // Q4: a publisher from the published portal sees their code the moment it exists.
    await this.postPlatformPatch(affId, activePatch(approved));
    return approved;
  }

  /**
   * Retire an affiliate's code: it stops working at checkout, and the ledger it has already
   * earned is kept in full. (Their money doesn't disappear because the partnership ended.)
   */
  async retire(affId: string): Promise<AffiliateProfile> {
    const profile = await this.ledger.affiliate(affId);
    if (!profile) throw new Error("That affiliate isn't in your programme.");
    const stripe = await this.stripe();
    if (stripe && profile.promotionCodeId) {
      try {
        await stripe.deactivatePromotionCode(profile.promotionCodeId);
      } catch (e) {
        // A code already deleted in the Stripe dashboard is fine — the outcome is what we want.
        if (!/No such promotion code/i.test((e as Error).message)) throw e;
      }
    }
    // P7: and everywhere else it was minted.
    if (stripe) {
      for (const [account, id] of Object.entries(profile.promotionCodeIds ?? {})) {
        try {
          await stripe.forAccount(account).deactivatePromotionCode(id);
        } catch (e) {
          if (!/No such promotion code/i.test((e as Error).message)) throw e;
        }
      }
    }
    await this.ledger.updateAffiliate(affId, { status: "retired" });
    // Q4: the publisher's page says "ended" honestly rather than showing a dead code.
    await this.postPlatformPatch(affId, { status: "retired" });
    return (await this.ledger.affiliate(affId))!;
  }

  /** Set (or clear, with null) one affiliate's own commission rate — D9. */
  async setRate(affId: string, pct: number | null): Promise<AffiliateProfile> {
    const clean =
      pct === null ? null : sanitizeSettings({ commissionPct: pct, discountPct: 0 }).commissionPct;
    await this.ledger.updateAffiliate(affId, { pctOverride: clean as number | undefined });
    const profile = await this.ledger.affiliate(affId);
    if (!profile) throw new Error("That affiliate isn't in your programme.");
    // Q4: the platform ledger computes with the same rate, or the witness would drift.
    await this.postPlatformPatch(affId, { pctOverride: clean });
    return profile;
  }

  async ledgerFor(affId: string) {
    return this.ledger.ledgerFor(affId);
  }

  async payouts(): Promise<Payout[]> {
    return this.ledger.listPayouts();
  }

  /**
   * Record a payout the merchant has ALREADY made by hand (D12: we compute and report, we
   * never move money). The amount must match what is owed — a payout that silently disagrees
   * with the ledger is how an affiliate ends up with a balance nobody can explain.
   */
  async markPaid(input: {
    affId: string;
    currency: string;
    amountCents: number;
    batchId: string;
    note?: string;
    day: string;
  }): Promise<{ recorded: boolean }> {
    const totals = await this.ledger.totalsFor(input.affId);
    const forCurrency = totals.find((t) => t.currency === input.currency.toLowerCase());
    if (!forCurrency) throw new Error("There's nothing owed in that currency.");
    const owed = owedCents(forCurrency);
    if (input.amountCents !== owed) {
      throw new Error("That amount doesn't match what's owed right now. Reload the ledger and try again.");
    }
    if (!input.batchId) throw new Error("Missing payout reference.");
    const recorded = await this.ledger.recordPayout({
      batchId: input.batchId,
      affId: input.affId,
      currency: input.currency.toLowerCase(),
      amountCents: input.amountCents,
      day: input.day,
      note: (input.note ?? "").slice(0, 200),
    });
    return { recorded };
  }
}
