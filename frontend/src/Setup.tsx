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
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { Developers } from "./Developers";
import { host } from "./host";
import { ago } from "./money";
import type { DeploymentStatus, ProgramConfig } from "./types";

/** The restricted key's permission, spelled exactly as Stripe's own UI spells it. */
const KEY_PERMISSION = "Promotion codes — Write";

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
        done={deployed && !!status?.portalUrl && stripeConnected}
        note="Anyone with this link can apply to join your affiliate programme. They get their own code, and can check what they've earned at any time — you don't have to build a page or send anything by hand."
      >
        {status?.portalUrl ? (
          <>
            <div className="row">
              <span className="chip" style={{ overflowWrap: "anywhere" }}>{status.portalUrl}</span>
              <CopyButton text={status.portalUrl} label="affiliate link" />
              <button className="btn btn-sm" onClick={() => void host.openExternal(status.portalUrl!)}>
                Open it
              </button>
            </div>
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

      {deployed && stripeConnected && <Developers status={status} config={config} onChanged={props.onConfigChanged} />}

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
        <strong>Test mode or live mode — pick one and stay in it.</strong> Stripe keeps them completely
        separate: a webhook, a secret and a key made in test mode only work with test-mode payments, and vice
        versa. To try things out safely, switch the Stripe dashboard to <strong>Test mode</strong> first (top
        right) and create both items there. Going live later means creating both again in live mode — codes
        issued in test mode don't carry over.
      </div>

      <div className="card card-2 stack">
        <div className="spread">
          <strong style={{ fontSize: 13 }}>a. The webhook address</strong>
          <span className={`badge${config?.secrets.webhookSecret.stored ? " ok" : ""}`}>
            <span className="dot" /> {config?.secrets.webhookSecret.stored ? "Saved" : "Needed"}
          </span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          In Stripe, open <strong>Developers</strong> (bottom-left of the sidebar, or press <span className="chip">⌘/</span> and
          type it) → <strong>Webhooks</strong> → <strong>Add destination</strong>, and paste this address. Choose the events{" "}
          <span className="chip">checkout.session.completed</span>, <span className="chip">invoice.paid</span> and{" "}
          <span className="chip">charge.refunded</span>. Stripe then shows you a signing secret starting with{" "}
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

      <div className="card card-2 stack">
        <div className="spread">
          <strong style={{ fontSize: 13 }}>b. A restricted key, so codes can be created</strong>
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
            <strong>How will you use it?</strong> — pick <em>"Providing this key to a third-party application"</em>.
          </li>
          <li>
            <strong>Website details</strong> — enter <span className="chip">AffiliatePoppy</span> and{" "}
            <span className="chip">https://github.com/leonct74/affiliatepoppy</span>. That's only for Stripe's
            own records.
          </li>
          <li>
            <strong>Permissions</strong> — a long list of resources, each with None / Read / Write. Find{" "}
            <strong>Promotion codes</strong> and set it to <strong>Write</strong>. Leave every other line at "None".
            This is the step that matters — a key created without it can't be fixed afterwards (Stripe keys
            can't be edited), you'd make a new one.
          </li>
        </ol>
        <p className="muted" style={{ margin: 0 }}>
          The one permission, spelled the way Stripe spells it:
        </p>
        <div className="row">
          <span className="chip">{KEY_PERMISSION}</span>
          <CopyButton text={KEY_PERMISSION} label="permission name" />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          That key can create discount codes and nothing else — it cannot move money, read customers, or refund
          anything. It's kept encrypted in your own AWS account, and it is never shown again once saved.
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
    </div>
  );
}
