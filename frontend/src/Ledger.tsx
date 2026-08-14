// The Ledger tab — what is owed, to whom, and what has already been paid.
//
// AffiliatePoppy computes and reports; it never moves money (D12). So "Mark paid" is a
// RECORD of something the merchant did in their bank or in Stripe, and the UI says exactly
// that — a button that looked like it paid someone would be a dangerous lie.
//
// The CSV is written by the BACKEND and its path shown here: a poppy frontend runs in a
// sandboxed frame where a download link silently does nothing.

import { useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { money, parseAmount } from "./money";
import type { Affiliate, Payout } from "./types";

export function Ledger(props: { affiliates: Affiliate[]; loading: boolean; onChanged: () => Promise<void> }) {
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<{ path: string; rows: number } | null>(null);
  const [paying, setPaying] = useState<{ affiliate: Affiliate; currency: string; owedCents: number } | null>(null);

  const load = async () => {
    try {
      setPayouts((await api.payouts()).payouts);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  /** Everything owed, per currency — the number a merchant actually plans around. */
  const owedByCurrency = new Map<string, number>();
  for (const a of props.affiliates) {
    for (const t of a.totals) owedByCurrency.set(t.currency, (owedByCurrency.get(t.currency) ?? 0) + t.owedCents);
  }
  const owing = props.affiliates
    .flatMap((a) => a.totals.map((t) => ({ affiliate: a, totals: t })))
    .filter((row) => row.totals.owedCents > 0)
    .sort((a, b) => b.totals.owedCents - a.totals.owedCents);

  if (props.loading) {
    return (
      <div className="card row">
        <span className="spinner" /> <span className="muted">Loading the ledger…</span>
      </div>
    );
  }

  return (
    <div className="stack">
      {error && <div className="banner err">{error}</div>}

      <div className="card stack">
        <h2 className="section-title">Owed right now</h2>
        {owedByCurrency.size === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Nothing owed. Commissions appear here as soon as someone buys with an affiliate's code.
          </p>
        ) : (
          <div className="row">
            {[...owedByCurrency].map(([currency, cents]) => (
              <span key={currency} style={{ fontSize: 22, fontWeight: 650 }}>
                {money(cents, currency)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card stack">
        <div className="spread">
          <h2 className="section-title" style={{ margin: 0 }}>
            Who you owe
          </h2>
          <Button
            className="btn btn-sm"
            busyLabel="Writing the file…"
            onClick={async () => {
              setError(null);
              try {
                setExported(await api.exportCsv());
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Export everything as a spreadsheet
          </Button>
        </div>
        {exported && (
          <div className="banner info">
            Saved <strong>{exported.rows}</strong> rows to <span className="chip">{exported.path}</span>
          </div>
        )}

        {owing.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Nobody is waiting to be paid.
          </p>
        ) : (
          owing.map(({ affiliate, totals }) => (
            <div
              key={`${affiliate.affId}-${totals.currency}`}
              className="spread"
              style={{ borderTop: "1px solid var(--poppy-border)", paddingTop: 10 }}
            >
              <div>
                <strong>{affiliate.displayName}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  earned {money(totals.earnedCents, totals.currency)}
                  {totals.refundedCents > 0 && ` · refunded −${money(totals.refundedCents, totals.currency)}`}
                  {totals.paidCents > 0 && ` · already paid ${money(totals.paidCents, totals.currency)}`}
                </div>
              </div>
              <div className="row">
                <strong>{money(totals.owedCents, totals.currency)}</strong>
                <button
                  className="btn btn-sm"
                  onClick={() => setPaying({ affiliate, currency: totals.currency, owedCents: totals.owedCents })}
                >
                  Mark as paid
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card stack">
        <h2 className="section-title">Payments you've recorded</h2>
        {payouts.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Nothing recorded yet.
          </p>
        ) : (
          [...payouts]
            .sort((a, b) => (a.day < b.day ? 1 : -1))
            .map((p) => {
              const who = props.affiliates.find((a) => a.affId === p.affId);
              return (
                <div key={p.batchId} className="spread" style={{ fontSize: 13 }}>
                  <span>
                    {p.day} · {who?.displayName ?? p.affId}
                    {p.note && <span className="muted"> — {p.note}</span>}
                  </span>
                  <span className="mono">{money(p.amountCents, p.currency)}</span>
                </div>
              );
            })
        )}
      </div>

      {paying && (
        <MarkPaidDialog
          affiliate={paying.affiliate}
          currency={paying.currency}
          owedCents={paying.owedCents}
          onCancel={() => setPaying(null)}
          onConfirm={async (amountCents, note, batchId) => {
            setError(null);
            try {
              await api.markPaid({ affId: paying.affiliate.affId, currency: paying.currency, amountCents, note, batchId });
              setPaying(null);
              await props.onChanged();
              await load();
            } catch (e) {
              setError((e as Error).message);
              throw e;
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Recording a payment. Two things make this safe rather than merely careful:
 *  · the amount must match what is owed (the backend re-checks against live totals, so a
 *    stale screen cannot record a figure that was true five minutes ago);
 *  · the confirm carries a reference generated ONCE per dialog, so a double-click or a
 *    retried request records one payment rather than telling an affiliate they were paid twice.
 */
function MarkPaidDialog(props: {
  affiliate: Affiliate;
  currency: string;
  owedCents: number;
  onCancel: () => void;
  onConfirm: (amountCents: number, note: string, batchId: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState((props.owedCents / 100).toFixed(2));
  const [note, setNote] = useState("");
  // Generated once, when the dialog opens — that is what makes the confirm idempotent.
  const [batchId] = useState(() => `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const parsed = parseAmount(amount);
  const matches = parsed === props.owedCents;

  return (
    <div className="scrim" onClick={props.onCancel}>
      <div className="modal stack" onClick={(e) => e.stopPropagation()}>
        <strong>Record a payment to {props.affiliate.displayName}</strong>
        <p className="muted" style={{ margin: 0 }}>
          This records that <strong>you have already paid them</strong> — AffiliatePoppy never moves money. Pay them
          however you normally do, then note it here so the ledger stays right.
        </p>
        <label className="field">
          <span>Amount ({props.currency.toUpperCase()}) — they are owed {money(props.owedCents, props.currency)}</span>
          <input className="input mono" value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
        </label>
        {!matches && (
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Record the full amount owed. Part-payments aren't supported yet — the ledger would stop matching what you
            actually sent.
          </p>
        )}
        <label className="field">
          <span>Note (optional) — e.g. "bank transfer, ref 8842"</span>
          <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="row">
          <Button
            className="btn btn-primary"
            busyLabel="Recording…"
            disabled={!matches}
            onClick={() => props.onConfirm(parsed, note, batchId)}
          >
            I've paid this
          </Button>
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
