// Developers selling through the merchant's Stripe PLATFORM — P7.
//
// For most merchants this card is irrelevant and says so in one line. It exists for the
// AgentsPoppy case (and any marketplace like it): sales by third-party developers land on
// THEIR Stripe connected accounts, and a promotion code lives on one account — so for the
// merchant's affiliate codes to work at a developer's checkout, each code has to be minted on
// that developer's account too, and the developer's sale events have to reach the receiver.
//
// Two things the merchant does here, both optional, both explained in the card:
//   a. a SECOND webhook endpoint in Stripe — the "connected accounts" kind — with its own secret;
//   b. the list of participating developers, one connected-account id at a time (opt-in: a
//      developer's tolerance for leaked codes is theirs to set, never inherited — D15's guard).
//
// The money rule stays D15: the merchant pays the publisher whatever account the sale was on;
// what a developer owes back is REPORTED on the Ledger tab, never collected by this poppy.

import { useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import type { DeploymentStatus, Partner, ProgramConfig, SyncReport } from "./types";

export function Developers(props: {
  status: DeploymentStatus | null;
  config: ProgramConfig | null;
  onChanged: () => Promise<void>;
}) {
  const { status, config } = props;
  const [open, setOpen] = useState(false);
  const [partners, setPartners] = useState<Partner[]>(config?.stripe.partners ?? []);
  const [secret, setSecret] = useState("");
  const [account, setAccount] = useState("");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPartners(config?.stripe.partners ?? []), [config?.stripe.partners]);

  const connectSaved = !!config?.secrets.connectSecret?.stored;
  const inUse = partners.length > 0 || connectSaved;

  const describe = (r: SyncReport) =>
    r.failures.length
      ? `Created ${r.minted} code${r.minted === 1 ? "" : "s"}; ${r.failures.length} couldn't be created — see below.`
      : r.minted
        ? `Created ${r.minted} code${r.minted === 1 ? "" : "s"} on developers' accounts.`
        : "Every code is already on every developer's account.";

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
    <div className="card stack">
      <div className="spread">
        <strong>4. Developers selling through your Stripe platform (optional)</strong>
        <span className={`badge${inUse ? " ok" : ""}`}>
          <span className="dot" /> {inUse ? `${partners.length} developer${partners.length === 1 ? "" : "s"}` : "Not used"}
        </span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Only for a Stripe <strong>platform</strong> — a marketplace where other people's products are sold through
        their own connected accounts. If that isn't you, skip this: your affiliate codes already work on everything
        you sell yourself.
      </p>
      {!open ? (
        <div>
          <button className="btn btn-sm" onClick={() => setOpen(true)}>
            {inUse ? "Manage developers" : "I run a platform — set this up"}
          </button>
        </div>
      ) : (
        <div className="stack">
          {error && <div className="banner err">{error}</div>}
          {message && <div className="banner info">{message}</div>}

          <div className="card card-2 stack">
            <div className="spread">
              <strong style={{ fontSize: 13 }}>a. A second webhook, for your developers' sales</strong>
              <span className={`badge${connectSaved ? " ok" : ""}`}>
                <span className="dot" /> {connectSaved ? "Saved" : "Needed"}
              </span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Stripe sends a developer's sales only to a webhook made for connected accounts. In Stripe →{" "}
              <strong>Developers → Webhooks → Add destination</strong>, choose <strong>Connected accounts</strong> (not
              "Your account"), the same three events as step 2, and the same address:
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

          <div className="card card-2 stack">
            <strong style={{ fontSize: 13 }}>b. Which developers take part</strong>
            <p className="muted" style={{ margin: 0 }}>
              Your restricted key needs two extra permissions for this, in the <strong>Connect</strong> column of the
              key's permissions: <strong>Promotion codes — Write</strong> and <strong>Coupons — Write</strong> (Stripe
              treats them as separate things on connected accounts). You can edit the existing key — its value
              doesn't change.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              Each developer opts in — add their connected account id (it starts with <span className="chip">acct_</span>;
              Stripe → Connect → Accounts). Every affiliate code is then created on their account too, so it works at
              their checkout. You pay the publisher as usual; what the developer owes you back is shown on the
              Ledger tab.
            </p>
            {partners.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                {partners.map((p) => (
                  <div key={p.account} className="spread" style={{ borderTop: "1px solid var(--poppy-border)", paddingTop: 6 }}>
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
                          return `Removed. Codes on ${p.label || p.account} were retired; what they owe you stays on the ledger.`;
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid-2">
              <label className="field">
                <span>Connected account id</span>
                <input className="input mono" value={account} placeholder="acct_…" onChange={(e) => setAccount(e.target.value)} />
              </label>
              <label className="field">
                <span>What you call them</span>
                <input className="input" value={label} maxLength={60} placeholder="e.g. Olly's Tools" onChange={(e) => setLabel(e.target.value)} />
              </label>
            </div>
            <div className="row">
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
                Add developer
              </Button>
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
        </div>
      )}
    </div>
  );
}
