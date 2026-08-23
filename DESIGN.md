# AffiliatePoppy — DESIGN.md (source of truth)

> **Status (2026-08-14): P0–P4 built and green on the bench; NOT yet deployed to a real
> account.** 198 tests pass, the manifest rates amber with no beyond-own findings, and the
> backend bundle embeds the template + both Lambdas. What remains before this is real:
> **one founder-approved live deploy → certify → the P6 dogfood**. See §12 for exactly
> what is built, what is deliberately not, and the open live-only risks.
>
> This document is the source of truth: every product decision is recorded here with its
> reason, and every architectural choice points at the sibling repo that already shipped the
> pattern. Read this file fully before writing any code. When a decision changes, update this
> file in the same change.
>
> **Name and id are FINAL (founder, 2026-08-14): `AffiliatePoppy` /
> `com.affiliatepoppy.desktop`.** The id is the identity of every install and of the
> catalogue entry, so from here it never changes — a rename after listing would orphan
> every installed copy. Everything already carries it: the manifest, the resource prefix
> (`AffiliatePoppy*`), the deploy bucket (`affiliatepoppy-deploy-*`), the parameter path
> (`/affiliatepoppy/*`) and the accent the host paints us with.

---

## 1. What this is

**Affiliate/referral program management as a poppy.** A merchant who sells through Stripe
installs AffiliatePoppy from the AgentsPoppy catalogue; it deploys ONE CloudFormation stack
into the **merchant's own AWS** containing everything an affiliate program needs:

- a **receiver Lambda** registered as a webhook endpoint on the merchant's own Stripe
  account — it watches completed checkouts, maps redeemed promotion codes to affiliates,
  computes commissions, and writes a ledger;
- a **hosted, white-label affiliate portal** (public signup page + signed-in dashboard)
  served from the merchant's AWS, where aspiring affiliates enroll with an email, get their
  coupon code, and watch their earnings;
- a **DynamoDB ledger** — affiliates, codes, percentages, credits, payouts;
- a **Cognito user pool** for affiliate self-signup with email verification.

The desktop poppy inside AgentsPoppy is the merchant's admin: settings, affiliate approval,
ledger, payouts, portal branding.

**The differentiators (the story — use these words in the catalogue listing and README):**

1. **No cookies, so it works when visitors click "reject".** On any site with a consent
   banner, every rejected visitor is invisible to cookie-based affiliate tracking — the
   attribution cookie is never set and the affiliate silently loses the commission.
   AffiliatePoppy's attribution happens at checkout (a redeemed code), not on the
   visitor's device, so rejected-consent buyers credit their affiliate like anyone else.
2. **Even accepted cookies barely survive anymore.** Safari's tracking prevention targets
   affiliate-style link decoration specifically (cookies from decorated clicks capped to
   ~24h); Firefox strips known trackers. A "30-day window" is fiction on iPhones. A code
   doesn't live in a browser and survives see-it-on-the-phone-buy-on-the-desktop.
3. **Nothing to install on the website at all.** Conventional affiliate SaaS makes the
   merchant paste a JS snippet — itself a tracker, itself the reason a banner appears.
   AffiliatePoppy adds no script tag, no pixel, nothing client-side anywhere. It is a
   Stripe webhook into the merchant's own AWS. A merchant with no banner today adds a full
   affiliate program and still has no banner tomorrow.
4. **No customer data at rest.** The ledger stores code, amount, currency, timestamp, and
   an opaque Stripe reference — never a buyer's name, email, or any identifier. The crisp
   distinction: *customers* — nothing stored, ever; *affiliates* — an email they gave on
   purpose, because they are partners who must be paid, not visitors being tracked.

**Boundary:** AffiliatePoppy is a standalone project that runs *on* AgentsPoppy (never
forks it — FSL non-compete). The sibling repos (`~/Projects/traffic-poppy`,
`~/Projects/vm-poppy`, `~/Projects/mailpoppy`) are READ-ONLY reference material: copy
patterns from them, never modify them from here.

---

## 2. Founder-locked decisions (2026-08-14) — do not relitigate

| # | Decision | Reason |
|---|---|---|
| D1 | Attribution is **coupon/promotion-code based**, never cookies, never localStorage, never fingerprinting. | Cookie-class storage for commercial attribution legally requires a consent banner; "no cookies, no banner" is the family's identity. Codes need no storage at all. |
| D2 | Attribution is decided **server-side from Stripe-signed webhook events** in the merchant's own cloud. Affiliates can never write their own numbers. | Same rule as MailPoppy tenant isolation: verified claims, never client input. |
| D3 | For AgentsPoppy (first customer): prices +15% (founder's own manual Stripe step), customer coupon **5% off**, affiliate commission **10%**. | Founder's economics. The margin absorbs a universal 15% uplift; the code splits it. |
| D4 | Commission base = **what the customer actually paid, excluding tax** (after the discount). | "10% of what the customer actually paid" — and tax was never the merchant's money. |
| D5 | Commission on **renewals too**, not just the first payment ("a percentage of ALL the sales they generate"), with a global setting `firstPaymentOnly` for merchants who want the other policy. | Founder's original framing; other merchants differ, so it's a toggle. |
| D6 | For AgentsPoppy: commission on **subscriptions only, never donations**. Enforced structurally: promotion codes are only enabled on subscription checkouts, so a donation can never carry a code. | A $5 donation with a commission and a discount on it stops being a donation. |
| D7 | Coupon leakage to aggregator sites is **accepted and welcomed** — "one more advertising channel". No anti-leak machinery. Codes stay unique per affiliate (traceable) and retirable. | Founder decision. Prices are competitive enough that a discounted organic sale is just a sale. |
| D8 | **Approval toggle** per install: `autoApprove` (founder's own mode) vs review-then-issue. | Self-service signup means scrapers can enroll; other merchants will care even though the founder doesn't. |
| D9 | Discount %, commission %, and per-affiliate overrides are **poppy settings in the UI**, stored in the merchant's DynamoDB. | The founder explicitly wants to set 15/5/10-style economics himself, in the poppy. |
| D10 | **Self-service white-label portal** hosted from the merchant's AWS. Merchant shares one link; affiliates enroll, verify email, receive a code, and self-serve their stats. | Removes the merchant's need to build any protected webpage. White-label = their name, logo, colours, terms, offer copy. |
| D11 | v1 includes a **restricted Stripe API key** (promotion-codes write only), stored in the merchant's own AWS, to auto-issue codes at enrollment. | Self-service code issuance requires it. The key never touches AgentsPoppy servers. A keyless pre-created-pool fallback exists but undercuts "just share the link" — build the key path. |
| D12 | Payouts are **computed and reported, never executed**. "Mark paid" records what the merchant paid manually. | No money-movement permissions in a poppy. Ledger + monthly manual transfer beats building payout rails on day one. |
| D13 | Monetization: **free core on the AWS-generated portal URL; premium = the portal on the merchant's own domain** (`partners.merchant.com`) via the True Reach machinery. | Identical split to TrafficPoppy (stats.your-site.com is its paid tier); machinery already live-verified. Poppy's own price: founder decides before listing. |
| D15 | **The party who emitted the coupon pays the publisher.** If AgentsPoppy issued the code, AgentsPoppy pays — even when the sale lands on a third-party developer's poppy. The developer then reimburses that commission, on top of the 5% (D15b), automatically by direct debit (D15c) — §12.6c. | Founder, 2026-08-14: "we are the one committing with the publisher". It gives the publisher ONE counterparty who can never answer "talk to the developer" — which is the whole trust proposition. The reimbursement keeps AgentsPoppy at its 5% instead of subsidising other people's sales. |
| D15d | **The calendar, not the clock.** Sales in month M are approved and the developers direct-debited on the **1st of M+2**; publishers are paid on the **10th of M+2**. Money is always collected *before* it is paid out, and a rolling reserve covers the late-refund tail — §12.6d. | Founder, 2026-08-16: *"they wouldn't really care when the money will be in their pocket, they just need the certainty of when to expect."* A fixed date beats a short one. Collect-then-pay removes the float; the calendar removes the uncertainty; nobody's payout ever depends on somebody else's payment arriving. |
| D15e | **A reversal is a credit, never a payment out**, and a developer may not be a publisher on their own poppy. Kills self-dealing by arithmetic rather than by policy — §12.6e. Applies only to central campaigns; **the shipped poppy is not in the money at all** (D12). | Founder, 2026-08-16, spotting the fraud: sign up as your own affiliate, sell to yourself, refund, keep the commission. It only pays if a reversal can pull cash out of the platform — so don't let it. |
| D16 | **The backend is confined** — `backend.isolation: "strict"`: it may read its install directory and write only its `dataDir` and OS temp; nothing else on the machine, and no child processes. Files leave via the host's `/ext-dl` one-shot handoff, never via `~/Documents`. | Founder, 2026-08-16: *"by design all poppies must comply not to access the file-system except for their own folder."* AffiliatePoppy keeps NO local state (everything is in the merchant's AWS), so the only casualty was the CSV export writing to Documents — replaced. Verified by booting the shipped bundle under the host's exact `NODE_OPTIONS`: `~/.aws` and `~/Documents` → `ERR_ACCESS_DENIED`, `dataDir` and install dir → allowed. |
| D17 | **Connected accounts are in the poppy (P7).** A merchant who runs a Stripe *platform* lists participating developers' `acct_…` ids; every affiliate code is minted on the merchant's account **and on each of theirs**; a second, "connected accounts" webhook endpoint feeds the same receiver; every ledger entry records the account the sale landed on; the Ledger reports **what each developer owes back** (D15b) — computed and reported, never collected (D12). | Founder, 2026-08-16, at the end of the first live test: *"I don't want to test the teardown if we still need to develop a new Stripe workflow and ledger to work with connected accounts."* Without it, the poppy tracks first-party poppy sales only (those charge on the platform account); developers' poppies — the majority of the catalogue — would be invisible. Opt-in per developer, not automatic: D15's guard. |
| D18 | **Collect at source (founder, 2026-08-16): the commission rides the application fee.** The buyer enters the code IN the poppy's purchase flow, before checkout creation; agentspoppy-web pre-applies the discount and sets the fee to platform % + commission — the reimbursement lands in the platform's balance at the instant of the sale. Subscriptions carry the bumped `application_fee_percent`, so renewals collect automatically. A refund refunds the fee's commission share back to the connected account. — §12.6g. | Founder's own question: *"since we take a commission automatically from any connected-account sale, why not add the 3.80 to it?"* The only obstacle was timing — the fee is immutable after session creation and Stripe's own code box is too late — and capturing the code one screen earlier removes it. Replaces D15c's direct-debit machinery for every platform-created checkout, i.e. all poppy sales; no chasing, no credit risk. |
| D19 | **The paywall is the publisher portal (founder, 2026-08-16), and the paid portal lives on an AgentsPoppy/OllyDigital SUBDOMAIN** (e.g. `merchant.affiliates.agentspoppy.com`). Free: the full merchant-side machine — codes, ledger, connected accounts, CSV. Paid: the self-service portal publishers sign up on, hosted under the platform's domain. Supersedes D13's custom-domain premium as the primary tier (a merchant's own domain can remain a later add-on). | The founder's framing: the subdomain "also works as a third party, proving the deal cannot be manipulated by the platform offering the affiliate programme to the publisher." The paid feature and the §12.5a neutral-witness story are the same thing: publishers trust a portal that visibly isn't the merchant's own web server. And (founder, same day) the subdomain is a **stable link**: the free Lambda URL changes on any teardown/redeploy, silently breaking every link a publisher ever shared — the subdomain outlives the stack behind it. Honest limit, recorded as in §12.5a: the DATA still lives in the merchant's AWS, so the subdomain is a strong signal and a naming/hosting guarantee, not yet a cryptographic attestation — the witness machinery can harden it later. |
| D19b | **The paid portal is PLATFORM-HOSTED, and the guarantee is fed by Stripe, not by the merchant** (founder, 2026-08-16: *"the publisher portal doesn't necessarily be included in the privacy promise — AgentsPoppy works as third party to guarantee the merchant doesn't manipulate the ledger"*). Publishers sign up on `affiliates.agentspoppy.com/<merchant>` (a path in the existing App Hosting app — no new infrastructure, no wildcard-domain problem); the platform holds publisher identities and computes their earnings ITSELF from a per-merchant Stripe webhook the merchant points at the platform. Falsifying the publisher's view then requires falsifying Stripe. The free tier stays fully sovereign (Lambda-URL portal, everything in the merchant's AWS). Open at build time: code minting — poppy polls the platform for approved signups, or the merchant shares the narrow codes-only restricted key. Supersedes the D19 subdomain-DNS sketch; the trust is the product, not the name. | The paid feature and the §12.5a neutral-witness are now genuinely the same mechanism: a publisher-facing record the programme owner cannot touch. This is also the founder's original instinct from the pricing discussion — "AgentsPoppy keeps some data outside the user infrastructure, working as the trustworthy third party" — landed as architecture. |
| D19c | **The conversion levers are the free-plan banner and locked personalisation (founder, 2026-08-20)** — *"people will not pay for a better-looking link."* Free: the full machine — codes, ledger, portal, connected accounts, percentages, approvals, the merchant's name. Locked behind Pro: the personalisation form (logo, colour, offer copy, terms), shown disabled with the unlock beside it; and the publisher portal carries a banner naming the free plan. Banner wording must never cast doubt on the NUMBERS (a publisher who reads "testing" doubts their earnings and leaves the merchant): it says the plan is free and the tracking is real. The D19b friendly link joins the same Pro tier when built. Enforcement is the family's honesty-based gate (the flag lives in the merchant's own AWS, as with every poppy tier). | Publishers seeing their merchant on the free plan is pressure the merchant feels every day; a locked form they can see is a demo of what they'd get. Together they convert; a URL alone doesn't. |
| D20 | **The platform portal is for EVERYONE, from first setup — Pro only removes the banner and unlocks personalisation (founder, 2026-08-22).** His two-step reasoning: (1) *"give the link in the very first setup… with the banner, no one would like not to migrate to pro"* — the free banner on every public page is BOTH the conversion engine and free advertising for AgentsPoppy; (2) asked whether a merchant could effectively manipulate an in-AWS ledger (yes — it is their database): *"then it is better we host it, otherwise AffiliatePoppy will have the bad name of not being reliable if someone starts cheating."* The reputation belongs to the product, so the publisher-facing record must be ours for every tier, not just the paid one. Consequences: claiming `affiliates.agentspoppy.com/<name>` moves out of the Pro gate into onboarding; free pages carry the D19c banner (the vouched wording — numbers are real) with the subscribe button and the AgentsPoppy link; Pro = banner off + branding on. The in-AWS Cognito portal becomes redundant (one portal, one truth) and is retired from the stack once the platform loop is live-proven — a smaller template and a smaller permission set. The product-page privacy sentence changes to the true one: the MONEY ledger lives in the merchant's AWS; the sign-up page is hosted independently by AgentsPoppy so publishers can trust the numbers. Setup tedium is killed separately by webhook automation — BUILT 2026-08-22: the key gains "Webhook Endpoints: Write", the poppy creates all endpoints itself (receiver; connected-accounts once partners exist — Stripe refuses connect endpoints on non-platform accounts; the ledger feed once published), stamped with metadata affiliatepoppy=<role> for idempotent reruns, each secret stored at creation (Stripe never reveals it again — an endpoint existing without its stored secret surfaces as words with both ways out). Setup reordered: key first, webhooks one click, manual cards collapsed as fallback. Supersedes the D19b sentence "the free tier stays fully sovereign" and the D19c sentence putting the friendly link in the Pro tier. | A guarantee only the paid tier gets protects only paid programmes; cheating on a free programme would poison the same brand. Hosting the page for everyone makes the witness universal, the banner ubiquitous, and the architecture single-path. |
| D20a | **Strategy: finish → dogfood → then decide the web tier (founder, 2026-08-22, option "C").** Concern behind it: the desktop-download onboarding can't convert cold merchants against browser-first incumbents (Rewardful/Tolt/FirstPromoter), and the witness infrastructure means the platform hosts real machinery anyway. Decision: complete the poppy as designed, run the founder's own programme on it, and only lift the already-built platform pieces (portal, publisher accounts, witness ledger, minting handshake — ~60% of a web product) into a standalone web tier if the dogfood/banner traffic shows demand. **Branding for that future:** publisher-facing pages speak as **AffiliatePoppy** (footer, landing — done), AgentsPoppy appears only in merchant-facing pitches; **no new domain is bought now** (founder: domains are getting expensive) — `affiliates.agentspoppy.com` stays the hostname, and because the platform controls it, a later domain can be added with the old links redirecting forever, so the stable-link promise survives any rebrand. The poppies-are-extensions rule stands unless the founder explicitly breaks it for a web tier. | Defers the strategic bet until there is evidence, at zero waste: everything built serves both futures, and the brand decoupling costs only words on pages. |
| D14 | AgentsPoppy is the **first customer**: the founder installs AffiliatePoppy in his own AWS and adds its receiver as a second webhook endpoint on the platform's Stripe. | Dogfooding that is also the demo. |

---

## 3. Architecture

```
 affiliate's audience                    merchant's own AWS (ONE CloudFormation stack)
 ─────────────────────                   ────────────────────────────────────────────
 sees code in a video,                    ┌─────────────────────────────────────────┐
 blog, newsletter …                       │  receiver Lambda  ◄── Stripe webhook     │
        │                                 │   verify signature → map code→affiliate  │
        ▼                                 │   → commission → ledger (idempotent)     │
 merchant's checkout                      │                                          │
 (Stripe Checkout, code                   │  portal Lambda (Function URL)            │
  redeemed in the native                  │   GET  /            signup page (public) │
  promo field)                            │   GET  /me          dashboard (JWT)      │
        │                                 │   POST /api/enroll  issue code (JWT)     │
        ▼                                 │   POST /stripe      (or on receiver)     │
 Stripe fires                             │                                          │
 checkout.session.completed ────────────► │  DynamoDB table   Cognito user pool      │
 invoice.paid (renewals)                  │  (ledger+config)  (affiliate signups,    │
 charge.refunded (clawback)               │                    COGNITO_DEFAULT mail) │
                                          │  [premium: CloudFront + ACM for          │
                                          │   partners.merchant.com]                 │
                                          └─────────────────────────────────────────┘
                                                       ▲
 merchant's desktop ── AgentsPoppy ── poppy backend ───┘  (deploy/settings/ledger admin)
```

Two Lambdas or one Lambda with routes — implementer's choice; TrafficPoppy proves one
collector Lambda can serve both a script and an API. Prefer **two** here (receiver +
portal) so the webhook path stays minimal and the portal can be redeployed without
touching the money path. Both go in the one stack.

### 3.1 Repo layout & toolchain (copy, don't invent)

Mirror `~/Projects/traffic-poppy` exactly — it is the newest sibling and already carries
every lesson:

```
affiliate-poppy/
  extension.json          # manifest (see §8)
  DESIGN.md               # this file
  CLAUDE.md               # operating guide (already seeded)
  frontend/               # React poppy UI, poppy.css design kit, vendored feedback tab
  backend/                # sidecar backend: deploy pipeline, stack.ts, settings routes
    src/generated/        # backend-bundle.ts — GENERATED, gitignored
  lambdas/                # receiver.ts, portal.ts, portal-page.ts, shared core + tests
  infra/                  # template.ts — the CloudFormation template as code
  shared/                 # pure logic shared by lambdas/backend/frontend (goals.ts style)
  scripts/                # build-backend-bundle.mjs, build-backend.mjs, build-sidecar.mjs
```

- **Deploy pipeline:** `scripts/build-backend-bundle.mjs` → evaluates `infra/src/template.ts`,
  esbuilds + zips the Lambdas, emits `backend/src/generated/backend-bundle.ts` with the
  synthesized template + **content-addressed** Lambda zip baked in. The sidecar
  Create/UpdateStacks from that. Copy the script from traffic-poppy and rename.
- **Stack lifecycle:** copy `traffic-poppy/backend/src/stack.ts` — it already handles
  CREATE/UPDATE/NO_CHANGE/RECREATE, the `templateKey` stack tag, failure-reason surfacing,
  and the hard-won lesson that **`updateAvailable` must watch the Lambda code key AND the
  template key** (a code-only change moves the parameter while the template key stays put).
- **Template parameters:** copy the `LambdaCodeBucket`/`LambdaCodeKey`/attribution-tag
  parameter pattern from `traffic-poppy/infra/src/template.ts`, including the
  **UserPoolTags lesson**: Cognito pools must be BORN tagged (CFN does not reliably
  propagate stack tags to CreateUserPool, and a pool's random-id ARN cannot be name-scoped,
  so tag-scoping is load-bearing).
- **Packaging/release:** `agentspoppy/scripts/pack-extension.mjs`,
  `install-dev-extension.mjs`, and `docs/RELEASING-POPPY.md` — the runbook's order is
  load-bearing (publish package → verify live sha256 unauthenticated → only then the
  catalogue).
- `package.json` scripts: mirror traffic-poppy's (`typecheck`, `test`, `gen:backend`,
  `build`, `build:sidecar`, `validate-manifest`, `sync-feedback`, `check-feedback`,
  `pack`, `install-dev`, `certify`). Workspaces: `infra`, `lambdas`, `backend`, `frontend`.

### 3.2 Secrets — where the two Stripe values live

The merchant pastes two values into the poppy's Setup tab; both are stored in **their own
AWS**, never anywhere else:

1. **Webhook signing secret** (`whsec_…`) — verifies every event on the receiver.
2. **Restricted API key** (promotion-codes write ONLY) — issues codes at enrollment.

Store both as SSM Parameter Store **SecureString** under
`/affiliatepoppy/<stackName>/…`, with the `ssm` grant name-scoped to
`arn:aws:ssm:*:*:parameter/affiliatepoppy/*` (GetParameter/PutParameter/DeleteParameter
only). The Lambda execution role gets GetParameter on the same path. Do NOT put secrets in
DynamoDB and do NOT echo them back to the frontend after saving (show "saved ✓, ends in
…abc" only). The Setup tab must include plain-language instructions for creating both in
the Stripe dashboard, with a CopyButton on the exact restricted-key permission name.

### 3.3 DynamoDB data model (single table, deterministic keys ONLY)

Family rule (MailPoppy importer lesson): **any re-runnable writer uses deterministic
keys — never `new Date()` as a key fallback.** Ledger idempotency comes from Stripe ids.

| pk | sk | attributes | purpose |
|---|---|---|---|
| `cfg` | `portal` | name, accentColor, logoDataUri (≤100 KB), termsText, offerCopy, autoApprove, discountPct, commissionPct, firstPaymentOnly | white-label + program settings (D8/D9) |
| `cfg` | `stripe` | couponId, livemode, lastEventAt | non-secret Stripe state (secrets are in SSM) |
| `dir` | `aff#<affId>` | (thin row) | listable directory of affiliates |
| `aff#<affId>` | `profile` | email, displayName, status `pending\|active\|retired`, code, promoCodeId, pctOverride?, createdDay | affiliate record; `affId` = Cognito `sub` (identity IS the verified claim) |
| `code#<CODE>` | `map` | affId | redeemed-code → affiliate lookup |
| `sub#<subscriptionId>` | `map` | affId, firstInvoiceId | renewal attribution (see §4.3) |
| `aff#<affId>` | `led#<stripeEventOrInvoiceId>` | amountCents, currency, kind `sale\|renewal\|refund`, orderRef, day, paidBatch? | one ledger entry per Stripe object — redelivery-safe by key |
| `aff#<affId>` | `tot#<currency>` | earnedCents, refundedCents, paidCents | rollup, updated in the SAME transaction as the ledger insert (the feedback-plane `saveRating` pattern) |
| `payout#<batchId>` | `meta` | affId, currency, amountCents, day, note | "mark paid" history |

### 3.4 What is deliberately NOT stored (privacy invariants — never violate)

- No buyer name, email, IP, user-agent, or any identifier, in any row, ever.
- `orderRef` is the opaque Stripe object id (`cs_…`/`in_…`) — meaningful only inside the
  merchant's own Stripe account, which they already own.
- No click tracking, no visit tracking, no per-affiliate landing analytics in v1. (If the
  merchant wants traffic analytics, that product is TrafficPoppy — do not blur the two;
  affiliate attribution requires remembering a code for months, which is exactly what
  TrafficPoppy's invariants forbid. Separate promises, separate poppies.)

---

## 4. Stripe integration spec

### 4.1 Events consumed (receiver Lambda)

Verify `Stripe-Signature` with the signing secret on EVERY request (constructEvent
pattern); reject anything unverified with 400. Handle:

| event | action |
|---|---|
| `checkout.session.completed` | If the session redeemed a tracked promotion code (expand/read `total_details.breakdown.discounts` → `promotion_code`): look up `code#<CODE>` → credit `sale`; if `mode=subscription`, write `sub#<subscriptionId>` → affId mapping for renewals. |
| `invoice.paid` | If `sub#<subscriptionId>` mapping exists and settings say renewals count (D5) and this is not the first invoice (already credited via the session): credit `renewal`. |
| `charge.refunded` | If the underlying session/invoice was credited: write a `refund` ledger entry (negative), keyed by refund id. Full refunds only in v1; partial refunds reverse proportionally. |

- **Idempotency:** the ledger key IS the Stripe id — webhook redelivery is a no-op
  (conditional put; on `ConditionalCheckFailed`, return 200).
- **Commission math (D4):** `commissionCents = round(pct/100 × (amount_total − tax))`.
  Integer cents everywhere; currency recorded per entry; totals kept per currency. Pure
  function in `shared/`, exhaustively unit-tested (rounding, zero-tax, multi-currency,
  pct overrides, refund reversal).
- Unknown codes, non-tracked sessions, unhandled event types: 200 + ignore (never 500 —
  Stripe retries 500s forever).
- Return fast; do nothing slow in the webhook path.

### 4.2 Code issuance (portal Lambda, at enrollment)

One **coupon** (e.g. 5% off — `discountPct` from settings) created once via the restricted
key when settings are saved (`cfg#stripe.couponId`); each affiliate gets one **promotion
code** attached to it (`OLIVER10`-style: derived from display name + random suffix on
collision, always uppercase, [A-Z0-9]{4,20}). Coupon `duration`: `once` (the discount
applies to the first payment; renewals bill full price — the *commission* on renewals is
our ledger's job, not the coupon's).

- `autoApprove=true`: enroll → issue immediately → portal shows the code.
- `autoApprove=false`: enroll → `status=pending`, no Stripe call; the merchant approves in
  the poppy UI → code issued then → portal flips from "pending review" to the code.
- Retire (leaked/abandoned code): deactivate the promotion code via API
  (`active=false`), set `status=retired`, keep the ledger. Optionally issue a fresh code.

### 4.3 The renewal-attribution subtlety (do not skip)

With coupon `duration=once`, renewal invoices carry **no discount**, so the code is
invisible on `invoice.paid`. That is why `checkout.session.completed` writes the
`sub#<subscriptionId> → affId` mapping at first purchase: renewals are attributed from the
mapping, not the discount. Without this row, D5 silently becomes first-payment-only.

**The refund-matching subtlety (found 2026-08-16, founder's webhook on `dahlia`).** A
`charge.refunded` names the charge and its payment intent — and since `2025-03-31.basil` a
charge no longer points back at its invoice, while an invoice names its payments in a
`payments` list instead of flat `charge`/`payment_intent` fields. Two consequences, both
handled in `stripe-events.ts` and covered by tests: (1) renewal credits are filed under every
id in `invoice.payments[]` as well as the old fields; (2) the **first invoice of a
subscription**, which the checkout already credited, is no longer merely ignored — it becomes
a `link` instruction that files the existing credit under the invoice's payment ids, because
the checkout session never carried them and a refund of the first payment will name nothing
else. Without the link, refunding a subscription's first payment would read "a sale we never
credited" and the publisher would keep the commission.

---

## 5. The affiliate portal (hosted from the merchant's AWS)

**Pattern source:** `traffic-poppy/lambdas/src/viewer-page.ts` — a hand-written,
fully self-contained page served as a string from a Lambda: inline CSS, inline favicon,
zero external requests, direct `cognito-idp` calls from the browser, jsdom-tested. Copy
the approach wholesale (auth flow from `auth.ts`, page-serving, the test harness in
`viewer-routing.test.ts`).

- **`GET /` (public):** the white-label signup page. Injected from `cfg#portal`: merchant
  name, logo, accent colour, offer copy ("Earn 10% of every sale — your audience gets 5%
  off"), terms. Email + display name → Cognito **self-signup** → 6-digit email
  verification (Cognito's built-in `COGNITO_DEFAULT` sender — no SES setup, its ~50
  emails/day limit is ample for affiliate enrollment; note the SES config-set upgrade path
  in the Settings tab copy for later).
- **After verification:** browser calls `POST /api/enroll` with the Cognito JWT; the
  Lambda validates the JWT, creates the affiliate rows (affId = token `sub`), and — per
  D8 — issues the code or parks it pending.
- **`GET /me` (signed in):** their code (CopyButton), status, and their numbers only:
  redemptions, earned, refunded, paid, owed — per currency. **Identity comes exclusively
  from the verified JWT `sub`** — no affiliate id in a query string, ever (MailPoppy
  lesson: server-side isolation from verified claims, never client-side filtering).
- Mobile-first: these pages will be opened from phones. Vertical scales/readouts on any
  chart (TrafficPoppy 0.2.2 lesson: hover-only values are invisible on touch).
- Rate-limit enrollment per IP (soft, in-Lambda) and cap total affiliates (default 1 000,
  setting) so a bot flood can't run up the merchant's Cognito/DDB bill. Show the cap in
  plain language when hit.

---

## 6. The desktop poppy (merchant admin, inside AgentsPoppy)

Tabs, in order (family conventions apply: icon top-left beside the name,
`poppyAccent("com.affiliatepoppy.desktop")`, plain language everywhere, instant spinner on
every async control, background+resume — never a dead spinner after app restart).

**Order decided by the founder on the first live run (2026-08-14): Affiliates FIRST.** The
first tab is the destination, not the plumbing. Until the programme is open (storage + Stripe)
and someone has joined, it shows a four-step guide read from live state — 1) storage, 2)
Stripe, 3) your deal, 4) share the link — each a button to the right tab. Why not "Settings
first": settings live in the merchant's own table, which only exists after Setup step 1, so
the honest order is fixed and the guide says it. The list below keeps the numbering the
implementation used; only the tab position changed.

1. **Setup** — the guided path: deploy the stack (reuse the shared setup-stepper pattern);
   connect Stripe (paste the two secrets, §3.2, with dashboard walk-through); create/verify
   the coupon; then the portal link with a CopyButton and "open in browser". Resume
   mid-deploy on every load by reading REAL stack status (stack.ts). Show the money
   (AGENTS.md §9): the honest line is "typically under $1/month — Lambda and DynamoDB are
   billed per use; $0 when nothing happens", plus the True Reach cost note on the premium
   tier. TrafficPoppy's cost line is the reference.
2. **Affiliates** — list (name, code, status, %, redemptions, earned); approve pending
   (D8); per-affiliate % override (D9); retire code (type-to-confirm — it names the code
   and says existing ledger is kept).
3. **Ledger** — per-affiliate and total: earned / refunded / paid / **owed**, per currency;
   "Mark paid" records a payout batch (type the amount, it must equal owed, two-step);
   CSV export — **the backend hands the bytes to the system browser via a one-shot token**
   (D16): the frontend can't download (sandboxed frame — `<a download>` silently no-ops) and
   the backend may not write to the user's disk (confined to its own folder).
4. **Settings** — discount % (with "changing this creates a new coupon; existing codes
   keep their old discount" honesty), commission % default, `firstPaymentOnly` toggle
   (D5), `autoApprove` toggle (D8), white-label editor (name, logo upload ≤100 KB, accent,
   offer copy, terms) with live preview of the signup page.
5. **Advanced/True Reach (premium)** — custom domain for the portal: copy
   `traffic-poppy/backend/src/edge.ts` (CloudFront + ACM, DNS instructions, status
   polling, tagged-as-self). Gate behind the platform checkout entitlement; standard Buy
   button ⇒ Manage-billing comes free (AGENTS.md hard rule).
6. **Feedback** — MANDATORY last tab: vendor via
   `node ../agentspoppy/scripts/sync-feedback-tab.mjs --dest frontend/src/vendor`, declare
   `host:openExternal` + `bugsUrl` in the manifest, render `<agentspoppy-feedback>` exactly
   per `agentspoppy/AGENTS.md` §9a. `npm run check-feedback` must pass in CI.

Backend routes (sidecar): stack deploy/status/teardown, settings read/write (writes SSM +
DDB config, creates coupon), affiliates list/approve/retire/override, ledger read,
mark-paid, CSV write, entitlement check. All poppy-frontend → backend, never
frontend → AWS directly.

---

## 7. agentspoppy-web side deliverable (separate, tiny — do NOT put in this repo)

For AgentsPoppy-as-first-customer (D14), the platform needs exactly one change:

- In `agentspoppy-web/src/app/api/checkout/route.ts`, find the
  `stripe.checkout.sessions.create` call and add **`allow_promotion_codes: true` for
  subscription-mode sessions only** — never for donations (`kind=donation` metadata /
  payment-mode), which structurally enforces D6.

Founder's own manual steps (his, not the agent's — live Stripe): raise prices 15% (D3),
then in the poppy's Setup tab paste the secrets and add the deployed receiver URL as a
webhook endpoint on the platform's Stripe.

---

## 8. Manifest & permissions (`extension.json`)

Start from traffic-poppy's manifest; expected rating **amber** (Lambda execution role),
"no risks to other resources identified". Grants — least privilege, every mutation
name-scoped `AffiliatePoppy*` / `affiliatepoppy-*` or tagged-as-self:

- `cloudformation` — Create/Update/Delete/Describe on `stack/AffiliatePoppy*`
- `dynamodb` — table lifecycle + CRUD on `table/AffiliatePoppy*`
- `lambda` — function lifecycle + Function URL config on `function:AffiliatePoppy*`
- `iam` — role lifecycle + PassRole on `role/AffiliatePoppy*`
- `logs` — log-group lifecycle on `/aws/lambda/AffiliatePoppy*`
- `s3` — deploy bucket `affiliatepoppy-deploy-*` (+ objects)
- `cognito-idp` — pool lifecycle **tagged-as-self** + CreateUserPoolClient/CreateGroup on
  `userpool/*` (the vm-poppy DR3/UserPoolTags lessons apply verbatim)
- `ssm` — Get/Put/DeleteParameter on `parameter/affiliatepoppy/*`
- premium only: `acm` + `cloudfront` tagged-as-self (copy TrafficPoppy's grants)

Traps that already cost the family real debugging time:
- **Packed-policy budget (vm-poppy DR5):** declare ONLY actions the backend actually
  calls. 31 actions once meant STS rejected the vend at "118%"; 18 was fine. Audit before
  every manifest change.
- **Assessor substring false-reds (vm-poppy DR3):** `assessPermissionSet` matches action
  names by SUBSTRING — validate with the REAL `npm run validate-manifest`, not by eye.
- **Fn::GetAtt / live-deploy traps:** some template errors only fail on a real deploy
  (TrafficPoppy hit this class of bug live). P0's gate is a REAL deploy, not a template
  review.
- Capabilities: `aws:credentials`, `connection:read`, `backend:invoke`,
  `commerce:purchase` (premium), `host:openExternal` (Feedback tab). Nothing else.
- Teardown hook (`"teardown": {"endpoint": "/teardown"}`) sweeps everything the stack
  can't delete itself; three attribution tags on every resource; `npm run certify` must
  PASS a real deploy → use → teardown cycle before any listing.

---

## 9. Implementation phases (each gate blocks the next)

**P0 — Scaffold + pipeline + first real deploy.**
Repo per §3.1; manifest validates; template with table + receiver Lambda (echo handler) +
portal Lambda (placeholder page); sidecar builds; dev-install into AgentsPoppy; **founder
approves ONE real deploy** to the test account (the P1 live-test setup); then teardown + `certify` PASSES. *Gate: leaves-no-trace certified on day one, not
retrofitted. Every later phase re-runs it.*

**P1 — The money path.**
`shared/` commission math + event parsing (pure, tested); receiver: signature verification,
the three events, idempotent ledger + rollups, `sub#` mapping, refunds. Test with recorded
Stripe fixture events (test mode), including redelivery (same event twice ⇒ one entry) and
the renewal-without-discount case (§4.3). *Gate: full vitest suite green; a test-mode
end-to-end checkout with a real test coupon credits exactly once.*

**P2 — Poppy admin.**
Setup tab (deploy + secrets + coupon + portal link), Settings, Affiliates (manual add
first — portal comes next), Ledger + mark-paid + CSV-via-backend. Click-test EVERY control
in the running host (the #1 poppy defect is a dead button). *Gate: founder can run a
manual-enrollment affiliate program end to end on test Stripe.*

**P3 — The portal.**
Signup page + Cognito self-signup + enroll + code issuance (D8 both modes) + `/me`
dashboard. jsdom tests drive the real served pages (viewer-routing.test.ts pattern):
signup, verify, enroll pending vs auto, dashboard shows ONLY the JWT's own rows. *Gate:
an affiliate on a phone can enroll and read their earnings with zero merchant help.*

**P4 — White-label.**
Portal branding editor + live preview; logo size guard; portal renders config. *Gate:
two visually distinct merchant setups from the same build.*

**P5 — Premium: custom domain.**
Port TrafficPoppy `edge.ts`; entitlement-gate via platform checkout; Manage billing
visible where the feature lives. *Gate: portal live on a real custom domain in the test
setup, then torn down clean.*

**P7 — Connected accounts (D17) — BUILT 2026-08-16, ahead of P5/P6.**
Second ("connected accounts") webhook secret in SSM, receiver verifies against either;
`Stripe-Account` header on the existing restricted key; partner list in `cfg#stripe`;
coupon per partner account; `mintOnPartners()` after issue/approve, `syncCodes()` as the
recovery path; `account` on every ledger entry and ref row; `acct#` totals rows moved in the
same transaction; its own "Connected accounts" tab (founder, 2026-08-16: the poppy is
sold to any merchant, so the UI says "connected account", never "developer" — the one
exception is quoting Stripe's own menu path); Ledger "Owed back to you". *Gate: a test-mode sale on a connected account credits the publisher and the
developer's figure; refund reverses both.*

**P10 — D19b: the platform publisher portal (`affiliates.agentspoppy.com`). Phased plan
(2026-08-20; build order, each phase independently shippable):**

- **Q1 — Merchant registration (platform + poppy). ✅ BUILT 2026-08-21.** Firestore model:
  `portalMerchants/{slug}` (slug rules: lowercase, 3–30 chars, reserved words blocked), holding
  mirrored branding/settings, a per-merchant API token (poppy↔platform auth), and a per-merchant
  Stripe webhook secret (empty until Q3). Poppy side: a Pro-gated "Publish your portal" card —
  picks the slug, pushes branding/settings on every save, shows the friendly link. Platform API:
  register/update, token-authenticated (token sha256-hashed at rest, returned exactly once;
  poppy saves it to SSM BEFORE the slug so a half-publish is recoverable).
- **Q2 — The portal pages. ✅ BUILT 2026-08-21.** Host rewrite (`affiliates.agentspoppy.com` →
  `/portal/*` via next.config `has: host` rules, zero cost to the main site — NOT middleware).
  `affiliates.agentspoppy.com/<slug>`: the merchant-branded page server-rendered from the
  registry (accent bar, logo, offer, deal sentence) + client join flow (Firebase Auth
  email+password, email verification with the junk-folder warning, sign-in, reset), publisher
  dashboard shell (code card with honest pending / being-prepared / active states, earnings
  placeholder, terms). AgentsPoppy footer = the witness identity, deliberately visible.
  Signups: `portalMerchants/{slug}/signups/{uid}` — create-if-absent; status starts `pending`
  or `approved` by the merchant's autoApprove at join time; `active` once Q4 mints the code.
  APIs `POST /api/portal/signup` + `GET /api/portal/me` verify the Firebase ID token
  server-side and require `email_verified` (a signup eventually earns money — it must belong
  to a mailbox the person owns). *Build lessons:* (1) Next `beforeFiles` rewrites CASCADE —
  the `/`→`/portal` landing rewrite got re-matched by the slug rule as `/portal/portal`; the
  slug pattern now excludes the literal `portal`. (2) A Firestore hiccup on a merchant page
  renders "try again in a minute", never a raw 500 — only a confirmed miss 404s.
  *Founder action before live publishers:* add `affiliates.agentspoppy.com` to Firebase Auth
  → Settings → Authorized domains (sign-up/sign-in runs there now), and if the web API key
  has HTTP-referrer restrictions, allow the subdomain there too.
- **Q3 — The Stripe-fed ledger (the guarantee). ✅ BUILT 2026-08-21.** Per-merchant intake:
  `POST /api/portal/stripe/<slug>`, verified with that merchant's own signing secret (the
  merchant adds ONE more webhook endpoint in their Stripe pointing at the platform — same
  gesture as the poppy's own; the poppy's Settings card walks through it: scope "Your
  account", version `2026-07-29.dahlia`, the three events, endpoint URL with copy button).
  The secret is a PASS-THROUGH: pasted in the poppy, PUT to the platform token-authenticated,
  never stored in the merchant's AWS, never echoed — only a `feedDay` marker kept. The
  platform computes publisher earnings ITSELF: `parser.ts`/`money.ts` are VENDORED PORTS of
  the poppy's shared modules (rule changes must land in both repos together — recorded in
  both file headers), `apply.ts` is the attribute layer keyed by Firebase uid. Storage under
  `portalMerchants/{slug}`: entries under `signups/{uid}/entries` (publisher isolation in the
  storage shape; no composite index), `refs/{id}` for refund matching, `subs/{id}` for
  renewals, totals moved atomically with each entry; redelivery no-ops, repeated
  `charge.refunded` converges. Publisher dashboard shows totals + history from `/api/portal/me`.
  Per-publisher rate overrides (D9): `pctOverride` on the signup, to be pushed by Q4's mint
  postback; until then the programme rate applies. Falsifying the publisher's view now
  requires falsifying Stripe — §12.5a's witness, real. *Live verification happens at Q6
  dogfood (needs Q4's minted codes to attribute real events).*
- **Q4 — The minting handshake. ✅ BUILT 2026-08-21.** DECIDED: the poppy polls (keys never
  leave the merchant's AWS). Platform queues signups; the poppy's backend polls every 60s
  while the app runs (`portal-sync.ts`, kicked 5 s after boot), imports them as ordinary
  affiliates (`affId = pp_<firebase-uid>` — the prefix IS the source marker, zero schema
  change; Affiliates tab shows "via your public page"), mints through the EXISTING approve
  path (issueCodeFor + mintOnPartners) when allowed — merchant's autoApprove, platform-side
  approved, or manual approval in the poppy — and POSTs back code + promotion ids +
  pctOverride via `/api/portal/publisher` (sanitised field-by-field, never an upsert).
  The merchant's affiliate cap applies to platform signups exactly as to the poppy's own.
  Approve/retire/setRate write through to the platform so the witness never drifts (retired
  publishers see "ended — your earnings stay recorded"); a missed write-back reconciles on
  the next pass instead of re-minting. The portal shows "your code is being prepared"
  honestly in between.
- **Q4a — Teardown retires the world outside AWS too. ✅ BUILT 2026-08-22** (was the
  "teardown must retire the platform portal" open item). The teardown hook now runs
  `retireExternal()` FIRST — while SSM still holds the credentials it is about to forget:
  (1) `closePortal` POSTs `/api/portal/close` with the token; the platform marks the
  merchant `closed` (webhookSecret dropped, joining and every merchant-authed write refused,
  `verifyMerchantToken` → null) and the page becomes "programme closed" — publishers keep
  signing in and seeing their recorded history. Follows rename tombstones (token survives a
  rename), treats 404 and missing slug/token/table as success (idempotent re-runs), and
  NEVER throws — an unreachable platform becomes a sentence in the teardown report saying
  the page is still up. (2) `removeStampedWebhooks` deletes every `affiliatepoppy=<role>`
  destination from the merchant's Stripe — hand-made ones stay theirs. The Remove tab shows
  the external outcomes afterwards ("Outside your AWS account"), and its blast-radius copy
  names everything. (3) **Codes and coupons die with the programme — founder ruling,
  2026-08-22:** *"after the user tears down the poppy, no live coupon should be around"*
  (while installed, retiring an affiliate in the app is how a code goes off). Teardown
  deactivates every promotion code the app minted (own account + every partner's) and
  deletes every coupon it created: the ids the table knows, plus anything carrying the
  `metadata[affiliatepoppy]=coupon` stamp coupons now get at creation (catches coupons a
  discount change replaced, whose ids the table forgot; pre-stamp installs are covered by
  the known ids). **NO REVIVAL, refined:** a page WITH history (any signup, ref or sub
  recorded) closes forever — whoever re-claimed the name would inherit the old programme's
  publisher list (identity hijack); reviving one is a manual support act. A page with NO
  history is DELETED at teardown and the name freed — checked inside the deleting
  transaction, so a racing join flips it to a close — which is what keeps the recommended
  "practise in test mode, tear down, go live" flow from burning the merchant's name.
  **LIVE-PROVEN + CERTIFIED 2026-08-22:** the founder ran `npm run certify --yes` against his
  real install (the one live-verified through Q1–Q4, with a real publisher on the page) —
  footprint of 12 → teardown hook ran → **0 residuals, ✓ CERTIFIED** (cert in
  `leaves-no-trace.cert.json`, local per .gitignore). The external half executed for real on
  its first run: `affiliates.agentspoppy.com/affiliates-portal` now serves the
  "programme has closed" tombstone with publisher sign-in intact (verified live). The name
  is permanently retired per the no-revival rule — the founder chose to accept that and
  re-publish under a new name rather than skip the teardown test. The AGENTS.md
  certify-before-listing gate, which the 2026-08-22 listing briefly ran ahead of, is now met.
- **Q4b — Renaming a programme MOVES its publishers. ✅ BUILT + LIVE-PROVEN 2026-08-22.**
  The rename used to be refused outright once anybody had joined ("has_publishers"), because
  Firestore subcollections do NOT travel with their parent document — a rename would have
  rewritten the merchant doc and orphaned every publisher, their entries, refs and subs at the
  old path. The founder hit the trap on his own install (one retired TEST signup froze his
  typo'd address `affilites-personal-portal` permanently) and ruled: *"fix it properly"*.
  `renamePortalMerchant` now migrates, in an order chosen for safety: (1) reserve the new name
  in a transaction marked `migrating:true` — a racing claim must never end up owning a record
  we then pour someone else's publishers into, and an interrupted run resumes its own
  reservation by matching tokenHash; (2) copy signups + their entries + refs + subs with a
  bulkWriter while the OLD address is still canonical, so a failure leaves everyone untouched
  (every write AWAITED — the first draft fired them and forgot, which would have surfaced as
  an unhandled rejection AFTER the pointer moved); (3) one transaction flips canonical and
  writes the `movedTo` tombstone; (4) best-effort recursiveDelete of the originals. A crash
  between (3) and the reply no longer strands the poppy on a tombstone: a retry from the old
  slug returns the success it missed. The page holds a "one moment" state while `migrating`.
  **Related hole closed:** the Stripe ledger-feed intake now resolves through
  `resolveLivePortalMerchant`, so events arriving at the old address (the webhook URL contains
  the slug and still names it until the merchant re-presses the button) are FOLLOWED rather
  than dropped — previously every commission in that window was lost. Only "name already
  taken" can refuse a rename now. **First production run verified the same day:** the old slug
  is a clean tombstone with its subcollections swept, the new slug carries the publisher with
  their code intact.
- **Q5 — Web checkout with purchase code.** The portal's upgrade button becomes a real
  checkout: web purchase mints a claim code shown on purchase-complete; the poppy's Settings
  gains "bought on the web? paste your code", which binds the entitlement to the install.
- **Q6 — Cutover + dogfood.** Poppy Setup/step-4/Affiliates surfaces show the friendly link
  when published; the founder's own programme moves onto it (D14); payment-workflow PDF and
  helper prompt updated; screenshots.

**P6 — Dogfood + listing.**
Founder installs in his own AWS; agentspoppy-web one-liner (§7) ships; platform webhook
added; a real (test-mode first, then live) AgentsPoppy sale credits a real affiliate.
Fresh `certify`, screenshots, catalogue submission per
`agentspoppy/docs/RELEASING-POPPY.md` (publish → verify live sha256 unauthenticated →
catalogue; the version string is the entire update signal). *Gate: founder go on the
listing + the poppy's own price decided.*

---

## 10. Working agreements (inherited from the family — hard rules)

- **Founder confirmation before ANY command that creates/changes/deletes live AWS or
  Stripe resources.** Read-only is fine. Live tests in the founder's account are torn
  down afterwards and verified clean.
- Never commit build artifacts (`.gitignore` FIRST: sidecar binaries, `release/`, `dist/`,
  `backend/src/generated/`) — an 86 MB binary once landed in vm-poppy's git history.
- **Stale-sidecar trap:** after ANY backend/infra/lambda change, rebuild the sidecar and
  fully restart AgentsPoppy, or deploys silently report NO_CHANGE with old code.
- No "Claude" co-author trailer on commits (founder IP rule, all poppy repos). No
  force-push, ever (release tags are the audit trail).
- Poppies ship via install-dev + full app restart during dev; the catalogue release
  runbook governs anything public. Keep the backend portable Node (win32 packaging is a
  packaging step, not a rewrite).
- The founder decides product questions; implementation decisions get made here and
  recorded in THIS file in the same change.

## 11. Open items for the founder (blocking only where marked)

- **Screenshots, twice, after release:** the catalogue listing needs them (P6), and the
  product page `agentspoppy.com/affiliatepoppy` shipped deliberately without any (2026-08-20)
  — real, unretouched captures once the live programme has content, served as WebP with
  width/height set (the CrewPoppy page's recipe).
- ~~Teardown must retire the platform portal too~~ — **BUILT 2026-08-22, see Q4a.** Teardown
  now closes the published page (token-authed, before SSM is forgotten) and sweeps the
  app-created Stripe webhook destinations. The promo-code question was ruled the same day
  (founder: *"after the user tears down the poppy, no live coupon should be around"*) and
  built into the same sweep — see Q4a point (3).
- **Closed-programme retention: purge publisher data 12 months after closure (founder,
  2026-08-22 — build before the platform has real merchant volume).** *"After closing a
  program, the publisher data is deleted after 12 months, otherwise the database risks
  becoming too big."* The plan:
  - A scheduled pass over `portalMerchants` where `closed == true` and
    `closedAt < now − 365 days` (the `closedAt` field already exists, written at close):
    delete `signups/*` (with their `entries` subcollections), `refs/*`, `subs/*`, and
    finally the merchant tombstone doc itself.
  - Deleting the doc **returns the name to the pool** — and that is now SAFE, because the
    purge is precisely the removal of what the no-revival rule protects (the publisher list
    a re-claimant would otherwise inherit). No-revival becomes "no revival for 12 months".
  - Copy must tell the truth once this exists: the closed page's "everything you earned
    stays recorded here" gains "for 12 months", and the hosting terms at
    `affiliates.agentspoppy.com/terms` state the retention window. (Also a good GDPR
    answer: publisher emails are personal data; indefinite retention after a programme
    ends is the wrong default anyway.)
  - Rename tombstones (`movedTo`) are NOT covered — they redirect to a living programme
    and stay as long as it does; only closure starts the clock.
  - Mechanism candidate: a token-guarded API route on agentspoppy-web hit by a daily
    Cloud Scheduler job (same pattern available to the commerce plane) — decided at build
    time, not here.

1. ~~Name + id~~ — **decided 2026-08-14: AffiliatePoppy / `com.affiliatepoppy.desktop`,
   final.** See the header note.
2. **The poppy's own price** (free-while-proving vs paid day one; premium tier price) —
   blocks P6.
3. ~~Affiliate terms text default~~ — **done 2026-08-14**: Settings offers "Give me a starting
   point", generated from the live numbers (commission, discount, renewals) with the
   merchant-only parts marked `[Fill in: …]`. His words before listing still apply — for
   AgentsPoppy's own programme he edits that text.

---

## 12. Build log — what exists, and what it cost to learn (2026-08-14)

P0–P4 were built in one pass. This section is the honest state of the code, so the next
session (or the founder) can tell built-and-tested from built-and-unproven.

### 12.1 Implementation decisions taken here (they refine §3–§5, and win where they differ)

| # | Decision | Why |
|---|---|---|
| I1 | Attribution maps BOTH the human code (`code#`) and Stripe's promotion-code **id** (`promo#`) to the affiliate. | A webhook payload is never expanded: `session.discounts[].promotion_code` is `promo_1234`, not `OLIVER7K3M`. Mapping only the human code would have silently attributed **nothing** in production. |
| I2 | Running totals live in their OWN partition (`pk=tot`, `sk=aff#<id>#<cur>`), not under each affiliate. | The admin's Ledger tab needs everyone's totals at once: one Query instead of one per affiliate. An affiliate reading their own total is still a single GetItem. |
| I3 | Every credit is a **DynamoDB transaction**: the ledger row (conditional put) + the totals update, together. Refunds re-read and move by the difference under an optimistic condition. | Two separate writes would drift the moment a Lambda died between them — the kind of drift nobody notices until an affiliate disputes a payout. The conditional put inside the transaction is also what makes a webhook redelivery a no-op. |
| I4 | Payouts are recorded under `pk=payouts` with a caller-supplied `batchId`, conditional put. | Same one-Query reason as I2, and the batch id (generated once when the dialog opens) makes a double-click or a retried request record ONE payment. |
| I5 | Each credit also writes `ref#<id>` rows for the payment intent, invoice and session. | `charge.refunded` names a charge — never the checkout session the sale was keyed on. Without these, refunds would find nothing to reverse. |
| I6 | The Stripe REST calls are hand-written over `fetch` (no `stripe` SDK); the webhook signature is verified with `node:crypto`. | Three endpoints. The SDK would be a megabyte inside a Lambda zip and a supply-chain surface on the path that holds the merchant's API key. |
| I7 | Secrets live in SSM **outside** the stack, tagged by hand, deleted first by teardown. | A CloudFormation parameter is kept in stack history and readable via DescribeStacks forever. Tagging is what makes them visible to the host's leaves-no-trace sweep. |
| I8 | The receiver's role can read ONLY the signing secret; the portal's role ONLY the API key. | The receiver is reachable by the whole internet and has no business creating promotion codes. |
| I9 | Enrolment is idempotent and self-healing: the portal calls it on every sign-in, and a record with no code gets one. | A signup that half-finished (verified email, code issuance failed) would otherwise dead-end with no way for the affiliate to ask and nothing for the merchant to see. |
| I10 | Commerce is NOT declared in the manifest yet. | The premium tier (D13) isn't built; AGENTS.md requires `capabilities` to list only what the frontend actually calls. It gets declared in the same change that adds the buy button. |

### 12.2 A real bug this pass caught (kept as a test)

`JSON.stringify` does **not** escape `</script>`. The portal page embeds merchant-controlled
text (name, offer, terms) into JS string literals, so a merchant whose terms contained that
sequence would have ended the page's own script early and served whatever followed to their
partners. Fixed by escaping `<` as `<`; `portal.test.ts` proves the page renders exactly
one script element and that a hostile merchant name stays *text*. Reverting the escape fails
the test.

**Live, first approval (2026-08-16): `Received unknown parameter: coupon`.** We sent no
`Stripe-Version` header, so Stripe answered in whatever version the *merchant's account*
defaults to — and the founder's account was on one where promotion codes take
`promotion[type]=coupon` + `promotion[coupon]=…` (changed in `2025-09-30.clover`). The fix is
not just the parameter: **the client now pins `STRIPE_API_VERSION`** on every call, so the
wire shape is ours to choose and identical for every merchant, whatever their account is set
to. `stripe-api.test.ts` asserts the header and the exact form body. (Webhook parsing was
untouched — it reads `discounts[].promotion_code`, which survived the change.)

### 12.3 What is built

- **P0** — repo, workspaces, embedded-template deploy pipeline (content-addressed template +
  one zip for both handlers), stack lifecycle with the RECREATE / UPDATE_ROLLBACK_FAILED
  paths, teardown that sweeps the secrets, the deploy bucket and the stack. Manifest: **70
  actions, 10 grants, amber, no beyond-own findings.**
- **P1** — the money path: signature verification, the three events, idempotent transactional
  ledger, `sub#` renewal mapping, proportional refunds. 49 tests, verified by mutation
  (breaking tax-exclusion fails 9; breaking the unpaid-checkout mapping fails 1).
- **P2** — the poppy: Setup (deploy → two secrets with a live Stripe check → the shareable
  link), Affiliates (approve, per-affiliate rate, type-to-confirm retire), Ledger (owed per
  currency, mark-paid guarded against a stale screen, backend-written CSV), Settings, Remove,
  Feedback last.
- **P3/P4** — the hosted portal: Cognito self-signup, verification, sign-in, password reset,
  enrolment, an affiliate's own dashboard, and white-label branding with a live preview.

### 12.4 What is deliberately NOT built

- **P5 (premium: portal on the merchant's own domain).** Needs `edge.ts` ported from
  TrafficPoppy plus `acm`/`cloudfront` grants and `commerce:purchase`.
- **P6 (dogfood + listing)**, including the one-line `allow_promotion_codes` change in
  agentspoppy-web (§7) — that is the founder's own repo and his Stripe.
- **Part-payments.** "Mark as paid" takes the full amount owed; the UI says so.
- **A unit test for `backend/src/program.ts`.** Its rules are covered from both sides — the
  Ledger tab's tests prove the UI refuses a mismatched amount, and `ledger-store` is exercised
  through the money path — but the backend's own re-check (the authoritative one, which
  re-reads live totals so a stale screen cannot record a wrong payout) has no direct test yet.
  Worth adding with a fake DynamoDB client before P6.

### 12.5 Pricing — options under evaluation (founder, 2026-08-14, NOT decided)

The founder's framing: a free tier, then a paid one, and *"what part could we externalise out
of the user infrastructure to better justify the price"*.

**First instinct, and why it is only half right.** Externalising normally costs this family
something: "runs entirely in your own AWS, we never see your sales" is why a merchant picks
this over Rewardful or Tapfiliate, and every piece moved onto our servers spends that argument
AND adds a running bill. TrafficPoppy charges for a feature that runs 100% in the user's own
account — price the work saved, not the hosting.

**But affiliate programmes have TWO parties, and they want opposite things** (founder,
2026-08-14 — the insight that reframes this whole section):

- the **merchant** wants nobody in the data path → keep it in their own AWS;
- the **affiliate** is being asked to trust a ledger kept by *the person who owes them money*.
  Nothing in their own AWS can fix that, because the conflict of interest IS the merchant's
  sole custody of the record.

That is a real barrier to recruiting good affiliates, and it is a problem only a neutral third
party can solve. So the case for externalising here is not cost or convenience — it is
**removing the merchant's conflict of interest**, which makes their programme more attractive
to exactly the people they are trying to sign up. AgentsPoppy is well placed for it: it is
already a party both sides deal with, and it has no stake in either's numbers.

Where AffiliatePoppy has room its siblings never had: there is no visitor data here at all.
The sensitive things are affiliate emails (volunteered partner data) and the commission ledger.

Candidates, ranked by value ÷ (effort + trust cost):

| Candidate | What it buys | Verdict |
|---|---|---|
| **Neutral witness — an independent, append-only record of what was attributed** (detail below) | The affiliate stops having to take the merchant's word for it; the merchant gets a credible programme without surrendering their sales data. | **The strongest case for charging, and impossible to self-host.** See §12.5a. |
| **Affiliate emails from the platform** ("you earned £12", monthly statements, "you've been approved") | Today the portal only sends Cognito's verification mail, capped ~50/day, and a merchant wanting more must verify an SES domain and leave the sandbox — a genuine chore most will never do. | **Best cheap win.** High value, low effort, and only affiliate emails leave the account — never a buyer's. Pairs naturally with the witness. |
| **Watchdog + alerts** ("Stripe stopped reaching your webhook 3 days ago") | Something OUTSIDE their AWS has to notice when their AWS breaks. By definition this cannot live in the thing being watched. | **Strong, cheap, and honest** — the clearest argument for a service rather than a tool. |
| **Affiliate discovery / marketplace across programmes** | Affiliates find merchants; merchants get partners they'd never have recruited. Impossible inside one merchant's account. | **The strategic one.** Turns the poppy into a network with a moat. Biggest build; consider only after P6. |
| **Executed payouts** (Stripe Connect transfers) | Removes the monthly manual chore entirely — the single biggest time saver. | **Highest value, highest load.** Money movement, KYC, disputes. Contradicts D12; revisit only once the ledger has been trusted in the wild for a while. |
| **Self-billing invoices / VAT documents for affiliates** | Real compliance relief in the EU. | Medium value, country-specific. Later. |
| **The ledger or the webhook receiver** | — | **Never.** They are the trust core; moving them makes this an ordinary SaaS competing on someone else's terms. |

A shape that fits without breaking the promise: **free** = everything built today, capped at a
handful of affiliates; **paid** = cap removed + portal on the merchant's own domain (D13,
already the plan) + platform-sent affiliate emails + the watchdog + the neutral witness.

### 12.5a The neutral-witness model (sketch — nothing built, nothing decided)

**What the affiliate actually needs, split honestly into three, because they are not equally
solvable — and promising all three would be a lie we would eventually be caught in:**

| The affiliate's worry | Can a witness answer it? |
|---|---|
| *"Will they quietly edit or delete what I earned?"* — **integrity** | **Yes, completely.** An append-only, timestamped copy held by someone with no stake settles it. |
| *"Will they pay what the record says?"* — **settlement** | **Yes.** Payouts are recorded against the same witnessed entries, so "paid" is checkable, not asserted. |
| *"Will they record every sale my code brought in?"* — **completeness** | **No, not fully.** The merchant's own receiver decides what to report. A witness makes suppression *permanent and visible* rather than deniable, and gives an affiliate holding a receipt something concrete to dispute against — but it cannot prove a negative. **Say exactly this in the marketing; do not imply more.** |

**How it could work, keeping the merchant's promise intact.** When the receiver credits an
entry, it also POSTs a *minimal* attestation to AgentsPoppy: affiliate id, amount, currency,
day, and a hash of the full entry. Append-only, our timestamp, never editable by the merchant.
What that deliberately does NOT carry: the buyer, the product, the order value, the merchant's
revenue — the platform learns what one affiliate earned, never what the merchant sold.

Consequences to accept before building it:

- **Opt-in per merchant, always.** Turning it on for existing installs would break the exact
  promise they were sold. It is a feature a merchant *chooses* to display: "verified by
  AgentsPoppy" is a recruiting badge, and its value comes from being voluntary.
- **We become a data controller** for affiliate emails and commission amounts: a DPA, a
  retention policy, a deletion path, and a named lawful basis. Today this poppy has none of
  that burden precisely because nothing leaves.
- **We become a party to disputes.** Terms must state plainly what we attest (what we were
  told, and when) and what we do not (that we were told everything).
- **The affiliate-side product this unlocks** is the real prize: one account showing every
  programme someone has joined, across merchants — which is also §12.5's marketplace, arrived
  at from the trust direction instead of the discovery direction.

Sequencing: this is a P7+ idea. It needs the ledger to have been right in the wild first —
a witness to numbers nobody has yet checked is worth nothing.

### 12.6 Feature scope — what the founder asked about, and what D1 permits (2026-08-14)

The founder, before the first deploy: *what data can this collect? I'd like a journey of
events, each with its own compensation. Merchants should see where an affiliate posted
(a YouTube video, an Instagram post). Does the affiliate connect Stripe to be paid?*

**What v1 collects: exactly one signal** — *a Stripe payment happened and carried this
affiliate's code* — from which sales, renewals and refunds are derived. No clicks, no visits,
no signups. That is the direct consequence of D1 (nothing on the merchant's website), not an
oversight; every extension below is judged against it.

**What the incumbents do** (Rewardful, Tapfiliate, FirstPromoter, PartnerStack, Impact — read,
not run): a tracking link + a cookie-setting script, and on top of it multi-event journeys
with a payout per step (click / signup / trial / first payment / renewal / upgrade — fixed,
percentage or nothing per step), attribution windows, first-vs-last click, tiered rates,
multi-tier recruiting, an assets library, fraud checks, and payouts via PayPal / Stripe
Connect / Wise (often merchant-executed, platform-reported). Two gaps worth owning: **none
tracks where an affiliate posted** as first-class data, and none is honest about what the
cookie loses.

**Journeys under D1 — the rule is simple: we can reward any event Stripe emits.**

| Event | Visible? | Source |
|---|---|---|
| Trial started | yes | `customer.subscription.created` (`status=trialing`) with the code |
| First payment | yes (built) | `checkout.session.completed` |
| Renewal | yes (built) | `invoice.paid` via the `sub#` mapping |
| Upgrade / plan change | yes | `customer.subscription.updated` (price change) |
| One-off purchase | yes | `checkout.session.completed`, `mode=payment` |
| Refund / churn | yes (built) / yes | `charge.refunded` / `customer.subscription.deleted` |
| Free signup, click, visit | **no** | Stripe never sees them. Only a signed server-to-server call from the merchant's OWN backend could report them (the S2S postback idea) — cookie-free, but an integration step on the merchant. A separate decision. |

Recommended shape (not decided): a per-programme list of *rewarded events*, each with a
fixed amount and/or a percentage, replacing the single `commissionPct`. Trial → paid →
renewal → upgrade covers what most subscription businesses actually pay for, and it stays
100% webhook-driven. Build the Stripe-shaped journey first; the S2S upstream events only if a
real merchant needs them.

**Placements — "where did they post it?" — BUILT (2026-08-14, founder-shaped).** The portal
has a *"Where you share your code"* card; the affiliate pastes links (YouTube, Instagram,
blog) with an optional note; the merchant sees them per affiliate in the poppy and opens them
in the system browser; they ride along in the export as a second CSV.

The founder's rule, and the reason it works: **optional, and it says so** — the card's first
words are *"Optional — you don't need to fill this in. It's just nice for ⟨merchant⟩ to know
where their code is out there."* Some partners will make the effort because it strengthens the
partnership; the rest lose nothing and feel no pressure. Onboarding stays one form.

Rules baked in: declared, never detected (nothing crawls anyone's channel); http(s) only, so a
pasted `javascript:` link can never run in the merchant's frame when they click it; capped at
20, de-duplicated; the ONLY field an affiliate may change about themselves, written through
its own store method so "the portal can write placements and nothing else" is a property of
the code, not a hope. Honest limit unchanged: it says where the code was posted, never which
post drove which sale — the stronger version (**one affiliate, several codes, one per
placement**) would give real per-content attribution and stays on the list.

**Payouts — the design, and why it is the real trust feature (founder, 2026-08-14).**

Today: nothing. D12 stands — the ledger computes, the merchant pays however they already pay,
and presses "Mark as paid". The affiliate does not connect Stripe at all.

The founder's argument for changing that, which is the strongest trust argument anyone has
made in this project: *"a publisher would feel more comfortable joining a programme where
they're sure they're earning what's expected, because the Stripe balance updates in
realtime"* — and, decisively, **"they don't want to chase the merchants for getting paid"**.

That reframes the whole feature. The affiliate's real pain is not latency, it is **having to
ask**: the "any news on last month's commission?" email, sent to someone who owes you money
and controls the record of what they owe. §12.5a's neutral witness makes the merchant's record
*credible*; money already in the affiliate's own Stripe balance makes it *moot* — there is
nothing left to trust, and nobody to chase. **The unlock is not speed. It is that paying stops
being a decision the merchant makes.**

Four constraints, all real, none fatal:

1. **The merchant must be a Stripe Connect platform.** A balance can only be credited by a
   transfer from a platform to a connected account. AgentsPoppy already is one (it pays poppy
   developers). A typical merchant is not, and applying to become one turns "paste two
   secrets" into "apply to be a payments platform". ⇒ this is a **path, not the default**, and
   a natural premium tier.
2. **The key stops being harmless.** Transfers need `Transfers: Write`, which kills the
   current honest line — *"that key cannot move money, read customers, or refund anything"*.
   ⇒ a SECOND, separate, opt-in key, with the trade-off stated in as many words. Never a
   silent widening of the existing one.
3. **Refunds are why the industry holds commissions.** Once money is in the affiliate's
   balance — and especially once they have paid it out to their bank — a refund needs a
   transfer reversal, which can fail or push them negative. Every incumbent holds 30–60 days
   for exactly this. Instant transfer buys trust and sells clawback risk.
4. **Available balance.** Card money is not available on day 0; a transfer then can simply
   fail for lack of funds.

**The shape that keeps the insight and survives the constraints:** commissions **accrue
visibly** the moment the webhook lands, and transfers fire **automatically on a rule the
merchant sets once** (after N days clear, above €X minimum). The affiliate's portal shows all
three states — *earned · clearing until <date> · sent to your Stripe* — and their real Stripe
balance grows without anyone deciding to pay them. Standard connected accounts, not Express
(see the reasoning above); the transfer originates from the merchant's own Stripe balance;
AgentsPoppy is never in the flow of funds.

**What the incumbents actually do about paying (verified 2026-08-14, not recalled).** Two
distinct tiers, and the gap between them is where this feature would sit:

| Who | How affiliates get paid | Custody of the money |
|---|---|---|
| **Rewardful** (closest comparator) | The merchant downloads a CSV of payment details and uploads it to their OWN PayPal or Wise. Enterprise plans can pay from a connected PayPal Business account. No Stripe-balance option at all. | **None — trust.** "All you need to do is download the list of payment details from your Rewardful dashboard and upload it to PayPal or Wise dashboard." |
| **FirstPromoter** | "Pay all partners in one action via Stripe, PayPal, Wise or bank transfer" — one click, from the merchant's own accounts. | None — but the *rail* is already there, including Stripe. |
| **Tapfiliate** | PayPal / bulk export. | None. |
| **PartnerStack** | The merchant is INVOICED monthly (card or ACH); once it clears, partners withdraw via PayPal or Stripe. | **Yes — escrow.** The network is in the flow of funds. |
| **Impact, ShareASale/Awin/CJ** | Merchant funds a deposit/balance; the network pays affiliates. | **Yes — deposit + reserve.** |

So: **the self-serve tier our product competes with runs on exactly the same trust model we do
today** — the tool tracks, the merchant pays by hand, the affiliate takes the dashboard's word
for it and chases when it is late. The tier that removes the chasing does it by becoming a
middleman that holds the money, which is why it is expensive and why the merchant loses
control of their own funds.

**The consequence for our positioning:** "we pay via Stripe" is NOT the differentiator —
FirstPromoter advertises exactly that. The differentiator is **automatic and rule-based with
nobody in the middle**: the merchant sets the rule once, the transfer fires from their own
Stripe balance into the affiliate's own Stripe balance, and no human decides. Nobody occupies
that square, because reaching it requires the merchant to be a Connect platform — the barrier
described above, and the reason this is a premium path rather than the default.

Sequencing unchanged: after the ledger has been right in the wild. A wrong number that is
displayed is a support email; a wrong number that has been transferred is a clawback.

### 12.6a Hosting the affiliate portal on AgentsPoppy (founder, 2026-08-14 — NOT decided)

The founder's proposal: serve the affiliate portal from AgentsPoppy App Hosting rather than
the merchant's Lambda — *"so it also works as a trustworthy third party in the workflow"* and
so there is something in AgentsPoppy to justify a subscription — while noting *"we don't need
AgentsPoppy to actually save users or data, it could be just that we host the portal"*.

**The distinction that decides this: hosting the page is not the same as vouching for the
numbers.** If we serve the HTML but every figure still comes from the merchant's Lambda
reading the merchant's own table, we are supplying the frame, not the content. A merchant who
edited their ledger would have the edited numbers rendered faithfully — under OUR name, which
is arguably worse than today. Hosting alone is trust theatre; say so plainly rather than sell
it.

**What hosting DOES buy, and one of these is underrated:**

1. **A credible address.** The live portal URL from the first deploy is
   `shlds7algriyngvxnwwfjcwfaa0dxnjz.lambda-url.eu-west-1.on.aws` — it looks like phishing,
   and no publisher will happily type their email into it. `partners.agentspoppy.com/<merchant>`
   is a different conversation. This may justify the work on its own.
2. **One affiliate account across every programme** — but only with hosted IDENTITY, which
   means Cognito leaves the merchant's stack and we hold affiliate emails. That contradicts
   "we don't save users or data", so it is a separate decision, not a consequence of hosting.
3. **An honest subscription line: we run something for them.**

**Three options, in increasing order of what they actually promise:**

| | What we host | What we can honestly claim | Cost to us |
|---|---|---|---|
| **A. Page only** (the founder's version) | HTML/JS; identity stays in the merchant's Cognito; all data stays in their AWS | "A proper address, and a page we keep working" | Small. A route in agentspoppy-web + CORS. No new data duties. |
| **B. Page + identity** | Also affiliate sign-in | Everything in A, plus "one account for every programme you join" — the marketplace foundation | We become a data controller for affiliate emails; a real auth build |
| **C. Page + identity + attestation** (§12.5a) | Also a minimal independent copy of each credit (affiliate, amount, currency, day, hash) | **"Verified by AgentsPoppy"** — our record shown beside the merchant's, and a disagreement is visible to the affiliate | DPA, retention, a dispute role. The real one. |

**Recommendation:** A is worth doing for the address alone, and it is the natural delivery
mechanism for C — but do not market A as trust. C is the version that earns the word
"third party", and B falls out of it.

**The D13 tension, RESOLVED by the founder (2026-08-14): co-brand, don't choose.** *"Even if
the page is hosted by a third party, the merchant branding should be there. It's a bit like
Stripe Checkout, where the checkout is visibly by Stripe, but the merchant also customises it
with his own logo and brand."*

That is the right model and it dissolves the either/or. Stripe Checkout proves the commercial
point: the merchant's logo and colours are front and centre, and a small "powered by Stripe"
tells the buyer who stands behind the transaction. Merchants do not tolerate that mark — they
WANT it, because it raises the counterparty's willingness to go through with the transaction.
Identical dynamic here: "verified by AgentsPoppy" makes a publisher likelier to join, so the
mark works FOR the merchant, not against them. So: merchant's logo, name, colour, offer and
terms exactly as today (D10 survives intact), on a neutral address, with a small assurance
mark.

**The rule that follows, and it decides the premium tier: an assurance mark that can be bought
off is worth nothing.** If a merchant can pay to remove it, then its absence says something
about everyone who didn't pay, and its presence stops meaning anything at all. So premium may
buy *your own domain and your branding dominant* — it may never buy *our mark removed*. (Same
as Stripe: a custom Checkout domain does not buy anonymity.) This also keeps the mark honest:
it is only worth showing where we actually hold the independent record (§12.5a), so it appears
when the attestation feed is on and not otherwise.

**D13 restated:** default = co-branded portal on the neutral AgentsPoppy address, which is
genuinely good rather than a crippled free tier; premium = `partners.yourbrand.com` with the
merchant's branding dominant. The assurance mark rides along either way.

### 12.6b Who else can use this, and what do they have to configure? (founder, 2026-08-14)

The founder's concern: first-party poppy sales run on his own Stripe, but what about **a poppy
developer**, or **someone using AffiliatePoppy for sales somewhere else entirely** — do they
need more setup?

**Checked against `agentspoppy-web/src/app/api/checkout/route.ts`, not assumed.** AgentsPoppy
commerce is **Standard Connect direct charges**: the platform creates the Checkout Session with
`{ stripeAccount: listing.stripeAccountId }`, so the charge lives on the DEVELOPER'S own Stripe
account and the platform takes an application fee. (First-party products charge on the platform
account instead.)

That is the good news, and it falls out for free:

| Who | Works today? | What they configure |
|---|---|---|
| **AgentsPoppy itself** (first-party) | yes | the two secrets, on the platform account |
| **A poppy developer**, on their poppy's sales | **yes — same two secrets, on their OWN Stripe** | Their sales are direct charges on their connected account, so `checkout.session.completed` / `invoice.paid` / `charge.refunded` fire there, their own webhook endpoint receives them, and the coupon AffiliatePoppy creates lives on their account too. Nothing extra. |
| **Anyone selling through Stripe anywhere else** (own site, Checkout, Payment Links, Billing) | yes | the same two secrets. Payment Links have their own "allow promotion codes" switch. |
| **Paddle / Lemon Squeezy / Gumroad / Shopify / App Store** | **no** | Not Stripe. See below. |

**⚠ The one blocker, and it is bigger than §7 said.** The platform's session creation sets no
`allow_promotion_codes`, so **the Stripe Checkout page shows no code field at all** — for
first-party products AND for every developer's products. Until that one line ships, no poppy
sale can carry an affiliate code, by anyone. §7 framed it as "for AgentsPoppy as first
customer"; it is actually **the change that makes AffiliatePoppy usable by the whole developer
base**, and it should be argued that way. (It must stay subscription-only, so D6's
"never on donations" keeps holding structurally.)

**A practical note for anyone setting their commission on poppy sales:** AffiliatePoppy's base
is what the customer paid minus tax — the gross. On a poppy sale the developer also pays
Stripe's processing fee and AgentsPoppy's application fee out of that same gross, so a 10%
commission is more than 10% of what they actually keep. Not a bug (every merchant has
processing fees) but worth saying plainly where a developer picks their number.

**Non-Stripe platforms.** Not supported, and the honest reason is that attribution here is a
Stripe-signed webhook. The architecture does put the seam in the right place, though: only
`shared/src/stripe-events.ts` (parsing) and `shared/src/stripe-api.ts` (code issuance) know
what Stripe is. `attribute.ts`, the ledger, the portal and the poppy are all
platform-agnostic — so a Paddle or Lemon Squeezy receiver is a parallel parser plus a
code-issuer, not a rewrite. Worth doing only when a real merchant asks.

### 12.6c Affiliate commission on poppy sales — the platform economics (founder, 2026-08-14)

The founder, on the note that a developer pays Stripe's fee AND AgentsPoppy's 5% out of the
same gross the commission is computed on: *"not a problem — we can plan to modify our terms
with the poppy developers, where affiliate sales are paid on top of the 5%. We can even warn
the developer to calculate their pricing accounting for the affiliate cut. Developers will
actually be happy to know they can benefit from AgentsPoppy-arranged affiliate campaigns."*

Sound, and standard: app-store fees and affiliate commissions have coexisted this way for
years (Apple's cut, then the affiliate's, both out of the developer's gross). The terms change
is also unusually clean — **no existing sale changes economics**, because affiliate codes do
not exist yet. A new, optional channel appears carrying its own cut; nobody is worse off than
they were yesterday, which is the easiest kind of terms update to make.

**The decision this needs first: who RUNS the programme?** The founder's phrase
"AgentsPoppy-arranged campaigns" implies the second option, which is a different product.

| | Developer-run | **AgentsPoppy-run (central campaigns)** |
|---|---|---|
| Whose affiliates | The developer's own, recruited by them | One publisher signs up ONCE and gets a code that works across participating poppies; AgentsPoppy recruits |
| Whose Stripe | Theirs (direct charges already land there) | Still theirs — the sale is unchanged |
| What it is | AffiliatePoppy exactly as built | A **network** — §12.5's marketplace, arrived at from the economics side |
| Terms say | "Affiliate commission is yours to pay, on top of the 5%" | Plus: what AgentsPoppy charges for running the campaign, and how it settles |
| Effort | ~zero, it exists | Large. Central identity, cross-poppy codes, settlement |

**⚠ The constraint that shapes the second option — verified against the checkout route.** The
platform's `application_fee_amount` / `application_fee_percent` is fixed **when the Checkout
Session is created**, and under D1 the affiliate's code is typed *afterwards*, on Stripe's own
page. So **AgentsPoppy cannot charge a different fee on an affiliate-driven sale** — at session
time we cannot know whether a code will be used. "15% on affiliate sales instead of 5%" is not
achievable as a Stripe application fee.

Central campaigns therefore need **out-of-band settlement**: either the developer's own ledger
pays their affiliates (and terms simply require it), or AgentsPoppy pays the publisher and
invoices the developer monthly for what it advanced. Both work; the second is the one that
makes "one publisher, many poppies" possible, and it is the point at which AgentsPoppy is
holding money on someone's behalf — with everything §12.5a says about that.

**One guard, because D7 does NOT transfer to third parties.** The founder welcomes code
leakage to coupon sites because his own margin absorbs it and he counts it as advertising. A
developer on a thinner margin may not want a publicly-posted code eating sales they would have
made at full price — the classic cannibalisation problem. So: **participation is opt-in per
developer, and the leakage tolerance is theirs to set**, never inherited from the platform's.

**Who pays, DECIDED (founder, 2026-08-14 → D15): the party who emitted the coupon.** *"Once
AgentsPoppy releases coupons, those need to be paid even if they land on a developer's poppy.
Ideally it should be AgentsPoppy paying, as we are the one committing with the publisher — the
party who emitted the coupon should be the one paying it."*

Right, and it is what makes the publisher-side promise real: **one counterparty, who can never
answer "talk to the developer".** But the arithmetic does not close on its own. A €100 poppy
sale through an AgentsPoppy-emitted code (5% off, 10% commission):

| | |
|---|---|
| Customer pays | €95 |
| AgentsPoppy application fee (5% of €95) | **+€4.75** |
| AgentsPoppy pays the publisher (10% of €95) | **−€9.50** |
| **AgentsPoppy net** | **−€4.75** — a loss on every such sale |
| Developer nets | €90.25, on a sale they did not have to find |

**D15b — the recovery, and it is the founder's own "on top of the 5%":** the developer
reimburses the commission on sales that came through an AgentsPoppy campaign. Then it is
coherent from all three sides: the publisher deals only with AgentsPoppy and never chases;
the developer pays for a sale they would not otherwise have had; AgentsPoppy stays at its 5%
and carries the float and the credit risk (which is real — a developer who does not pay leaves
the platform out of pocket, since the publisher has already been paid).

**D15c — the reimbursement must be AUTOMATIC (founder, 2026-08-14):** *"AgentsPoppy cannot
spend time and resources chasing developers to be reimbursed."* The same principle he applied
to publishers, now applied to the platform — and it is what makes the whole arrangement
credible: nobody in this system chases anybody.

**The structural catch:** under direct charges the platform NEVER holds the developer's money.
The customer pays their connected account, the 5% application fee is taken in that instant,
and that is the only moment of leverage. Nothing is owed to them later, so "net it off what we
owe" does not exist as an option here. (It would exist under destination charges — money
landing on the platform first — but that is a fundamental change to the flow of funds and
makes AgentsPoppy hold everyone's revenue. Rejected for the same reasons as §12.5a's "never in
the flow of funds".)

**The mechanism: a payment method on file, charged monthly.** Opting into central campaigns
means the developer becomes an ordinary Stripe Billing customer OF the platform (card or SEPA
mandate), and commissions advanced on their behalf are collected automatically each month. A
direct debit, not an invoice — nothing to chase.

**The enforcement lever, which is already ours: code minting.** Campaign codes only exist on a
developer's connected account because the platform put them there (see the finding below). So
if a collection fails, the platform simply **stops minting new codes for that developer** —
existing codes keep honouring what publishers have already earned (never punish the publisher
for the developer's default), but the exposure stops growing. Worst case is bounded to one
billing period of that developer's affiliate sales, and can be capped lower.

**What cannot be engineered away, and should be stated rather than discovered:** D15 means the
platform always **pays first and collects second**. That is the entire point — the publisher
must never wait on somebody else's payment — so the credit risk is inherent to the promise,
not a defect in the mechanism. The direct debit and the minting lever are what keep it small.

**Two mechanical findings that make this cheaper than it looks:**

1. **The platform ALREADY receives the events.** Poppy sales are direct charges on connected
   accounts, and agentspoppy-web's webhook already consumes them (that is how entitlements are
   granted today). So central attribution needs no cooperation from the developer, and no
   second webhook — the feed exists.
2. **A coupon lives on ONE account.** A code created on the platform account cannot be redeemed
   at a checkout created on a developer's connected account. So one publisher-facing code must
   be minted as N Stripe promotion codes — the same code string on each participating
   developer's connected account. The platform can already do exactly this kind of
   account-scoped write (it creates Prices on connected accounts today). It also means a
   developer running their OWN AffiliatePoppy sees that sale, finds a code it does not know,
   and correctly ignores it — no conflict between the two programmes.

### 12.6d D15d — when the money actually moves

**The founder's own framing, and it is the right one (2026-08-16):** *"Once they have a ledger
to monitor, they wouldn't really care when the money will be in their pocket — they just need
the certainty of when to expect."* So the design target is **a date, not a delay**. Everything
below follows from that.

**First, the correction that decides where the extra time goes.** A longer wait does *nothing*
about developer default: that risk is governed by the ORDER of the two events and by the
minting lever, not by their distance from the sale. What a longer wait buys is **refund
coverage** — the window in which a sale can come undone before anyone has been paid. So the
delay is chosen from the refund curve; it is not a general safety margin, and stretching it
"to be safe" only makes publishers wait for a reason that is not true.

**The schedule — one sentence a publisher can hold in their head.** *Sales in a month are paid
on the 10th of the month after next.*

| When | What happens |
|---|---|
| Sale, in month M | Ledger entry opens as **Pending**, showing the exact date it will pay. |
| 1st of M+2 | The whole month-M cohort clears. Refunds before this simply cancel the entry — no money has moved. Cohort marked **Approved**, and the participating developers are **direct-debited** for it. |
| 10th of M+2 | Debits have settled. Publishers are **paid**. |

A sale on the 1st waits ~70 days; one on the 31st waits ~40. Both are paid on the same,
knowable date. The nine days between collection and payout exist so a debit settles before the
payout leaves — that is the whole point of the ordering.

**Three rules that carry the "never default" weight — none of them is the delay:**

1. **Collect before paying, always.** The platform never sends money it has not already
   received. This is the ordering, and it is what turns a month of float into nine days.
2. **A collection instrument that cannot be reversed underneath us.** SEPA **Core** direct
   debit lets the payer claw the money back for **eight weeks, no reason given** — which would
   silently reopen the risk after the publisher has been paid. So developer collection uses a
   **card** or a **SEPA B2B mandate** (no refund right, but the developer's bank must confirm
   the mandate). This detail matters more than any amount of waiting.
3. **A rolling reserve for the tail.** Card *disputes* run to 120 days, so a reversal will
   occasionally land after payout at any sane schedule. Rather than make every publisher wait
   four months for a rare event, hold back a small rolling reserve per publisher (one cycle's
   earnings, released when they leave the programme) and net late reversals against it.

**The one case that is deliberately NOT protected, because protecting it would break D15.** If
a developer's debit fails on the 1st, the publisher is still paid on the 10th. Making the
payout conditional would reintroduce exactly what D15 removed — a publisher waiting on somebody
else's payment. What happens instead is that minting stops for that developer immediately, so
the loss is capped at that single cohort. That is the bounded worst case, and it is a choice,
not an oversight.

**What this asks of the product:** the certainty has to be visible, or it is not certainty. The
ledger must show each entry as Pending / Approved / Paid **with the date it will pay** — which
is a small extension of what AffiliatePoppy already stores, and the single most valuable thing
the portal can show a publisher who is deciding whether to trust the programme.

### 12.6e D15e — the self-dealing attack, and the one rule that kills it

**The founder found it (2026-08-16):** *"a developer could sign up as an affiliate as well,
record many sales of his own poppy and request a refund for all of them, so he cashes out as a
publisher and AgentsPoppy loses."* This is the classic affiliate fraud, and it is worth working
through the arithmetic rather than reaching for a policy.

**A completed self-dealt sale already loses money**, on a €100 poppy (5% off, 10% commission):

| Fraudster wearing all three hats | |
|---|---|
| Pays, as the fake customer | −€95.00 |
| Receives, as the merchant | +€90.25 |
| Receives, as the publisher | +€9.50 |
| Reimburses, as the developer (D15b) | −€9.50 |
| **Net** | **−€4.75**, plus Stripe's processing fee, which is not returned on a refund |

So the scheme only pays if the **refund** lets them keep the commission. Everything rests on
one question: can a reversal pull cash out of the platform?

**THE RULE: a reversal is a credit, never a payment out.** When a sale is refunded after
payout, the publisher takes a negative entry against future earnings and the developer takes a
credit against their next collection — nobody receives money back. Run the fraud again under
that rule: +€9.50 as the publisher, −€9.50 as the developer, minus the platform fee, minus
Stripe's fee. It loses money every time. It still loses money when two colluding people split
the roles, because one of them has to be the developer paying in. The platform is structurally
immune rather than defended.

(The mild unfairness — a developer who stops selling entirely never uses their credit — is
accepted deliberately, and is how ad platforms handle the same problem.)

**Three cheap additions that close the rest:**

1. **A developer may not be a publisher on their own poppy.** Both identities are known: the
   connected account owns the poppy, the publisher signs up with an account. Refuse to mint
   that code. One rule at minting time, and the naive version is gone.
2. **The clearing period handles the impatient version.** A refund before the 1st of M+2 cancels
   the entry with nothing moved; the attempt costs the fees and returns nothing.
3. **Minting stops on a refund pattern** — the D15c lever, bounding the loss to one cohort of
   one developer.

**The boundary that matters more than any of this.** Every word of D15–D15e concerns the
OPTIONAL central-campaign feature, where AgentsPoppy emits codes on developers' behalf.
**AffiliatePoppy as built carries none of it:** under D12 commissions are computed and reported,
never executed, the merchant pays their own publishers from their own bank, and AgentsPoppy is
never in the money — a merchant who fakes sales against himself is stealing from himself. The
poppy can ship, sell, and never have this half built.

### 12.6g D18 — collect at source (the founder's simplification of D15c)

The application fee on a direct charge is set when the CHECKOUT SESSION is created and is
immutable afterwards; the code box on Stripe's checkout page opens after that moment, which is
why "just add it to the fee" wasn't the original design. The founder's fix: **move the code
entry one screen earlier** — a "Have a code?" field in the poppy's own purchase flow. Then the
platform knows everything at creation time:

- session created with the discount pre-applied (`discounts: [{ promotion_code }]`, not
  `allow_promotion_codes`) and `application_fee_amount = platform fee + commission`;
- for subscriptions, `subscription_data.application_fee_percent = platform % + commission %`
  — renewals then collect by themselves, matching D5;
- on `charge.refunded`, the platform refunds the fee's commission share to the connected
  account (`refund_application_fee` on the proportional amount) so a developer never pays
  commission on a sale that was undone;
- AffiliatePoppy's ledger stays the record: entries collected this way are settled at birth,
  not owed — the "Owed back to you" card is then only for typed-code/legacy sales, if any.

**Timing consequence (founder, 2026-08-16):** with the money collected at the sale, D15d's
debit run and its nine-day settlement gap disappear — the one remaining date is the payout:
**sales in month M pay publishers on the 1st of M+2** (was the 10th). The clearing month is
unchanged; it only ever existed for refunds. The payment-workflow PDF is revised accordingly.

**Where it lives: agentspoppy-web** (whoever creates the checkout owns the fee). The poppy
cannot do this for merchants whose sub-sellers make their own payment links — for them the
report-and-collect card remains the product. What remains of D15c after D18: nothing, for
platform-created checkouts; the payment-method-on-file machinery would only ever return if a
non-platform-created sale path had to be collected automatically.

**Practical guidance to give developers** (mirrors the founder's own D3 move): price with the
affiliate cut in mind before the campaign, not after — he raised AgentsPoppy's prices 15% so
that a 5% customer discount and a 10% commission fit inside the margin rather than eating it.

### 12.6f P7 as built — connected accounts, what to check live

The platform half of D15 that the POPPY can carry (the rest — who pays whom when, direct
debit — stays platform billing and stays on the shelf):

- **Stripe side.** A code lives on one account, so `mintOnPartners()` creates the same string
  on each participating `acct_…` with `Stripe-Account` on the merchant's own restricted key
  (no second key). Coupons live on one account too: `ensurePartnerCoupons()` keeps a coupon at
  the current discount on every partner, and a changed discount re-creates them all. Failures
  are per developer and reported (Setup → "Create any missing codes"), never all-or-nothing:
  the merchant's own account already has the code.
- **Events.** A connected account's sales reach the receiver only through a webhook endpoint
  created as *"Listen to events on connected accounts"*, which signs with its own secret — a
  third SSM parameter, optional; `handleWebhook` verifies against either. The event's
  `account` rides into every instruction; `attribute.ts` puts it on the entry; a refund is
  booked against the account of the SALE (from the ref row), not the refund event.
- **Ledger.** `acct#<account>#<currency>` totals rows move in the same `TransactWriteItems` as
  the entry, so "owed to you by developers" can never disagree with the rows. The CSV gains an
  `account` column. The publisher's view is unchanged — one number, one counterparty.
- **LIVE-VERIFIED (2026-08-16), sale half.** Test-native connected account created by API
  (`type=standard`, business name set at creation — the two traps: a dashboard-made "v2" live
  account is only half-visible from test keys, and Checkout refuses an account with no
  business name). Added through the Connected accounts tab → coupon + code minted there; a
  $20 checkout ON that account (platform-created session, `allow_promotion_codes: true`,
  exactly the agentspoppy-web shape) accepted the code → ONE transaction moved both sides:
  the publisher's sale row ($3.80 at 20%) and "Owed back to you" for that account, same
  figure. Environment discipline was most of the debugging: multiple sandboxes each have
  their own keys AND their own view of which accounts exist — the error's own dashboard URL
  is the reliable pointer to the right one. Refund half verified same day: the
  connected-account refund reversed the publisher's $3.80 AND the account's owed figure to
  zero, in one webhook. P7 gate met in full.
- **ANSWERED live (2026-08-16), in two steps.** The first Add was REFUSED — and the refusal
  was initially masked by our own error handling swallowing Stripe's message (fixed: the UI now
  quotes Stripe verbatim). The reason, per Stripe's restricted-keys docs: a restricted key has
  a SEPARATE permission column for connected accounts (None/Read/Write per resource), and a key
  made with only the account-side "Promotion codes: Write" defaults to None on the Connect
  side. Second refusal, verbatim thanks to the fix: connected-account coupon creation demands
  its own `coupon_write` — on the merchant's OWN account the promotion-codes permission covers
  coupons, on a connected account it does not. So: a restricted key CAN act on connected
  accounts — D11 stands — and the platform recipe is "Promotion codes: Write" AND "Coupons:
  Write" in the Connect column (the base recipe for ordinary merchants is unchanged). The
  Developers card says so, and keys are editable in place — the value doesn't change.

**D17b — adherence is contractual for AgentsPoppy's own use (founder, 2026-08-16):**
*"developers should mandatorily adhere to join any affiliate programme from AgentsPoppy."*
The POPPY keeps per-developer opt-in as the mechanism — any merchant using it decides whose
accounts their codes are minted on. But AgentsPoppy-the-platform exercises that choice by
contract: catalogue membership means accepting developer terms that include participation in
platform-arranged affiliate campaigns (with the D15b reimbursement on top of the 5%, priced in
per the D3 guidance). So for the founder's own install, every catalogue developer's account is
added as a matter of course. This is a terms-of-service change on agentspoppy-web when
campaigns go live — not code in this repo. It also collapses D15's per-developer leakage
concern into the terms: a developer who objects to coupon-site leakage prices it in or doesn't
list, rather than half-joining.

### 12.7 Live-only risks — what the first real deploy is actually testing

Every one of these is a class of failure the family has hit before, and none of them can be
proven on a laptop:

1. **The deploy itself** — a grant we didn't know CloudFormation needed (the TTL calls, the
   tag reads, `GetUserPoolMfaConfig`) fails the create and rolls it back.
2. **The public Function URLs** — both permission statements are declared, but only a real
   anonymous request proves Stripe can reach the receiver.
3. **Cognito self-signup + COGNITO_DEFAULT email** — that a verification email actually
   arrives, and that the ~50/day ceiling behaves as documented.
4. **A real Stripe test-mode checkout** — that a redeemed code credits exactly once, and that
   a renewal (which carries no discount at all) still finds its affiliate.
5. **`npm run certify`** — leaves-no-trace, including the SSM parameters, which no other
   poppy in the family has had to sweep before.
