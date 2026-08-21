// The Affiliates tab — who is in the programme, who is waiting, and what each of them earns.
//
// Two actions here change something in the outside world (they call Stripe), so both follow
// the family rules: an instant spinner on the control itself, and — for retiring a code, which
// people's income depends on — a deliberate confirmation that names exactly what will happen
// and what will NOT (their earnings stay).

import { useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { host } from "./host";
import { money } from "./money";
import type { Affiliate, ProgramConfig } from "./types";

export function Affiliates(props: {
  affiliates: Affiliate[];
  config: ProgramConfig | null;
  loading: boolean;
  /** The sign-up page — shown at the top of the list because the link IS the product. */
  portalUrl?: string;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<Affiliate | null>(null);
  const pending = props.affiliates.filter((a) => a.status === "pending");
  const active = props.affiliates.filter((a) => a.status !== "pending");

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await props.onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (props.loading) {
    return (
      <div className="card row">
        <span className="spinner" /> <span className="muted">Loading your affiliates…</span>
      </div>
    );
  }

  return (
    <div className="stack">
      {props.portalUrl && (
        <div className="card row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 12 }}>Your sign-up link — share it anywhere:</span>
          <span className="row">
            <span className="chip" style={{ overflowWrap: "anywhere" }}>{props.portalUrl}</span>
            <CopyButton text={props.portalUrl} label="affiliate link" />
          </span>
        </div>
      )}
      {error && <div className="banner err">{error}</div>}

      {pending.length > 0 && (
        <div className="card stack">
          <h2 className="section-title">Waiting for you</h2>
          <p className="muted" style={{ margin: 0 }}>
            These people signed up while approval is set to manual. Approving one creates their code in Stripe and
            shows it to them straight away.
          </p>
          {pending.map((a) => (
            <div key={a.affId} className="spread" style={{ borderTop: "1px solid var(--poppy-border)", paddingTop: 10 }}>
              <div>
                <div>
                  <strong>{a.displayName}</strong>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {a.email} · applied {a.createdDay}
                </div>
              </div>
              <Button
                className="btn btn-primary btn-sm"
                busyLabel="Creating code…"
                onClick={() => run(() => api.approve(a.affId))}
              >
                Approve
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="card stack">
        <div className="spread">
          <h2 className="section-title" style={{ margin: 0 }}>
            Your affiliates
          </h2>
          <span className="muted" style={{ fontSize: 12 }}>
            {active.length} active
          </span>
        </div>

        {active.length === 0 && pending.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>
            Nobody has joined yet. Share the link from the Setup tab — that's all it takes.
          </p>
        )}

        {active.map((a) => (
          <Row
            key={a.affId}
            affiliate={a}
            defaultPct={props.config?.settings.commissionPct ?? 0}
            onRate={(pct) => run(() => api.setRate(a.affId, pct))}
            onRetire={() => setRetiring(a)}
          />
        ))}
      </div>

      {retiring && (
        <RetireDialog
          affiliate={retiring}
          onCancel={() => setRetiring(null)}
          onConfirm={async () => {
            await run(() => api.retire(retiring.affId));
            setRetiring(null);
          }}
        />
      )}
    </div>
  );
}

/** "youtube.com" from a link — what a merchant recognises at a glance. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Row(props: {
  affiliate: Affiliate;
  defaultPct: number;
  onRate: (pct: number | null) => Promise<void>;
  onRetire: () => void;
}) {
  const a = props.affiliate;
  const [editingRate, setEditingRate] = useState(false);
  const [rate, setRate] = useState(String(a.pctOverride ?? props.defaultPct));

  return (
    <div style={{ borderTop: "1px solid var(--poppy-border)", paddingTop: 10 }}>
      <div className="spread">
        <div>
          <div className="row">
            <strong>{a.displayName}</strong>
            {a.status === "retired" && <span className="badge">Retired</span>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {a.email}
          </div>
        </div>
        <div className="row">
          {a.code && (
            <>
              <span className="chip">{a.code}</span>
              <CopyButton text={a.code} label="code" />
            </>
          )}
        </div>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        {a.totals.length === 0 ? (
          <span className="muted" style={{ fontSize: 12 }}>
            No sales yet
          </span>
        ) : (
          a.totals.map((t) => (
            <span key={t.currency} className="muted" style={{ fontSize: 12 }}>
              earned {money(t.earnedCents, t.currency)} · owed <strong>{money(t.owedCents, t.currency)}</strong>
            </span>
          ))
        )}
      </div>

      {a.placements?.length > 0 && (
        <div className="stack" style={{ marginTop: 8, gap: 2 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Where they share it:
          </span>
          {a.placements.map((p) => (
            <div key={p.url} className="row" style={{ gap: 6 }}>
              <button
                className="btn btn-sm btn-ghost"
                style={{ padding: "1px 6px" }}
                title={p.url}
                onClick={() => void host.openExternal(p.url)}
              >
                {p.note || hostOf(p.url)} ↗
              </button>
              {p.note && (
                <span className="muted" style={{ fontSize: 11 }}>
                  {hostOf(p.url)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        {editingRate ? (
          <>
            <input
              className="input"
              style={{ width: 90 }}
              value={rate}
              inputMode="decimal"
              onChange={(e) => setRate(e.target.value)}
            />
            <Button
              className="btn btn-sm btn-primary"
              busyLabel="Saving…"
              onClick={async () => {
                await props.onRate(Number(rate));
                setEditingRate(false);
              }}
            >
              Save rate
            </Button>
            <button className="btn btn-sm btn-ghost" onClick={() => setEditingRate(false)}>
              Cancel
            </button>
            {a.pctOverride !== undefined && (
              <Button
                className="btn btn-sm btn-ghost"
                busyLabel="Clearing…"
                onClick={async () => {
                  await props.onRate(null);
                  setEditingRate(false);
                }}
              >
                Use the programme rate
              </Button>
            )}
          </>
        ) : (
          <>
            <span className="muted" style={{ fontSize: 12 }}>
              Commission: {a.pctOverride ?? props.defaultPct}%{a.pctOverride !== undefined ? " (just for them)" : ""}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={() => setEditingRate(true)}>
              Change
            </button>
            {a.status !== "retired" && a.code && (
              <button className="btn btn-sm btn-danger" onClick={props.onRetire}>
                Retire code
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Retiring is the destructive action in this tab, so it takes a deliberate confirmation that
 * names the blast radius (AGENTS.md §4) — and, just as importantly, names what is NOT
 * destroyed: the money they have already earned.
 */
function RetireDialog(props: { affiliate: Affiliate; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [typed, setTyped] = useState("");
  const a = props.affiliate;
  const ready = typed.trim().toUpperCase() === a.code.toUpperCase();

  return (
    <div className="scrim" onClick={props.onCancel}>
      <div className="modal stack" onClick={(e) => e.stopPropagation()}>
        <strong>Retire {a.displayName}'s code?</strong>
        <p className="muted" style={{ margin: 0 }}>
          <span className="chip">{a.code}</span> will stop working at your checkout, so nobody can use it again.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          Everything they've already earned stays exactly as it is, including anything you still owe them.
        </p>
        <label className="field">
          <span>Type the code to confirm</span>
          <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="row">
          <Button className="btn btn-danger" busyLabel="Retiring…" disabled={!ready} onClick={props.onConfirm}>
            Retire this code
          </Button>
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
