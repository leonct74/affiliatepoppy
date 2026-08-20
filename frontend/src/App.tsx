import { useCallback, useEffect, useRef, useState } from "react";
import { Affiliates } from "./Affiliates";
import { api } from "./api";
import { Button } from "./Button";
import { ConnectedAccounts } from "./ConnectedAccounts";
import { Feedback } from "./Feedback";
import { GettingStarted } from "./GettingStarted";
import { host, type AccessState } from "./host";
import { Ledger } from "./Ledger";
import { RemovePanel } from "./RemovePanel";
import { Settings } from "./Settings";
import { Setup } from "./Setup";
import type { Affiliate, DeploymentStatus, Meta, ProgramConfig } from "./types";

// Served from frontend/public → dist root; the same file the manifest declares as our icon.
const icon = "./affiliatepoppy-icon.png";

const POLL_MS = 5_000;
/** How often the ledger numbers refresh by themselves while the programme is open. */
const LEDGER_POLL_MS = 30_000;

type Phase = "loading" | "gate" | "ready";

/**
 * The tabs, in the order a merchant meets them: set it up, see who joined, see what you owe,
 * change the deal, remove it. Feedback is last and never locked — the platform requires it
 * (AGENTS.md §9a), and feedback is not a paid feature.
 */
const SECTIONS = [
  // Affiliates FIRST (founder, 2026-08-14): the destination, not the plumbing. When there is
  // nothing there yet it explains the four steps and points at Setup/Settings.
  { key: "affiliates", label: "Affiliates" },
  { key: "setup", label: "Setup" },
  { key: "ledger", label: "Ledger" },
  // Only for merchants running a Stripe platform; the tab itself says who can ignore it.
  { key: "connected", label: "Connected accounts" },
  { key: "settings", label: "Settings" },
  { key: "remove", label: "Remove" },
  { key: "feedback", label: "Feedback" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

export function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [access, setAccess] = useState<AccessState>("pending");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [config, setConfig] = useState<ProgramConfig | null>(null);
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [loadingAffiliates, setLoadingAffiliates] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [section, setSection] = useState<SectionKey>("affiliates");
  const pollRef = useRef<number | null>(null);

  /**
   * Read the real state out of the merchant's AWS account. This is the ONLY source of truth
   * for where they are (AGENTS.md §5) — nothing is remembered across mounts, so closing the
   * window mid-setup and coming back lands on live progress rather than a dead spinner.
   */
  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setErr(null);
      return s;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  }, []);

  /** The programme itself: settings, branding, and whether Stripe is connected. */
  const loadConfig = useCallback(async () => {
    try {
      setConfig(await api.config());
    } catch {
      // Before the stack exists there is no table to read — not an error worth showing.
      setConfig(null);
    }
  }, []);

  const loadAffiliates = useCallback(async () => {
    setLoadingAffiliates(true);
    try {
      setAffiliates((await api.affiliates()).affiliates);
    } catch {
      setAffiliates([]);
    } finally {
      setLoadingAffiliates(false);
    }
  }, []);

  /** The same read, without the spinner — for background refreshes the merchant didn't ask for. */
  const quietlyReloadAffiliates = useCallback(async () => {
    try {
      setAffiliates((await api.affiliates()).affiliates);
    } catch {
      /* a background refresh that fails says nothing; the next one will try again */
    }
  }, []);

  const connect = useCallback(async () => {
    setErr(null);
    try {
      const state = await host.ensureAccess();
      setAccess(state);
      if (state !== "granted") return;
      setMeta(await api.meta());
      await refresh();
      setPhase("ready");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [refresh]);

  // On mount: if access is already granted, go straight to live state — don't make the
  // merchant re-approve or re-trigger anything they already did.
  useEffect(() => {
    void (async () => {
      try {
        const conn = await host.getConnection();
        if (conn.status === "approved" || conn.status === "active") {
          await connect();
          return;
        }
      } catch {
        /* not connected yet — fall through to the gate */
      }
      setPhase("gate");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the stack is up, load the programme and the people in it.
  useEffect(() => {
    if (phase !== "ready" || status?.phase !== "ready") return;
    void loadConfig();
    void loadAffiliates();
  }, [phase, status?.phase, loadConfig, loadAffiliates]);

  // Once the programme is open, the numbers move because of things that happen in STRIPE —
  // a sale, a refund — not in this window. So refresh them quietly every half minute, and
  // the moment the merchant comes back to the app (live lesson: the founder refunded a test
  // sale in Stripe and only saw the ledger move after quitting and reopening AgentsPoppy).
  useEffect(() => {
    if (phase !== "ready" || status?.phase !== "ready") return;
    const timer = window.setInterval(() => void quietlyReloadAffiliates(), LEDGER_POLL_MS);
    const onReturn = () => {
      if (document.visibilityState === "visible") void quietlyReloadAffiliates();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [phase, status?.phase, quietlyReloadAffiliates]);

  // Poll only while AWS is actually mid-operation, and re-attach automatically on mount if we
  // return to find work still in flight.
  useEffect(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (phase !== "ready" || !status?.inProgress) return;
    pollRef.current = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [phase, status?.inProgress, refresh]);

  // Returns the promise so the Button that triggered it stays spinning until AWS has accepted
  // the request and we've read back the (now in-progress) live state.
  const deploy = async () => {
    setErr(null);
    try {
      await api.deploy();
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (phase === "loading") {
    return (
      <div className="app">
        <Header />
        <div className="card row">
          <span className="spinner" /> <span className="muted">Checking your setup…</span>
        </div>
      </div>
    );
  }

  if (phase === "gate") {
    return (
      <div className="app">
        <Header />
        <div className="card stack">
          <p style={{ margin: 0 }}>
            AffiliatePoppy runs your affiliate programme inside <strong>your own AWS account</strong> — your
            affiliates, their codes and what you owe them stay with you. To set that up, it needs your permission to
            create its own storage there.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            It can only ever touch the things it creates itself, and you can remove all of them in one click.
          </p>
          {access === "denied" && (
            <div className="banner err">
              Access wasn't granted. You can approve AffiliatePoppy in AgentsPoppy and try again.
            </div>
          )}
          {err && <div className="banner err">{err}</div>}
          <div>
            <Button className="btn btn-primary" busyLabel="Waiting for approval…" onClick={connect}>
              Connect my AWS account
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const phaseKey = status?.phase ?? "none";
  /** The table exists and can be read. Everything that queries it hangs off this. */
  const stackReady = phaseKey === "ready";

  return (
    <div className="app">
      <Header />

      {err && (
        <div className="banner err" style={{ marginBottom: 14 }}>
          {err}
        </div>
      )}

      {(phaseKey === "deploying" || phaseKey === "removing") && (
        <div className="card stack">
          <div className="row">
            <span className="spinner" />
            <strong>{phaseKey === "deploying" ? "Setting up in your AWS account…" : "Removing everything…"}</strong>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            This keeps running in your AWS account even if you close this tab or switch to something else — come back
            any time and you'll see where it got to.
          </p>
        </div>
      )}

      {phaseKey === "failed" && (
        <div className="card stack">
          <div className="banner err">{status?.message}</div>
          {status?.failureReason && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              What AWS reported: <span className="mono">{status.failureReason}</span>
            </p>
          )}
        </div>
      )}

      {phaseKey === "ready" && status?.updateAvailable && (
        <div className="card stack">
          <div className="banner info stack" style={{ gap: 10 }}>
            <div>
              <strong>An update is ready for your AWS setup.</strong> This version of AffiliatePoppy adds things your
              deployment doesn't have yet. Your affiliates, their codes and every commission stay exactly as they are
              while it applies.
            </div>
            <div>
              <Button className="btn btn-primary btn-sm" busyLabel="Updating…" onClick={deploy}>
                Update now
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="AffiliatePoppy sections" style={{ marginBottom: 14 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            role="tab"
            aria-selected={section === s.key}
            className={`tab${section === s.key ? " active" : ""}`}
            onClick={() => setSection(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div hidden={section !== "setup"}>
        <Setup
          status={status}
          config={config}
          onDeploy={deploy}
          onConfigChanged={async () => {
            await loadConfig();
            await refresh();
          }}
        />
      </div>
      {/* The three tabs that read the merchant's table only render once it EXISTS. Before
          Setup has run there is nothing to query, and DynamoDB's "resource not found" is
          not a message a merchant should ever be shown for something they haven't done yet. */}
      <div hidden={section !== "affiliates"}>
        {/* Until the programme is open (storage + Stripe) and someone has joined, the first
            tab is the guide: four steps, live state, a button to the right place. After that
            it's the list. */}
        {!stackReady || !config?.stripe.couponId || (affiliates.length === 0 && !loadingAffiliates) ? (
          <GettingStarted status={status} config={config} onGo={(tab) => setSection(tab)} />
        ) : (
          <Affiliates
            affiliates={affiliates}
            config={config}
            loading={loadingAffiliates && affiliates.length === 0}
            onChanged={loadAffiliates}
          />
        )}
      </div>
      <div hidden={section !== "ledger"}>
        <Ledger
          affiliates={affiliates}
          loading={loadingAffiliates && affiliates.length === 0}
          ready={stackReady}
          onChanged={loadAffiliates}
        />
      </div>
      <div hidden={section !== "connected"}>
        {stackReady ? (
          <ConnectedAccounts
            status={status}
            config={config}
            onChanged={async () => {
              await loadConfig();
            }}
          />
        ) : (
          <NotYet what="Connected accounts appear here" />
        )}
      </div>
      <div hidden={section !== "settings"}>
        {stackReady ? <Settings config={config} onSaved={loadConfig} /> : <NotYet what="Settings appear here" />}
      </div>
      <div hidden={section !== "remove"}>
        {status && status.phase !== "none" && (
          <RemovePanel
            disabled={status.inProgress}
            onRemove={async () => {
              await api.teardown();
              await refresh();
              setConfig(null);
              setAffiliates([]);
            }}
          />
        )}
        {status?.phase === "none" && (
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>
              There's nothing to remove — AffiliatePoppy hasn't created anything in your AWS account yet.
            </p>
          </div>
        )}
      </div>
      <div hidden={section !== "feedback"}>
        <Feedback />
      </div>

      {/* Layer the depth: plain path above, exact technical detail one click away
          (AGENTS.md §9 "relocate technical detail, don't delete it"). */}
      <button className="btn btn-ghost btn-sm" onClick={() => setShowDetails((v) => !v)}>
        {showDetails ? "Hide technical details" : "Technical details"}
      </button>
      {showDetails && status && (
        <div className="card card-2" style={{ marginTop: 8 }}>
          <dl className="stack" style={{ margin: 0 }}>
            <Detail label="AWS account" value={meta?.account.accountId} />
            <Detail label="Region" value={status.region} />
            <Detail label="CloudFormation stack" value={status.stackName} />
            <Detail label="Stack status" value={status.stackStatus ?? "not deployed"} />
            <Detail label="DynamoDB table" value={status.tableName ?? "—"} />
            <Detail label="Webhook endpoint" value={status.receiverUrl ?? "—"} />
            <Detail label="Affiliate portal" value={status.portalUrl ?? "—"} />
            <Detail label="Template version" value={status.currentTemplateKey} />
            {status.updateAvailable && <Detail label="Deployed version" value={status.deployedTemplateKey} />}
          </dl>
        </div>
      )}
    </div>
  );
}

/** What a data tab says before there is any data to show. */
function NotYet(props: { what: string }) {
  return (
    <div className="card">
      <p className="muted" style={{ margin: 0 }}>
        {props.what} once AffiliatePoppy is set up — finish the Setup tab first.
      </p>
    </div>
  );
}

function Header() {
  return (
    <>
      <div className="app-header">
        <img src={icon} alt="" />
        <h1>AffiliatePoppy</h1>
      </div>
      <p className="app-sub">
        Your affiliate programme, in your own AWS. No cookies, nothing on your website — just codes and your Stripe.
      </p>
    </>
  );
}

function Detail(props: { label: string; value?: string }) {
  return (
    <div className="spread">
      <span className="muted" style={{ fontSize: 12 }}>
        {props.label}
      </span>
      <span className="chip" style={{ overflowWrap: "anywhere" }}>
        {props.value ?? "—"}
      </span>
    </div>
  );
}
