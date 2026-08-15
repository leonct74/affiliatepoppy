// The merchant's side of the programme: connecting Stripe, setting the economics, approving
// and retiring affiliates, reading the ledger, and recording what they have paid.
//
// Everything here runs in the SIDECAR (the merchant's own machine, using their brokered AWS
// credentials) rather than in a Lambda, because it is admin work: it happens when a person
// clicks something, not when Stripe calls. That also keeps the Stripe API key out of the hot
// webhook path — the receiver Lambda cannot read it at all.

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { issueCodeFor } from "../../shared/src/issue";
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
import { readSecret } from "./secrets";

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
  ) {
    this.ledger = new DynamoLedger(db, tableName);
  }

  /** A Stripe client using the merchant's stored key, or null when they haven't connected. */
  private async stripe(): Promise<StripeClient | null> {
    const apiKey = await readSecret(this.ssm, "apiKey");
    return apiKey ? new StripeClient({ apiKey }) : null;
  }

  async config(): Promise<{
    settings: ProgramSettings;
    branding: PortalBranding;
    stripe: { couponId: string; lastEventAt: number; livemode: boolean };
    /** The offer as affiliates will actually read it — generated when the merchant left it blank. */
    offer: string;
  }> {
    const [{ settings, branding }, stripe] = await Promise.all([this.ledger.config(), this.ledger.stripeState()]);
    return { settings, branding, stripe, offer: branding.offerCopy || defaultOfferCopy(settings) };
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
    const branding = sanitizeBranding(input.branding ?? current.branding);
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
    return { settings, branding, couponChanged };
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
    await issueCodeFor({
      affId,
      displayName: profile.displayName,
      couponId,
      issuer: stripe,
      registry: this.ledger,
      ...(preferredCode ? { preferred: preferredCode } : {}),
    });
    return (await this.ledger.affiliate(affId))!;
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
    await this.ledger.updateAffiliate(affId, { status: "retired" });
    return (await this.ledger.affiliate(affId))!;
  }

  /** Set (or clear, with null) one affiliate's own commission rate — D9. */
  async setRate(affId: string, pct: number | null): Promise<AffiliateProfile> {
    const clean =
      pct === null ? null : sanitizeSettings({ commissionPct: pct, discountPct: 0 }).commissionPct;
    await this.ledger.updateAffiliate(affId, { pctOverride: clean as number | undefined });
    const profile = await this.ledger.affiliate(affId);
    if (!profile) throw new Error("That affiliate isn't in your programme.");
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
