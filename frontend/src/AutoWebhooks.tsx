// D20: the "skip the forms" button. One press asks the backend to create every webhook
// destination the programme currently needs — receiver, connected accounts (once partners
// exist), the platform ledger feed (once published) — with the merchant's own key, the
// right scope, the pinned API version and the right events. The report speaks in
// sentences; a key without webhook permission gets the exact edit to make, and the manual
// cards remain right below as the fallback.

import { useState } from "react";
import { api } from "./api";
import { Button } from "./Button";

type Report = { created: string[]; skipped: string[]; problems: string[] };

export function AutoWebhooks(props: { label?: string; onDone: () => Promise<void> }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setReport(null);
    try {
      const r = await api.autoWebhooks();
      setReport(r);
      if (r.created.length) await props.onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <Button className="btn btn-primary btn-sm" busyLabel="Asking Stripe…" onClick={run}>
          {props.label ?? "Create the webhooks for me"}
        </Button>
        <span className="muted" style={{ fontSize: 12 }}>
          Uses your saved key. Needs "Webhook Endpoints — Write" on it; otherwise the manual steps below still work.
        </span>
      </div>
      {error && <div className="banner err">{error}</div>}
      {report && (
        <div className="stack" style={{ gap: 4 }}>
          {report.created.map((line) => (
            <div key={line} className="banner info">✓ {line}</div>
          ))}
          {report.problems.map((line) => (
            <div key={line} className="banner err">{line}</div>
          ))}
          {report.skipped.map((line) => (
            <div key={line} className="muted" style={{ fontSize: 12 }}>{line}</div>
          ))}
          {report.created.length === 0 && report.problems.length === 0 && report.skipped.length === 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              Nothing to create yet — finish the storage step first.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
