// What the backend hands the UI. Kept deliberately close to the backend's own shapes — the
// ledger vocabulary lives in shared/ and this is its view-side echo, so a field that changes
// meaning changes in both places at once.

export interface Meta {
  account: { accountId: string; region: string };
  connectionId: string;
}

export interface DeploymentStatus {
  phase: "none" | "deploying" | "ready" | "removing" | "failed";
  stackStatus?: string;
  stackName: string;
  region: string;
  tableName?: string;
  inProgress: boolean;
  message?: string;
  failureReason?: string;
  deployedTemplateKey?: string;
  currentTemplateKey: string;
  updateAvailable: boolean;
  /** The webhook endpoint the merchant pastes into Stripe. */
  receiverUrl?: string;
  /** The affiliate portal — the link the merchant shares with people who want to join. */
  portalUrl?: string;
  affiliatePoolId?: string;
}

export interface ProgramSettings {
  discountPct: number;
  commissionPct: number;
  firstPaymentOnly: boolean;
  autoApprove: boolean;
  maxAffiliates: number;
  /** Where to email the merchant when someone applies. Empty = no notifications. */
  notifyEmail: string;
}

export interface PortalBranding {
  merchantName: string;
  accentColor: string;
  logoDataUri: string;
  offerCopy: string;
  termsText: string;
}

/** Whether a secret is stored, and its last four characters — never the secret itself. */
export interface SecretStatus {
  stored: boolean;
  hint: string;
}

export interface ProgramConfig {
  settings: ProgramSettings;
  branding: PortalBranding;
  stripe: { couponId: string; lastEventAt: number; livemode: boolean; partners: Partner[] };
  offer: string;
  plan: { pro: boolean };
  /** P10: the platform portal, when published ("" = not yet). feedUrl/feedDay = the Q3
   *  Stripe-fed public ledger: where the merchant's extra webhook points, and when it
   *  was connected ("" = not yet). */
  portal: { slug: string; url: string; feedUrl: string; feedDay: string };
  secrets: { webhookSecret: SecretStatus; apiKey: SecretStatus; connectSecret?: SecretStatus };
}

/** P7: a developer whose Stripe connected account the merchant's codes also work on. */
export interface Partner {
  account: string;
  label: string;
  couponId: string;
  couponPct: number;
}

/** P7 / D15b: what the merchant has advanced on one developer's sales, per currency. */
export interface PartnerTotal {
  account: string;
  label: string;
  currency: string;
  advancedCents: number;
}

export interface SyncReport {
  minted: number;
  failures: { account: string; label: string; message: string; affiliate: string }[];
}

export interface Totals {
  currency: string;
  earnedCents: number;
  refundedCents: number;
  paidCents: number;
  owedCents: number;
}

export interface Affiliate {
  affId: string;
  email: string;
  displayName: string;
  status: "pending" | "active" | "retired" | "declined";
  /** Their own words about where they would share the code. Optional. */
  channels?: string;
  code: string;
  promotionCodeId: string;
  createdDay: string;
  pctOverride?: number;
  /** Where they say they share their code — optional, declared by them, opened by you. */
  placements: { url: string; note: string }[];
  totals: Totals[];
}

export interface LedgerEntry {
  affId: string;
  ledgerId: string;
  kind: "sale" | "renewal" | "refund";
  amountCents: number;
  baseCents: number;
  currency: string;
  pct: number;
  orderRef: string;
  day: string;
}

export interface Payout {
  batchId: string;
  affId: string;
  currency: string;
  amountCents: number;
  day: string;
  note: string;
}
