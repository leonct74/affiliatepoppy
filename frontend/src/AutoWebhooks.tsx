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
  // Rotation invalidates the current secrets, so it never fires on a stray click: the first
  // press arms it and says what it will do; the second press does it (UX rule 2 — a
  // confirmation must explain itself, never just sit disabled).
  const [armRotate, setArmRotate] = useState(false);

  const run = async (action: () => Promise<Report>) => {
    setError(null);
    setReport(null);
    try {
      const r = await action();
      setReport(r);
      if (r.created.length) await props.onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <Button className="btn btn-primary btn-sm" busyLabel="Asking Stripe…" onClick={() => run(() => api.autoWebhooks())}>
          {props.label ?? "Create the webhooks for me"}
        </Button>
        <span className="muted" style={{ fontSize: 12 }}>
          Uses your saved key. Needs "Webhook Endpoints — Write" on it; otherwise the manual steps below still work.
        </span>
      </div>
      <div className="row">
        <Button
          className="btn btn-ghost btn-sm"
          busyLabel="Rotating…"
          onClick={async () => {
            if (!armRotate) {
              setArmRotate(true);
              return;
            }
            setArmRotate(false);
            await run(() => api.rotateWebhooks());
          }}
        >
          {armRotate ? "Press again to rotate now" : "Rotate the signing secrets"}
        </Button>
        <span className="muted" style={{ fontSize: 12 }}>
          {armRotate
            ? "This replaces the secrets of the destinations the app created — new ones are installed in the same step."
            : "For rotating secrets regularly — or to repair the connection if a secret was rolled in Stripe's dashboard."}
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
