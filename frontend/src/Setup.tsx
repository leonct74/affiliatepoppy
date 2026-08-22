// The Setup tab — the guided path from "nothing" to "affiliates can join".
//
// Three steps, in the order they must actually happen: create the storage, connect Stripe,
// share the link. Each step shows whether it is done from the LIVE state (the stack, the
// stored secrets, the coupon) rather than from anything remembered, so closing the window
// mid-way and coming back lands exactly where the merchant left off (AGENTS.md §5).
//
// Plain language is doing real work here: the merchant is being asked for two Stripe secrets,
// which is the scariest thing this poppy ever asks. So each one says what it is, where to get
// it, what it can do, and where it will be kept.

import { useState } from "react";
import { api } from "./api";
import { AutoWebhooks } from "./AutoWebhooks";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { WEBHOOK_API_VERSION } from "../../shared/src/stripe-events";
import { host } from "./host";
import { ago } from "./money";
import type { DeploymentStatus, ProgramConfig } from "./types";

/** The restricted key's permission, as Stripe's key page groups it (live lesson, 2026-08-20:
 *  the page groups resources and greys the granular rows — Billing is the group that holds
 *  coupons and promotion codes, and it contains nothing that can move money). */
const KEY_PERMISSION = "Billing — Write";
/** D20: the second group, which lets the app create its webhooks itself (step b's one click). */
const WEBHOOK_KEY_PERMISSION = "Webhook Endpoints — Write";

export function Setup(props: {
  status: DeploymentStatus | null;
  config: ProgramConfig | null;
  onDeploy: () => Promise<void>;
  onConfigChanged: () => Promise<void>;
}) {
  const { status, config } = props;
  const deployed = status?.phase === "ready";
  const stripeConnected = !!config?.secrets.apiKey.stored && !!config?.stripe.couponId;
  const webhookSaved = !!config?.secrets.webhookSecret.stored;
  // D20: the permanent address is THE link once claimed; the Lambda URL is the fallback.
  const shareLink = config?.portal.url || status?.portalUrl || "";

  return (
    <div className="stack">
      <Step
        n={1}
        title="Create the storage in your AWS account"
        done={deployed}
        // AGENTS.md §9 "show the money": say what it costs, and celebrate the $0 state.
        note="One click creates a small database, two tiny web services and a sign-in directory for your affiliates. Typically under $1 a month — you're billed per use, so it's $0 while nothing is happening."
      >
        {!deployed && (
          <Button className="btn btn-primary" busyLabel="Starting…" onClick={props.onDeploy}>
            {status?.phase === "failed" ? "Try again" : "Set up AffiliatePoppy"}
          </Button>
        )}
        {deployed && <p className="muted" style={{ margin: 0 }}>Running in {status?.region}.</p>}
      </Step>

      <Step
        n={2}
        title="Connect your Stripe account"
        done={stripeConnected && webhookSaved}
        note="AffiliatePoppy reads your own Stripe to see which sales used an affiliate's code. Nothing is installed on your website, and no customer details are ever stored."
      >
        {!deployed ? (
          <p className="muted" style={{ margin: 0 }}>Finish step 1 first.</p>
        ) : (
          <StripeConnect status={status} config={config} onSaved={props.onConfigChanged} />
        )}
      </Step>

      <Step
        n={3}
        title="Share the link with people who want to promote you"
        done={deployed && !!shareLink && stripeConnected}
        note="Anyone with this link can apply to join your affiliate programme. They get their own code, and can check what they've earned at any time — you don't have to build a page or send anything by hand."
      >
        {shareLink ? (
          <>
            <div className="row">
              <span className="chip" style={{ overflowWrap: "anywhere" }}>{shareLink}</span>
              <CopyButton text={shareLink} label="affiliate link" />
              <button className="btn btn-sm" onClick={() => void host.openExternal(shareLink)}>
                Open it
              </button>
            </div>
            {/* D20: once the permanent address exists, IT is the link — everywhere. Until
                then, say so instead of letting the raw Lambda URL look like the product
                (founder, 2026-08-22: "it still shows the random lambda link"). */}
            {!config?.portal.slug && (
              <p className="muted" style={{ margin: "8px 0 0" }}>
                This is the technical address — it works, but it's ugly and changes if you ever rebuild. Claim your
                free permanent one (affiliates.agentspoppy.com/your-name) in <strong>Settings → Get your permanent
                address</strong>; it will replace this link everywhere.
              </p>
            )}
            {!stripeConnected && (
              <p className="muted" style={{ margin: "8px 0 0" }}>
                People can sign up already — they'll get their code as soon as Stripe is connected.
              </p>
            )}
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Your link appears here once step 1 finishes.</p>
        )}
      </Step>

      {config?.stripe.lastEventAt ? (
        <div className="banner info">
          Stripe last talked to you <strong>{ago(config.stripe.lastEventAt)}</strong>
          {config.stripe.livemode ? " (live mode)" : " (test mode)"}.
        </div>
      ) : (
        deployed &&
        webhookSaved && (
          <div className="banner info">
            Waiting to hear from Stripe. The first message arrives with your next sale — or send a test event from
            the webhook page in Stripe.
          </div>
        )
      )}
    </div>
  );
}

function Step(props: {
  n: number;
  title: string;
  done: boolean;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card stack">
      <div className="spread">
        <strong>
          {props.n}. {props.title}
        </strong>
        <span className={`badge${props.done ? " ok" : ""}`}>
          <span className="dot" /> {props.done ? "Done" : "To do"}
        </span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {props.note}
      </p>
      {props.children}
    </div>
  );
}

/**
 * The two secrets. Each is saved on its own, because a merchant will realistically fetch them
 * from Stripe one at a time — and because saving the API key immediately proves it works,
 * which is the whole point of doing it here rather than discovering it later.
 */
function StripeConnect(props: {
  status: DeploymentStatus | null;
  config: ProgramConfig | null;
  onSaved: () => Promise<void>;
}) {
  const { config, status } = props;
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (which: "apiKey" | "webhookSecret", value: string, clear: () => void) => {
    setError(null);
    setMessage(null);
    try {
      const result = await api.saveSecret(which, value);
      clear();
      await props.onSaved();
      if (which === "apiKey") {
        if (result.connection?.ok) {
          setMessage(
            `Saved and checked — your key works${result.connection.livemode ? " (live mode)" : " (test mode)"}.`,
          );
        } else {
          setError(result.connection?.message ?? "Saved, but Stripe wouldn't accept that key.");
        }
      } else {
        setMessage("Saved.");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="stack">
      {error && <div className="banner err">{error}</div>}
      {message && <div className="banner info">{message}</div>}

      {/* Stripe keeps test and live completely separate — a fact people discover the hard
          way. Say it once, up front, so the merchant picks a mode on purpose. */}
      <div className="banner info">
        <strong>You can set this up in Stripe's test mode or in live mode — one at a time, never both.</strong>{" "}
        To practise safely, switch Stripe to <strong>Test mode</strong> (top right) and do every step there:
        sales are made with fake cards and nothing real moves. When you're ready for real money, first tear the
        test setup down on the <strong>Remove</strong> tab, then start again here in live mode with fresh keys
        and webhooks. The teardown matters because this poppy keeps one ledger — mixing pretend commissions
        with real ones would make it worthless as your record.
      </div>

      <div className="card card-2 stack">
        <div className="spread">
          <strong style={{ fontSize: 13 }}>a. A restricted key — the one thing to fetch from Stripe</strong>
          <span className={`badge${config?.secrets.apiKey.stored ? " ok" : ""}`}>
            <span className="dot" /> {config?.secrets.apiKey.stored ? "Saved" : "Needed"}
          </span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          In Stripe, open <strong>Developers → API keys → Create restricted key</strong>. Stripe walks you
          through three screens:
        </p>
        <ol className="muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <strong>How will you use it?</strong> — pick the <em>"for my own use"</em> option (no website needed).
          </li>
          <li>
            <strong>Permissions</strong> — the resources come in groups, and single rows like "Promotion codes" may
            be greyed out; that's normal. Set the <strong>Billing</strong> group to <strong>Write</strong> (it holds
            the discount coupons and promotion codes this app creates), and set <strong>Webhook Endpoints</strong> to{" "}
            <strong>Write</strong> too — that second one lets the app set up its webhooks for you in step b, with no
            forms. Nothing that can move money: charges, refunds and payouts are separate groups that stay at
            "None", like everything else.
          </li>
          <li>
            <strong>Only if you run a marketplace</strong> (the Connected accounts tab): both groups have a
            second column, <strong>Connected accounts</strong> — set the Billing one to Write too, so your codes can
            be created on your sellers' accounts. A key can be edited later in Stripe if you're unsure — its value
            doesn't change.
          </li>
        </ol>
        <p className="muted" style={{ margin: 0 }}>
          The two permission groups, spelled the way Stripe spells them:
        </p>
        <div className="row">
          <span className="chip">{KEY_PERMISSION}</span>
          <span className="chip">{WEBHOOK_KEY_PERMISSION}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          That key can create discount codes and manage its own webhooks, nothing else — it cannot move money, read
          customers, or refund anything. It's kept encrypted in your own AWS account, and it is never shown again
          once saved.
        </p>
        <label className="field">
          <span>
            Restricted key
            {config?.secrets.apiKey.hint
              ? ` (saved, ends ${config.secrets.apiKey.hint} — ${config.stripe.couponId ? (config.stripe.livemode ? "live" : "test") + " mode" : "not checked yet"})`
              : ""}
          </span>
          <input
            className="input mono"
            value={apiKey}
            placeholder="rk_…"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <div className="row">
          <Button
            className="btn btn-primary btn-sm"
            busyLabel="Saving & checking…"
            disabled={!apiKey.trim()}
            onClick={() => save("apiKey", apiKey, () => setApiKey(""))}
          >
            Save key
          </Button>
          {config?.secrets.apiKey.stored && (
            <Button
              className="btn btn-sm"
              busyLabel="Checking…"
              onClick={async () => {
                setError(null);
                setMessage(null);
                const result = await api.checkStripe();
                await props.onSaved();
                if (result.ok) setMessage(`Your key works${result.livemode ? " (live mode)" : " (test mode)"}.`);
                else setError(result.message ?? "Stripe wouldn't accept that key.");
              }}
            >
              Check it again
            </Button>
          )}
        </div>
        {config?.stripe.couponId && (
          <p className="muted" style={{ margin: 0 }}>
            Your discount is set up in Stripe ({config.settings.discountPct}% off). Every affiliate's code points at
            it.
          </p>
        )}
      </div>

      <div className="card card-2 stack">
        <div className="spread">
          <strong style={{ fontSize: 13 }}>b. The webhooks</strong>
          <span className={`badge${config?.secrets.webhookSecret.stored ? " ok" : ""}`}>
            <span className="dot" /> {config?.secrets.webhookSecret.stored ? "Saved" : "Needed"}
          </span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          A webhook is how Stripe tells this app about each sale and refund — without one, nothing can be counted.
          Two ways to set it up:
        </p>
        <div className="row" style={{ gap: 8 }}>
          <span className="badge ok"><span className="dot" /> Recommended</span>
          <span className="muted" style={{ fontSize: 12 }}>Let the app create them — one press, configured correctly.</span>
        </div>
        <AutoWebhooks onDone={props.onSaved} />
        <details>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
            Or do it yourself in Stripe's dashboard — the full manual steps
          </summary>
          <div className="stack" style={{ marginTop: 10 }}>
            <p className="muted" style={{ margin: 0 }}>
              In Stripe, open <strong>Developers</strong> (bottom-left of the sidebar, or press <span className="chip">⌘/</span> and
              type it) → <strong>Webhooks</strong> → <strong>Add destination</strong>. Stripe asks a few questions along the way —
              here is every answer: when it asks whose events to listen to, choose <strong>"Your account"</strong> (the
              "Connected accounts" kind is only for marketplaces — it has its own card on the Connected accounts tab). When it
              asks which <strong>API version</strong>, pick <span className="chip">{WEBHOOK_API_VERSION}</span> — the
              version this app is tested against (an endpoint keeps its version forever, so this is a one-time choice, and
              "latest" would mean an untested one). Choose the events{" "}
              <span className="chip">checkout.session.completed</span>, <span className="chip">invoice.paid</span> and{" "}
              <span className="chip">charge.refunded</span>. Into the field Stripe calls <strong>"Endpoint URL"</strong>,
              paste exactly this address (the copy button below puts it on your clipboard): Name and description
              are just labels for your own dashboard — write anything. Stripe then shows you a signing secret starting with{" "}
              <span className="chip">whsec_</span> — paste that below.
            </p>
            {status?.receiverUrl && (
              <div className="row">
                <span className="chip" style={{ overflowWrap: "anywhere" }}>{status.receiverUrl}</span>
                <CopyButton text={status.receiverUrl} label="webhook address" />
              </div>
            )}
            <label className="field">
              <span>Signing secret{config?.secrets.webhookSecret.hint ? ` (saved, ends ${config.secrets.webhookSecret.hint})` : ""}</span>
              <input
                className="input mono"
                value={webhookSecret}
                placeholder="whsec_…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setWebhookSecret(e.target.value)}
              />
            </label>
            <div>
              <Button
                className="btn btn-primary btn-sm"
                busyLabel="Saving…"
                disabled={!webhookSecret.trim()}
                onClick={() => save("webhookSecret", webhookSecret, () => setWebhookSecret(""))}
              >
                Save signing secret
              </Button>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
