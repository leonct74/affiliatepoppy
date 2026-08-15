# AffiliatePoppy — DESIGN.md (source of truth)

> **Status (2026-08-14): P0–P4 built and green on the bench; NOT yet deployed to a real
> account.** 188 tests pass, the manifest rates amber with no beyond-own findings, and the
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
every async control, background+resume — never a dead spinner after app restart):

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
   CSV export — **the backend writes the file and reveals it** (family trap: sandboxed
   poppy frontends cannot download; `<a download>` silently no-ops).
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
approves ONE real deploy** to the test account (675546221165 / eu-west-1, the P1 live-test
setup); then teardown + `certify` PASSES. *Gate: leaves-no-trace certified on day one, not
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

1. ~~Name + id~~ — **decided 2026-08-14: AffiliatePoppy / `com.affiliatepoppy.desktop`,
   final.** See the header note.
2. **The poppy's own price** (free-while-proving vs paid day one; premium tier price) —
   blocks P6.
3. Affiliate terms text default (template provided; his words before listing).

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

**Placements — "where did they post it?"** Cheap and differentiating: the portal gains a
*"Where I share my code"* list (URLs the affiliate pastes — YouTube, Instagram, blog); the
merchant sees them per affiliate and can open them. Honest limits: *declared*, not detected,
and it says where the code was posted, never which post drove which sale. The stronger
version fits D1 exactly: **one affiliate, several codes, each tagged with a placement** —
which gives real per-content attribution, the thing cookie platforms only approximate.

**Payouts.** The affiliate does NOT connect Stripe today (D12: compute and report, merchant
pays as they already pay people). When payouts are executed, it is with **Stripe Connect
Standard accounts, not Express** (founder question, 2026-08-14 — Express was named first by
reflex, because the incumbents use it, and that is the wrong reason):

- *Standard* = the affiliate's own full Stripe account, onboarded and KYC'd by Stripe directly,
  liable for itself. A content creator with real revenue already has one — connecting it is one
  authorisation. No per-account platform fee.
- *Express* = an account the platform creates and largely operates for them: the platform is
  responsible for identity gaps, disputes, negative balances and the support that follows, and
  pays Stripe monthly per active account. That is exactly the liability D12 exists to avoid.

Flow of funds, when built: **merchant → affiliate directly** — the merchant's own Stripe
(also Standard) originates the transfer and we only trigger it. AgentsPoppy never holds the
money; the "your money never touches us" story survives intact. The alternative (merchant →
AgentsPoppy → affiliate, separate charges and transfers) puts us in the flow of funds and is
rejected. Still the heaviest row in §12.5's table. Later, deliberately.

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
