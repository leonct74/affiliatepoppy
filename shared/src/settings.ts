// The merchant's program settings and portal branding.
//
// These are the numbers the founder insisted must be HIS to set (D9): the customer discount,
// the affiliate commission, whether renewals earn, and whether signups are approved by hand.
// Every value arrives from a UI form or a stored row, so every value is sanitised here —
// once, in one place — rather than trusted at each use site.

/** What the program pays and how it admits people. */
export interface ProgramSettings {
  /** The customer's discount, as a percentage. AgentsPoppy's own program uses 5 (D3). */
  discountPct: number;
  /** The affiliate's commission, as a percentage of what the customer paid. D3 uses 10. */
  commissionPct: number;
  /** true = only the first payment earns; false (default) = renewals earn too (D5). */
  firstPaymentOnly: boolean;
  /** true = a signup gets its code immediately; false = the merchant approves first (D8). */
  autoApprove: boolean;
  /** Hard ceiling on enrolled affiliates, so a bot flood can't run up the merchant's bill. */
  maxAffiliates: number;
  /** Where to email the merchant when someone applies to join (2026-08-22). Empty = don't.
   *  Held here rather than derived from anything: the platform has no other address for a
   *  programme, and a merchant may well want a shared inbox rather than a personal one. */
  notifyEmail: string;
}

/** How the affiliate-facing pages look and what they say (D10 — white label). */
export interface PortalBranding {
  /** The merchant's name, as their partners know it. Shown instead of ours, everywhere. */
  merchantName: string;
  /** One accent colour, `#rrggbb`. */
  accentColor: string;
  /** An inline logo (data: URI). Capped — see LOGO_MAX_BYTES. Empty means "no logo". */
  logoDataUri: string;
  /** The pitch at the top of the signup page, in the merchant's own words. */
  offerCopy: string;
  /** The program's terms. Shown in full on the signup page — never a link to nowhere. */
  termsText: string;
}

/**
 * A percentage above this is almost always a typo (a merchant meaning 10 and typing 100 would
 * hand away every sale). We refuse rather than clamp silently at the UI, but clamp here so a
 * hand-edited row can never make the receiver pay out more than the sale was worth.
 */
export const MAX_PCT = 90;

/** 100 KB of logo is plenty for a data: URI that must ride inside every page render. */
export const LOGO_MAX_BYTES = 100_000;

export const DEFAULT_SETTINGS: ProgramSettings = {
  discountPct: 5,
  commissionPct: 10,
  firstPaymentOnly: false,
  autoApprove: false,
  maxAffiliates: 1000,
  notifyEmail: "",
};

export const DEFAULT_BRANDING: PortalBranding = {
  merchantName: "",
  accentColor: "#9dbbe8",
  logoDataUri: "",
  offerCopy: "",
  termsText: "",
};

/** A finite number in [min, max]; anything else falls back to `fallback`. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** Settings as we will actually use them, whatever the caller sent. */
export function sanitizeSettings(input: unknown): ProgramSettings {
  const raw = (input ?? {}) as Partial<Record<keyof ProgramSettings, unknown>>;
  return {
    discountPct: clampNumber(raw.discountPct, 0, MAX_PCT, DEFAULT_SETTINGS.discountPct),
    commissionPct: clampNumber(raw.commissionPct, 0, MAX_PCT, DEFAULT_SETTINGS.commissionPct),
    firstPaymentOnly: bool(raw.firstPaymentOnly, DEFAULT_SETTINGS.firstPaymentOnly),
    autoApprove: bool(raw.autoApprove, DEFAULT_SETTINGS.autoApprove),
    maxAffiliates: Math.round(clampNumber(raw.maxAffiliates, 1, 100_000, DEFAULT_SETTINGS.maxAffiliates)),
    // Deliberately loose, and never a hard refusal: an address we can't parse simply means no
    // notifications, which must not block the merchant from saving everything else.
    notifyEmail: typeof raw.notifyEmail === "string" && raw.notifyEmail.trim().length <= 254 ? raw.notifyEmail.trim() : "",
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Branding as we will actually render it — including the logo size guard. */
export function sanitizeBranding(input: unknown): PortalBranding {
  const raw = (input ?? {}) as Partial<Record<keyof PortalBranding, unknown>>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const logo = typeof raw.logoDataUri === "string" ? raw.logoDataUri.trim() : "";
  return {
    merchantName: text(raw.merchantName, 60),
    accentColor: typeof raw.accentColor === "string" && HEX_COLOR.test(raw.accentColor.trim())
      ? raw.accentColor.trim().toLowerCase()
      : DEFAULT_BRANDING.accentColor,
    // Only an inline image, and only a small one: the portal page must stay self-contained
    // (no external requests from an affiliate's browser) and a huge logo would be paid for on
    // every page load. Anything else is dropped rather than half-rendered.
    logoDataUri: logo.startsWith("data:image/") && logo.length <= LOGO_MAX_BYTES ? logo : "",
    offerCopy: text(raw.offerCopy, 400),
    termsText: text(raw.termsText, 4000),
  };
}

/**
 * The default offer sentence, built from the live numbers so it can never contradict them.
 * The merchant may replace it; if they don't, their affiliates still read something true.
 */
export function defaultOfferCopy(s: ProgramSettings): string {
  return (
    `Earn ${s.commissionPct}% of every sale you bring in. ` +
    `Your audience gets ${s.discountPct}% off with your personal code` +
    (s.firstPaymentOnly ? "." : ", and you keep earning on renewals.")
  );
}

/**
 * A starting point for the programme's terms — plain English, built from the live settings so
 * the numbers in it can never contradict the ones on the page. The merchant edits it into
 * their own words; nothing here is legal advice, and the text says which parts they must fill.
 *
 * Why offer one at all: an empty box labelled "terms" is where people freeze. The things an
 * affiliate wants to know before promoting anyone — how and when they're paid, what counts,
 * what's not allowed, how it ends — are the same for almost every programme.
 */
export function defaultTermsText(s: ProgramSettings, merchantName: string): string {
  const who = merchantName || "the merchant";
  const renewals = s.firstPaymentOnly
    ? "Commission is paid on the first payment of each new customer only."
    : "Commission is paid on the first payment and on every renewal, for as long as the customer stays.";
  return [
    `Affiliate programme terms — ${who}`,
    "",
    "What you earn",
    `You earn ${s.commissionPct}% of what a customer pays (after their discount, before tax) when they buy using your personal code. ${renewals} Your audience gets ${s.discountPct}% off with your code.`,
    "",
    "Refunds",
    "If a sale is refunded, the commission on it is taken back — in full for a full refund, in proportion for a partial one.",
    "",
    "How and when you're paid",
    "[Fill in: e.g. by bank transfer, once a month, once you're owed at least €25. Say what details you'll need from them.]",
    "",
    "What's not allowed",
    "Buying with your own code. Bidding on our brand name in paid ads. Spam, or promoting us anywhere misleading. [Add anything else you care about — for example, whether posting the code on coupon sites is fine.]",
    "",
    "Ending the partnership",
    "Either of us can end it at any time. If we retire your code, anything you've already earned is still paid.",
    "",
    "Taxes",
    "You're responsible for declaring and paying tax on what you earn.",
    "",
    `Questions: [your contact email].`,
  ].join("\n");
}
