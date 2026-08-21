// "Copy the helper prompt" — the family's onboarding banner (AGENTS.md §9, REQUIRED on the
// primary creation surface). Pulses until first used: an invitation, not an alarm — and the
// design kit's class holds still for anyone who asked their OS for reduced motion.

import { useState } from "react";
import { copyText } from "./CopyButton";
import { buildHelperPrompt } from "./helper-prompt";
import type { DeploymentStatus, ProgramConfig } from "./types";

export function HelperBanner(props: { status: DeploymentStatus | null; config: ProgramConfig | null }) {
  const [copied, setCopied] = useState(false);
  const [used, setUsed] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    const ok = await copyText(buildHelperPrompt(props.status, props.config));
    setUsed(true);
    setFailed(!ok);
    setCopied(ok);
    window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 2500);
  };

  return (
    <div className="banner info">
      <div className="spread">
        <span>
          <strong>New to this?</strong> Copy the helper prompt, paste it into any AI you use (Claude, ChatGPT…),
          and describe your business — it will walk you through Stripe and this app one step at a time, including
          the fiddly Stripe screens, and it knows this install's real addresses and numbers.
        </span>
        <button className={`btn btn-primary${used ? "" : " poppy-helper-pulse"}`} onClick={() => void copy()}>
          {copied ? "Copied ✓" : failed ? "Select & copy manually" : "✨ Copy the helper prompt"}
        </button>
      </div>
    </div>
  );
}
