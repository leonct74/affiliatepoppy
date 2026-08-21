// The Connected accounts tab — P7, in the product's own words.
//
// AffiliatePoppy is sold to any merchant, so nothing here says "developers": the people with
// connected accounts might be developers on AgentsPoppy, sellers on a crafts marketplace, or
// instructors on a course platform. The tab is only for a merchant who runs a Stripe
// PLATFORM — everyone else is told in one line that they can ignore it.
//
// What it does: a promotion code lives on ONE Stripe account, so a code that should also work
// at a connected account's checkout has to be created there too. Adding an account here
// cascades the programme to it — the discount coupon and every affiliate code are created on
// that account, and its sales reach the receiver through a second, "connected accounts"
// webhook. Each account is added by hand, one at a time: whether a sub-seller wants leaked
// coupon codes eating their margin is their call, so participation is explicit (D15's guard).
//
// The money rule stays D15/D12: the merchant pays the publisher whatever account the sale
// landed on; what a connected account owes back is REPORTED on the Ledger tab, never
// collected by this poppy.

import { useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import type { DeploymentStatus, Partner, ProgramConfig, SyncReport } from "./types";

export function ConnectedAccounts(props: {
  status: DeploymentStatus | null;
  config: ProgramConfig | null;
  onChanged: () => Promise<void>;
}) {
  const { status, config } = props;
  const [partners, setPartners] = useState<Partner[]>(config?.stripe.partners ?? []);
  const [secret, setSecret] = useState("");
  const [account, setAccount] = useState("");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPartners(config?.stripe.partners ?? []), [config?.stripe.partners]);

  const connectSaved = !!config?.secrets.connectSecret?.stored;
  const stripeReady = !!config?.stripe.couponId;

  const describe = (r: SyncReport) =>
    r.failures.length
      ? `Created ${r.minted} code${r.minted === 1 ? "" : "s"}; ${r.failures.length} couldn't be created — see below.`
      : r.minted
        ? `Created ${r.minted} code${r.minted === 1 ? "" : "s"} on your connected accounts.`
        : "Every code is already on every account.";

  const run = async (work: () => Promise<string | null>) => {
    setError(null);
    setMessage(null);
    try {
      const note = await work();
      await props.onChanged();
      if (note) setMessage(note);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="stack">
      <div className="card stack">
        <h2 className="section-title">Connected accounts</h2>
        <p className="muted" style={{ margin: 0 }}>
          You only need this tab if you run a <strong>marketplace with Stripe connected accounts</strong> — a platform
          where others sell through their own Stripe accounts under yours. Adding an account here cascades your
          programme to it: your discount and every affiliate code are also created on that account, so the codes work
          on its products too — and its sales are counted like your own. If that's not how your Stripe is set up,
          you can ignore this tab entirely.
        </p>
      </div>

      {!stripeReady ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>Connect your Stripe on the Setup tab first.</p>
        </div>
      ) : (
        <>
          {error && <div className="banner err">{error}</div>}
          {message && <div className="banner info">{message}</div>}

          <div className="card stack">
            <div className="spread">
              <h2 className="section-title" style={{ margin: 0 }}>Accounts in your programme</h2>
              {partners.length > 0 && (
                <Button
                  className="btn btn-sm"
                  busyLabel="Checking every code…"
                  onClick={() =>
                    run(async () => {
                      const r = await api.syncCodes();
                      setReport(r);
                      return describe(r);
                    })
                  }
                >
                  Create any missing codes
                </Button>
              )}
            </div>
            {partners.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                None yet. Add the first one below — you'll need its account id, which starts with{" "}
                <span className="chip">acct_</span> (Stripe → Connect → Accounts).
              </p>
            ) : (
              partners.map((p) => (
                <div key={p.account} className="spread" style={{ borderTop: "1px solid var(--poppy-border)", paddingTop: 8 }}>
                  <div>
                    <strong>{p.label || p.account}</strong>
                    {p.label && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{p.account}</span>}
                    {!p.couponId && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        No discount on this account yet — save Settings again to create it.
                      </div>
                    )}
                  </div>
                  <Button
                    className="btn btn-sm btn-ghost"
                    busyLabel="Removing…"
                    onClick={() =>
                      run(async () => {
                        const r = await api.removePartner(p.account);
                        setPartners(r.partners);
                        return `Removed. Codes on ${p.label || p.account} were retired; anything it owes you stays on the ledger.`;
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))
            )}
            {report && report.failures.length > 0 && (
              <div className="banner err stack" style={{ gap: 4 }}>
                {report.failures.map((f, i) => (
                  <div key={i}>
                    <strong>{f.affiliate}</strong> on {f.label || f.account}: {f.message}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card stack">
            <h2 className="section-title">Add an account</h2>
            <p className="muted" style={{ margin: 0 }}>
              Your restricted key needs two permissions in its <strong>Connect</strong> column for this:{" "}
              <strong>Promotion codes — Write</strong> and <strong>Coupons — Write</strong>. You can edit the existing
              key in Stripe — its value doesn't change.
            </p>
            <div className="grid-2">
              <label className="field">
                <span>Connected account id</span>
                <input className="input mono" value={account} placeholder="acct_…" onChange={(e) => setAccount(e.target.value)} />
              </label>
              <label className="field">
                <span>A name you'll recognise</span>
                <input className="input" value={label} maxLength={60} placeholder="e.g. Olly's Tools" onChange={(e) => setLabel(e.target.value)} />
              </label>
            </div>
            <div>
              <Button
                className="btn btn-primary btn-sm"
                busyLabel="Adding and creating codes…"
                disabled={!account.trim()}
                onClick={() =>
                  run(async () => {
                    const r = await api.addPartner(account, label);
                    setPartners(r.partners);
                    setReport(r.sync);
                    setAccount("");
                    setLabel("");
                    return `Added. ${describe(r.sync)}`;
                  })
                }
              >
                Add account
              </Button>
            </div>
          </div>

          <div className="card stack">
            <div className="spread">
              <h2 className="section-title" style={{ margin: 0 }}>The second webhook — how their sales reach you</h2>
              <span className={`badge${connectSaved ? " ok" : ""}`}>
                <span className="dot" /> {connectSaved ? "Saved" : "Needed"}
              </span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Stripe only sends a connected account's sales to a webhook made for them. In Stripe →{" "}
              <strong>Developers → Webhooks → Add destination</strong>: when it asks whose events, choose{" "}
              <strong>Connected accounts</strong> (not "Your account") — that choice is what makes this endpoint
              different. Keep the suggested (latest) API version, tick the same three events as Setup step 2, and use
              the same address:
            </p>
            {status?.receiverUrl && (
              <div className="row">
                <span className="chip" style={{ overflowWrap: "anywhere" }}>{status.receiverUrl}</span>
                <CopyButton text={status.receiverUrl} label="webhook address" />
              </div>
            )}
            <label className="field">
              <span>
                Its signing secret
                {config?.secrets.connectSecret?.hint ? ` (saved, ends ${config.secrets.connectSecret.hint})` : ""}
              </span>
              <input className="input mono" value={secret} placeholder="whsec_…" onChange={(e) => setSecret(e.target.value)} />
            </label>
            <div>
              <Button
                className="btn btn-primary btn-sm"
                busyLabel="Saving…"
                disabled={!secret.trim()}
                onClick={() =>
                  run(async () => {
                    await api.saveSecret("connectSecret", secret);
                    setSecret("");
                    return "Saved.";
                  })
                }
              >
                Save signing secret
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
