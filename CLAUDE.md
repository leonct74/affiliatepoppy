# CLAUDE.md — AffiliatePoppy

Operating guide for working in this repo. **`DESIGN.md` is the source of truth** — read it
fully before any work; when a design decision changes, update DESIGN.md in the same change.

> **Boundary:** AffiliatePoppy is a standalone project that runs *on* AgentsPoppy (never
> forks it — FSL non-compete). The traffic-poppy, vm-poppy and mailpoppy repos are
> READ-ONLY reference material: copy patterns from them, never modify them from here.

## What this is

Affiliate/referral program management running **entirely in the merchant's own AWS**:
coupon-code attribution from the merchant's own Stripe webhooks (no cookies, no script tag
on their site, no customer data at rest), a hosted white-label affiliate signup portal +
dashboard, and a commission ledger — deployed as ONE CloudFormation stack by the poppy's
sidecar. Free core + one premium tier (portal on the merchant's own domain). Full
rationale, founder-locked decisions D1–D14, and phases P0–P6: `DESIGN.md`.

## Read these before coding (in order)

1. `DESIGN.md` (this repo) — the product, the invariants, the plan.
2. `~/Projects/agentspoppy/AGENTS.md` — the framework contract. Hard requirements.
3. Reference implementations to REUSE, not reinvent:
   - `~/Projects/traffic-poppy` — the closest sibling and primary donor: repo layout,
     `scripts/build-backend-bundle.mjs` (embedded-template deploy pipeline),
     `backend/src/stack.ts` (stack lifecycle + updateAvailable watching BOTH keys),
     `infra/src/template.ts` (parameters + UserPoolTags lesson),
     `lambdas/src/viewer-page.ts` + `auth.ts` (hosted self-contained pages + Cognito),
     `backend/src/edge.ts` (custom-domain premium tier), test harnesses.
   - `~/Projects/vm-poppy` — DESIGN.md DR1–DR6 lessons (packed-policy budget, assessor
     substring false-reds), SEA sidecar build incl. `--win32`.
   - `~/Projects/agentspoppy/docs/RELEASING-POPPY.md` — the release runbook; its order is
     load-bearing.

## Non-negotiables (digest — DESIGN.md + AGENTS.md are authoritative)

- **Privacy invariants:** no buyer identifiers at rest, ever (no name/email/IP/UA in any
  row). Affiliate emails are partner data, volunteered at signup. No cookies, no
  client-side anything on the merchant's website — attribution is Stripe-webhook-only,
  signature-verified.
- **Trust rule:** attribution and ledger writes happen server-side from verified Stripe
  events; portal identity comes exclusively from the verified Cognito JWT. Affiliates can
  never write or read anyone else's numbers.
- **Idempotency:** ledger keys are Stripe object ids; webhook redelivery must be a no-op.
  Deterministic keys everywhere — never `new Date()` as a key.
- Secrets (webhook signing secret, restricted promo-codes-only API key) live in the
  merchant's SSM SecureString under `/affiliatepoppy/*` — never in DynamoDB, never echoed
  back to the frontend, never on our servers.
- **Rating:** amber accepted (Lambda execution role); every grant name-scoped
  `AffiliatePoppy*`/`affiliatepoppy-*` or tagged-as-self. Declare only actions the backend
  actually calls (packed-policy budget). Verify with the real `validate-manifest`.
- Teardown hook + three attribution tags on every resource; `npm run certify` must pass a
  real deploy→use→teardown before any catalogue listing.
- Feedback tab mandatory as the LAST tab (sync-feedback-tab.mjs vendored element,
  `bugsUrl`, `host:openExternal`); design kit; plain language; instant spinners;
  type-to-confirm destructive actions; background+resume; costs visible in-app; CSV
  downloads written by the BACKEND (sandboxed frontends cannot download).

## Gotchas inherited from the poppy family (each cost real debugging time)

1. **🪤 A stale `backend/index.cjs` masks Lambda/template changes.** It EMBEDS the generated
   template and both Lambda handlers, so after ANY change under `infra/` or `lambdas/` you
   must `npm run build` AND fully restart AgentsPoppy — otherwise the deploy silently reports
   NO_CHANGE against old code. (No SEA sidecar here: we run on the host's shared node22
   runtime, so `backend/index.cjs` is the whole artifact.) To check what actually shipped,
   decode `lambdaZipBase64` out of it and read the zip members — plain grep won't see inside.
2. **Never `git add -A` after building** — `.gitignore` build artifacts FIRST (`release/`,
   `dist/`, `backend/index.cjs`, `backend/src/generated/`). An 86 MB binary once landed in
   vm-poppy's history.
3. Some template errors only fail on a REAL deploy (Fn::GetAtt class) — P0's gate is a
   real deploy + certify, not a template review.
4. Renewal invoices carry no discount when the coupon is `duration=once` — renewals are
   attributed via the `sub#<subscriptionId>` mapping written at first checkout
   (DESIGN.md §4.3). Skipping it silently turns recurring commission into first-only.

## Working agreements (live AWS + Stripe)

- **Explicit founder confirmation before any command that creates/changes/deletes live
  AWS or Stripe resources.** Read-only calls are fine. Live tests run in the founder's
  test account (the P1 live-test setup) → tear down afterwards
  and verify clean.
- No "Claude" co-author trailer on commits. No force-push — release tags are the audit
  trail.
- The founder decides product questions; implementation questions get decided here and
  recorded in DESIGN.md.

## Commands

`npm install` · `npm run typecheck` · `npm run test` · `npm run gen:backend` ·
`npm run build` (frontend + `backend/index.cjs`) · `npm run validate-manifest` ·
`npm run sync-feedback` / `check-feedback` · `node scripts/make-icon.mjs` ·
`npm run pack` · `npm run install-dev` · `npm run certify`

The backend runs on the host's SHARED Node runtime (`backend.runtime: "node22"`), so there is
no SEA sidecar to build — `backend/index.cjs` IS the artifact, and it embeds the template and
both Lambda handlers.

## Status

**P0–P4 built, 198 tests green, manifest amber — but NEVER deployed.** See DESIGN.md §12 for
the build log, the decisions taken while implementing (I1–I10), the one real bug the tests
caught, and the live-only risks.

The next step is the one that matters: **ask the founder to approve ONE real deploy** into the
founder's test account, then `npm run certify`, then P5 (premium domain) and
P6 (dogfood + listing). Nothing here is proven until that deploy happens — every sibling repo
learned its worst lesson on the first live run, not on the bench.

Name and id are FINAL: **AffiliatePoppy / `com.affiliatepoppy.desktop`** (founder,
2026-08-14) — never rename, the id is every install's identity. Remaining founder item: the
poppy's own pricing (blocks P6 only).
