// The Settings tab — the economics (D3/D5/D8/D9) and the white-label look of the page the
// merchant's partners see (D10/P4).
//
// The founder's requirement in one line: every percentage in this product is HIS to set, in
// the poppy, not baked into the code. So this tab is where the programme's whole commercial
// shape lives — and where the one irreversible consequence is stated plainly: changing the
// discount makes a NEW coupon, and codes already in the wild keep the deal they were given.

import { useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import type { PortalBranding, ProgramConfig, ProgramSettings } from "./types";

const LOGO_MAX_BYTES = 100_000;

export function Settings(props: { config: ProgramConfig | null; onSaved: () => Promise<void> }) {
  const [settings, setSettings] = useState<ProgramSettings | null>(null);
  const [branding, setBranding] = useState<PortalBranding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Reload the form whenever the underlying config changes (including after a save), so the
  // fields always show what is actually stored rather than a stale draft.
  useEffect(() => {
    if (props.config) {
      setSettings({ ...props.config.settings });
      setBranding({ ...props.config.branding });
    }
  }, [props.config]);

  if (!settings || !branding) {
    return (
      <div className="card row">
        <span className="spinner" /> <span className="muted">Loading your settings…</span>
      </div>
    );
  }

  const discountChanged = settings.discountPct !== props.config?.settings.discountPct;

  const save = async () => {
    setError(null);
    setSaved(null);
    try {
      const result = await api.saveConfig({ settings, branding });
      await props.onSaved();
      setSaved(
        result.couponChanged
          ? "Saved. A new discount was created in Stripe — codes already out there keep the old one."
          : "Saved.",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const num = (value: string) => (value === "" ? 0 : Number(value));

  return (
    <div className="stack">
      {error && <div className="banner err">{error}</div>}
      {saved && <div className="banner info">{saved}</div>}

      <div className="card stack">
        <h2 className="section-title">The deal</h2>
        <div className="grid-2">
          <label className="field">
            <span>Your customer's discount (%)</span>
            <input
              className="input"
              inputMode="decimal"
              value={String(settings.discountPct)}
              onChange={(e) => setSettings({ ...settings, discountPct: num(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Your affiliate's commission (%)</span>
            <input
              className="input"
              inputMode="decimal"
              value={String(settings.commissionPct)}
              onChange={(e) => setSettings({ ...settings, commissionPct: num(e.target.value) })}
            />
          </label>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Commission is worked out on what the customer actually paid, after their discount and without tax.
        </p>
        {discountChanged && (
          <div className="banner info">
            Changing the discount creates a <strong>new</strong> discount in Stripe. Codes people already have keep
            the deal they were given — which is the promise you made them.
          </div>
        )}
      </div>

      <div className="card stack">
        <h2 className="section-title">How the programme runs</h2>
        <label className="row" style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={!settings.firstPaymentOnly}
            onChange={(e) => setSettings({ ...settings, firstPaymentOnly: !e.target.checked })}
          />
          <span>
            Keep paying on renewals
            <div className="muted" style={{ fontSize: 12 }}>
              Off means the affiliate earns once, on the first payment only.
            </div>
          </span>
        </label>
        <label className="row" style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={settings.autoApprove}
            onChange={(e) => setSettings({ ...settings, autoApprove: e.target.checked })}
          />
          <span>
            Give everyone a code the moment they sign up
            <div className="muted" style={{ fontSize: 12 }}>
              Off means you approve each person in the Affiliates tab first.
            </div>
          </span>
        </label>
        <label className="field">
          <span>Most affiliates you'll take</span>
          <input
            className="input"
            style={{ maxWidth: 160 }}
            inputMode="numeric"
            value={String(settings.maxAffiliates)}
            onChange={(e) => setSettings({ ...settings, maxAffiliates: num(e.target.value) })}
          />
        </label>
        <p className="muted" style={{ margin: 0 }}>
          A limit stops an automated flood of sign-ups running up your AWS bill. Anyone who arrives after it's reached
          is told the programme is full, politely.
        </p>
      </div>

      <div className="card stack">
        <h2 className="section-title">How your page looks</h2>
        <p className="muted" style={{ margin: 0 }}>
          This is the page people see when you share your link. It's yours — your name, your colour, your words.
        </p>
        <div className="grid-2">
          <label className="field">
            <span>Your name, as your partners know it</span>
            <input
              className="input"
              value={branding.merchantName}
              maxLength={60}
              onChange={(e) => setBranding({ ...branding, merchantName: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Accent colour</span>
            <input
              className="input"
              type="color"
              value={branding.accentColor}
              onChange={(e) => setBranding({ ...branding, accentColor: e.target.value })}
            />
          </label>
        </div>
        <LogoField branding={branding} onChange={setBranding} onError={setError} />
        <label className="field">
          <span>Your offer, in one sentence (leave empty for a sentence built from the numbers above)</span>
          <textarea
            className="input"
            value={branding.offerCopy}
            maxLength={400}
            placeholder={props.config?.offer}
            onChange={(e) => setBranding({ ...branding, offerCopy: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Your terms (shown in full on the page — never a link to nowhere)</span>
          <textarea
            className="input"
            style={{ minHeight: 120 }}
            value={branding.termsText}
            maxLength={4000}
            onChange={(e) => setBranding({ ...branding, termsText: e.target.value })}
          />
        </label>

        <Preview branding={branding} settings={settings} fallbackOffer={props.config?.offer ?? ""} />
      </div>

      <div>
        <Button className="btn btn-primary" busyLabel="Saving…" onClick={save}>
          Save settings
        </Button>
      </div>
    </div>
  );
}

/**
 * The logo. It rides inside every page render as a data: URI (so the page stays entirely
 * self-contained — an affiliate's browser never fetches anything from anywhere), which is
 * exactly why the size cap is enforced here, in front of the person choosing the file, rather
 * than silently dropped later.
 */
function LogoField(props: {
  branding: PortalBranding;
  onChange: (b: PortalBranding) => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="stack">
      <label className="field" style={{ marginBottom: 0 }}>
        <span>Your logo (optional, under 100 KB)</span>
        <input
          className="input"
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > LOGO_MAX_BYTES) {
              props.onError(
                `That logo is ${Math.round(file.size / 1024)} KB. It needs to be under 100 KB — it loads on every page your affiliates open.`,
              );
              e.target.value = "";
              return;
            }
            const reader = new FileReader();
            reader.onload = () => props.onChange({ ...props.branding, logoDataUri: String(reader.result ?? "") });
            reader.readAsDataURL(file);
          }}
        />
      </label>
      {props.branding.logoDataUri && (
        <div className="row">
          <img src={props.branding.logoDataUri} alt="" style={{ maxHeight: 36, maxWidth: 120 }} />
          <button className="btn btn-sm btn-ghost" onClick={() => props.onChange({ ...props.branding, logoDataUri: "" })}>
            Remove logo
          </button>
        </div>
      )}
    </div>
  );
}

/** A faithful-enough sketch of the affiliate's first screen, so the merchant isn't guessing. */
function Preview(props: { branding: PortalBranding; settings: ProgramSettings; fallbackOffer: string }) {
  const offer = props.branding.offerCopy || props.fallbackOffer;
  return (
    <div
      className="card card-2 stack"
      style={{ borderColor: props.branding.accentColor, marginBottom: 0 }}
      aria-label="Preview of your affiliate page"
    >
      <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        Preview
      </span>
      {props.branding.logoDataUri && (
        <img src={props.branding.logoDataUri} alt="" style={{ maxHeight: 36, maxWidth: 120 }} />
      )}
      <strong style={{ fontSize: 18 }}>{props.branding.merchantName || "Your name here"}</strong>
      <p style={{ margin: 0 }}>{offer}</p>
      <div>
        <span
          className="btn btn-sm"
          style={{ background: props.branding.accentColor, color: "#0d1117", borderColor: "transparent" }}
        >
          Create my account
        </span>
      </div>
    </div>
  );
}
