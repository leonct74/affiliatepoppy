// What a merchant sees on the FIRST tab before their programme is open — the whole journey in
// four steps, each read from live state, each a button to the right place.
//
// Founder (2026-08-14): the first tab should be the destination — Affiliates — and when there
// is nothing there yet, explain what to do, in order. Not a wall of Stripe instructions: those
// live in Setup, one click away.
//
// Why "Settings first" wasn't possible: the settings are stored in the merchant's own table,
// which only exists after Setup step 1 has run. So the honest order is storage → Stripe →
// your deal → share the link, and this card says exactly that.

import { HelperBanner } from "./HelperBanner";
import type { DeploymentStatus, ProgramConfig } from "./types";

export type GoTo = "setup" | "settings";

export function GettingStarted(props: {
  status: DeploymentStatus | null;
  config: ProgramConfig | null;
  onGo: (tab: GoTo) => void;
}) {
  const { status, config } = props;
  const deployed = status?.phase === "ready";
  const stripeDone = !!config?.secrets.webhookSecret.stored && !!config?.stripe.couponId;
  // "Decided" = they saved Settings at least once. Until then the programme runs on defaults,
  // which is fine to run on — but a merchant should choose their own numbers deliberately.
  // "The deal" is done when the merchant has a NAME on the page as well as numbers — a
  // portal greeting publishers with no merchant name isn't a decided deal. The detail below
  // says which half is missing (live lesson, 2026-08-20: the founder saved percentages,
  // left the name empty, and had to ask why the step stayed open).
  const nameMissing = !config?.branding.merchantName;
  const dealDecided = !!config?.settings && !nameMissing;

  return (
    <div className="stack">
      <HelperBanner status={props.status} config={props.config} />
      <div className="card stack">
      <div>
        <strong>Nobody has joined yet — here's how to open your programme.</strong>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          Four steps, in this order. Each one tells you when it's done.
        </p>
      </div>

      <Step
        n={1}
        done={deployed}
        title="Create the storage in your AWS account"
        detail="One click. It's where your affiliates, their codes and what you owe them will live."
        action={deployed ? undefined : { label: "Go to Setup", tab: "setup" }}
        onGo={props.onGo}
      />
      <Step
        n={2}
        done={stripeDone}
        title="Connect your Stripe"
        detail="Two things to paste from your Stripe dashboard, so sales made with a code can be counted."
        action={deployed && !stripeDone ? { label: "Go to Setup", tab: "setup" } : undefined}
        onGo={props.onGo}
        blocked={!deployed}
      />
      <Step
        n={3}
        done={dealDecided}
        title="Decide your deal"
        detail={
          deployed && nameMissing && !!config?.settings
            ? 'Almost there — the numbers are saved. What\'s missing is "Your name, as your partners know it" in Settings: it\'s the name your sign-up page greets people with.'
            : "Your customer's discount, your affiliate's commission, and the name your partners will see."
        }
        action={deployed && !dealDecided ? { label: "Go to Settings", tab: "settings" } : undefined}
        onGo={props.onGo}
        blocked={!deployed}
      />
      <Step
        n={4}
        done={false}
        title="Share your link"
        detail={
          deployed && stripeDone
            ? "It's on the Setup tab. Anyone who opens it can apply to join your affiliate programme and get their own code."
            : "Appears on the Setup tab once steps 1 and 2 are done."
        }
        onGo={props.onGo}
        blocked={!(deployed && stripeDone)}
      />
      </div>
    </div>
  );
}

function Step(props: {
  n: number;
  done: boolean;
  title: string;
  detail: string;
  action?: { label: string; tab: GoTo };
  onGo: (tab: GoTo) => void;
  blocked?: boolean;
}) {
  return (
    <div className="spread" style={{ borderTop: "1px solid var(--poppy-border)", paddingTop: 10, opacity: props.blocked ? 0.6 : 1 }}>
      <div>
        <div className="row" style={{ gap: 8 }}>
          <span className={`badge${props.done ? " ok" : ""}`}>
            <span className="dot" /> {props.done ? "Done" : `Step ${props.n}`}
          </span>
          <strong>{props.title}</strong>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {props.detail}
        </div>
      </div>
      {props.action && (
        <button className="btn btn-sm btn-primary" onClick={() => props.onGo(props.action!.tab)}>
          {props.action.label}
        </button>
      )}
    </div>
  );
}
