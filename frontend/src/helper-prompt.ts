// The AI helper prompt (AGENTS.md §9, REQUIRED): onboarding is a prompt, not a manual.
// Instead of teaching the merchant the setup screens, hand them a prompt that IS the
// teaching: they paste it into whatever AI they already talk to, describe their business in
// one sentence, and get back exactly what to click in Stripe and in this poppy, in order.
//
// Built from the LIVE state — the real webhook address, the real portal link, the real
// percentages — so the AI on the other end guides against this install, not a generic one.
// Every Stripe quirk that cost the founder a debugging round-trip on the real setup is in
// here, so the next merchant's AI already knows: the Billing-group permission page, the
// separate Connected-accounts column, the connected-accounts webhook scope, and the
// tear-down-before-going-live rule.

import { WEBHOOK_API_VERSION } from "../../shared/src/stripe-events";
import type { DeploymentStatus, ProgramConfig } from "./types";

export function buildHelperPrompt(status: DeploymentStatus | null, config: ProgramConfig | null): string {
  const receiver = status?.receiverUrl ?? "(shown on the Setup tab after step 1)";
  const portal = status?.portalUrl ?? "(shown on the Setup tab after step 1)";
  const discount = config?.settings.discountPct ?? 5;
  const commission = config?.settings.commissionPct ?? 10;
  const renewals = config?.settings.firstPaymentOnly
    ? "only their FIRST payment earns commission"
    : "renewals keep earning commission for as long as the customer stays";
  const deployed = status?.phase === "ready";
  const stripeConnected = !!config?.secrets.apiKey.stored && !!config?.stripe.couponId;
  const state = !deployed
    ? "Nothing is set up yet — start at step 1."
    : !stripeConnected
      ? "The storage (step 1) is DONE. Stripe (steps 2–3) is still to do."
      : "Storage and Stripe are connected — the programme is open. Steps below are for reference or for going live.";

  return `You are helping me run my affiliate programme with AffiliatePoppy — an app that lives inside AgentsPoppy on my desktop and keeps everything (the ledger, my partners' details) in MY OWN AWS account. People sign up on a page it hosts for me, each gets a personal discount code for my Stripe checkout, and every sale made with a code is counted so I know what commission I owe. I'll tell you where I'm stuck or what I want to do, in my own words. Guide me one step at a time, and ask me at most three short questions if something is unclear.

WHERE I AM RIGHT NOW: ${state}

THE SETUP, IN ORDER (the app's Setup tab shows the same steps):

1. CREATE THE STORAGE — one button ("Create the storage in your AWS account"). It builds everything in my AWS via CloudFormation, takes a couple of minutes, and costs under $1/month (nothing while idle). When it finishes, the tab shows two addresses: my WEBHOOK ADDRESS and my AFFILIATE PAGE link.
   - My webhook address: ${receiver}
   - My affiliate page: ${portal}

2. TEST OR LIVE — ONE AT A TIME. Everything in Stripe below can be done in test mode (fake cards, nothing real) or live mode; the dashboard's test toggle decides. If I practise in test mode, I must tear everything down (the app's Remove tab) before setting up live — the app keeps one ledger, and mixing pretend commissions with real ones would ruin it as a record. Keep me consistent: every Stripe step below must happen in the SAME mode.

3. THE RESTRICTED KEY — the one thing I fetch from Stripe by hand. In Stripe: Developers → API keys → Create restricted key ("for my own use" — no website needed). On the permissions page, resources are GROUPED and individual rows may be greyed out — that's inheritance, not an error:
   - Set the BILLING group to Write (this covers Coupons and Promotion codes — the two things the app actually uses; the Billing group cannot move money, refund, or pay out).
   - Set WEBHOOK ENDPOINTS to Write as well — that lets the app create its webhooks FOR me in step 4, no forms.
   - If I'm a platform (a marketplace where others sell through connected accounts under me): the Billing group's CONNECTED ACCOUNTS column must be Write too — that's what lets my codes work on my sellers' accounts.
   - I paste the rk_… key into the app's Setup tab. The app immediately checks it and says "your key works (test mode)" or "(live mode)" — if the mode is wrong, the key came from the wrong toggle.

4. THE WEBHOOKS. In the app's Setup tab, step b: press "Create the webhooks for me". The app creates every destination it needs with my key — right scope, API version ${WEBHOOK_API_VERSION}, the right events — and stores each signing secret itself. Done.
   - MANUAL FALLBACK (only if my key lacks the webhook permission and I don't want to add it): in Stripe, Developers → Webhooks → Add destination. Scope "Your account", API version ${WEBHOOK_API_VERSION} (never "latest" — an endpoint keeps its version forever and this app is tested against that one), events exactly: checkout.session.completed, invoice.paid, charge.refunded. Endpoint URL = my webhook address above. The signing secret (whsec_…) is pasted into Setup step b's manual card. If I'm a platform: a SECOND identical destination with scope "Connected accounts", its whsec_… pasted in the "Connected accounts" tab.

5. MY DEAL — the Settings tab. Customer discount: currently ${discount}%. Affiliate commission: currently ${commission}% of what the customer actually pays (after their discount, before tax) — and ${renewals}. Also there: approve sign-ups by hand or automatically, a cap on how many affiliates can join, and how my affiliate page looks (my name, logo, colour, offer sentence, and the full terms — the app can draft terms from my numbers if the box is empty).

6. SHARE THE AFFILIATE PAGE. First claim my free PERMANENT ADDRESS in Settings ("Get your permanent address" — affiliates.agentspoppy.com/my-name). Then connect the LEDGER FEED shown under it (one press of its Recommended button, or the manual card) — that is what makes the earnings publishers see there come straight from Stripe, independently of me, which is why they can trust the page. Anyone who opens my address can apply to join: they verify their email, and get their personal code (immediately, or after I press Approve — my choice in Settings; new sign-ups appear in my Affiliates tab within a minute while the app is open, marked "via your public page"). They can check their own earnings on that page any time. I never build a website or send codes by hand. On the free plan the page carries a small "runs on AffiliatePoppy Free" notice; Pro removes it and adds my branding.
   - I can change the address later: Settings has "Change the address". My partners, their codes and their earnings move across with the page, the old address forwards to the new one forever, and one press of the webhook button points Stripe at the new address (until I do, the platform follows the forward, so no commission is lost).

WHAT HAPPENS BY ITSELF AFTERWARDS:
- A sale with a code → the commission appears in the app's Ledger tab within seconds, attributed to the right affiliate at the right rate, in the sale's real currency.
- A refund → the commission is taken back automatically (proportionally for partial refunds).
- Subscriptions → the first payment carries the code; renewals are attributed automatically even though Stripe shows no code on them.
- The Ledger tab shows who I owe, per currency. "Mark as paid" RECORDS a payment I already made from my own bank — the app never moves money, ever. "Export" hands me CSV files of everything via my browser.

HARD RULES — mechanisms, not settings; never suggest working around them, and explain them to me when relevant, because they are why this thing is trustworthy:
- The app can never move, hold, or receive money. It counts. I pay my affiliates myself, and "Mark as paid" just writes down that I did.
- My money ledger and my Stripe secrets live in my own AWS account. The public sign-up page (my permanent address, claimed in Settings) and my publishers' view of their earnings are hosted independently by AffiliatePoppy — on purpose, so publishers can trust numbers I cannot edit.
- The hosting is NEUTRAL (affiliates.agentspoppy.com/terms, accepted at publishing and at joining): AffiliatePoppy hosts the page and the record, nothing more. The programme is mine — who joins, each partner's rate, ending a partnership, and paying what I owe are between me and my publishers; neither side has a claim against AffiliatePoppy, AgentsPoppy or Olly Digital about the other's conduct.
- The Stripe key it holds can only create discount codes/coupons and manage its own webhooks — it cannot charge, refund, read customers, or touch balances. The secrets are stored in my AWS, never shown again in the app.
- Removing the app (its Remove tab) deletes everything it created in my AWS, and cleans up after itself everywhere else: the discount codes stop working, the coupons and webhook destinations it created in Stripe are deleted, and my public page closes (people who joined keep seeing what they earned; if nobody ever joined, the page is taken down and the name freed). Export the ledger first if I want the history.

THINGS THAT GO WRONG, AND THE REAL FIX:
- "Received unknown parameter" or a permission error when approving an affiliate → the restricted key is missing a permission; make/edit the key per step 3 (the app quotes Stripe's exact refusal — read it, it names the missing permission).
- A code is refused at checkout → the checkout and the code are in different worlds: different mode (test vs live), or (platforms only) the checkout belongs to a connected account that isn't added in the app's Connected accounts tab.
- The app says "your key works (test mode)" when I meant live → re-create the key with the test toggle off.
- Ledger shows nothing after a sale → in Stripe's webhook page, check the delivery attempt and its response code; the events list must include the three from step 4.
- A signing secret was rolled in Stripe's dashboard (deliveries now fail signature checks) → Setup step b has "Rotate the signing secrets": armed on the first press, done on the second. It replaces the app-created destinations with fresh ones and stores the new secrets — the only way, since Stripe reveals a secret exactly once. Destinations I made BY HAND can't be rotated by the app: roll them in Stripe and paste the new whsec_… in the manual card.
- Someone joined on my public page but has no code → their code is minted while my app is OPEN (it checks every minute); open the app, and if approval is manual, press Approve in the Affiliates tab.

ANSWER SHAPE: tell me (1) which step I'm on, (2) the exact clicks for MY situation — Stripe's screens change wording, so describe what to look for, not pixel positions, (3) how I'll know it worked, and (4) only then, what comes next. One step at a time.

MY SITUATION: `;
}
