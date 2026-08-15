# AffiliatePoppy

Run an affiliate programme from **your own AWS account**, straight off your own Stripe — an
[AgentsPoppy](https://agentspoppy.com) poppy.

An affiliate shares their code. When a customer uses it at your checkout, the sale is
credited to that affiliate and the commission lands in a ledger you own. Nothing is added to
your website, no cookie is set on anyone, and no customer detail is ever stored.

- **No cookies, so it works when visitors click "reject".** Attribution happens at checkout —
  a redeemed code — not on the visitor's device. Consent-banner refusals, Safari's 24-hour
  cookie cap, phone-to-desktop journeys: none of them lose the affiliate their commission.
- **Nothing to install on your site.** Not a script tag, not a pixel. It is a Stripe webhook
  into your own AWS. A site with no banner today adds a full affiliate programme and still has
  no banner tomorrow.
- **A hosted signup page your partners use, wearing your name.** Share one link. People
  enrol, verify their email, get their own code and watch their earnings — you never build a
  page or send a code by hand.
- **No customer data at rest.** The ledger holds an amount, a currency, a date and an opaque
  Stripe reference. Your affiliates are partners who gave you an email on purpose; your
  customers are nobody's business.
- **Your economics, your rules.** Discount, commission, per-affiliate rates, whether renewals
  earn, whether signups need approval — all set in the app, stored in your account.
- **Cents a month.** Two Lambdas, one table, one sign-in directory, billed per use. $0 while
  nothing happens.

**Status: built and tested; first live deploy pending.** [`DESIGN.md`](DESIGN.md) is the source
of truth — the product, every decision with its reason, the architecture, and an honest build
log of what exists and what doesn't yet.

## Repo layout

```
extension.json   the AgentsPoppy manifest — permissions are name-scoped to AffiliatePoppy*
infra/           the CloudFormation template, as typed TypeScript (no cdk)
lambdas/         the Stripe receiver (attribution + ledger) and the affiliate portal
shared/          the pure core: commission maths, Stripe parsing, signature check, keys
backend/         the poppy's backend: deploy, secrets, admin operations, teardown
frontend/        the merchant's admin, inside AgentsPoppy
scripts/         build the embedded backend bundle, validate the manifest, draw the icon
```

`npm install` · `npm test` · `npm run typecheck` · `npm run validate-manifest` ·
`npm run build` · `npm run install-dev` (dev-install into a local AgentsPoppy).

## License

Source-available under the **[PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0/)**
— see [`LICENSE`](./LICENSE). Read it, run it, self-host it, change it, and use it for any
purpose *except* building a product that competes with AffiliatePoppy or with any other
product we provide using it. The AffiliatePoppy name and brand are not licensed with the code.

(`frontend/src/poppy.css` is the AgentsPoppy design kit, vendored in under its own MIT
header — that file keeps its MIT terms.)
