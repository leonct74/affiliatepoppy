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
import { CopyButton } from "./CopyButton";
import { host } from "./host";
import { defaultTermsText } from "../../shared/src/settings";
import { WEBHOOK_API_VERSION } from "../../shared/src/stripe-events";
import type { PortalBranding, ProgramConfig, ProgramSettings } from "./types";

const LOGO_MAX_BYTES = 100_000;

export function Settings(props: { config: ProgramConfig | null; onSaved: () => Promise<void> }) {
  const [settings, setSettings] = useState<ProgramSettings | null>(null);
  const [branding, setBranding] = useState<PortalBranding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const pro = props.config?.plan.pro ?? false;

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
            Approve sign-ups automatically
            <div className="muted" style={{ fontSize: 12 }}>
              On: anyone who signs up and confirms their email gets a working code straight away, without you doing
              anything. Off: they wait in the Affiliates tab as "Waiting for you" until you press Approve — then their
              code is created. Same code, same commission either way; the only difference is whether you look first.
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
        <div className="spread">
          <h2 className="section-title" style={{ margin: 0 }}>How your page looks</h2>
          {!pro && <span className="badge"><span className="dot" /> Pro</span>}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          This is the page people see when you share your link. It's yours — your name, your colour, your words.
        </p>
        {!pro && <UnlockPro onUnlocked={props.onSaved} />}
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
              disabled={!pro}
              onChange={(e) => setBranding({ ...branding, accentColor: e.target.value })}
            />
          </label>
        </div>
        <LogoField branding={branding} onChange={setBranding} onError={setError} disabled={!pro} />
        <label className="field">
          <span>Your offer, in one sentence (leave empty for a sentence built from the numbers above)</span>
          <textarea
            className="input"
            value={branding.offerCopy}
            maxLength={400}
            placeholder={props.config?.offer}
            disabled={!pro}
            onChange={(e) => setBranding({ ...branding, offerCopy: e.target.value })}
          />
        </label>
        <label className="field">
          <span>
            Your terms — the rules of the deal, shown in full on the page. Typically: how and when they're paid, what
            counts as a sale, what's not allowed, how it ends.
          </span>
          <textarea
            className="input"
            style={{ minHeight: 160 }}
            value={branding.termsText}
            maxLength={4000}
            disabled={!pro}
            placeholder={"e.g. You earn 10% of every sale made with your code, paid monthly by bank transfer once you're owed at least €25. Refunds are deducted. Don't buy with your own code or bid on our brand name in ads. Either of us can end this at any time…"}
            onChange={(e) => setBranding({ ...branding, termsText: e.target.value })}
          />
        </label>
        {!branding.termsText && (
          <div>
            <button
              className="btn btn-sm"
              disabled={!pro}
              onClick={() => setBranding({ ...branding, termsText: defaultTermsText(settings, branding.merchantName) })}
            >
              Give me a starting point
            </button>
            <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
              Plain-English terms built from your numbers above — edit them into your own words. Not legal advice.
            </span>
          </div>
        )}

        <Preview branding={branding} settings={settings} fallbackOffer={props.config?.offer ?? ""} />
      </div>

      {pro && <PortalPublish config={props.config} onPublished={props.onSaved} />}

      <div className="row">
        <Button className="btn btn-primary" busyLabel="Saving…" disabled={!branding.merchantName.trim()} onClick={save}>
          Save settings
        </Button>
        {!branding.merchantName.trim() && (
          <span className="muted" style={{ fontSize: 12 }}>
            Fill in your name first (under "How your page looks") — it's what your sign-up page greets people with.
          </span>
        )}
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
  disabled?: boolean;
}) {
  return (
    <div className="stack">
      <label className="field" style={{ marginBottom: 0 }}>
        <span>Your logo (optional, under 100 KB)</span>
        <input
          className="input"
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          disabled={props.disabled}
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


/**
 * The D19c unlock. The fields above stay VISIBLE — a locked form the merchant can read is a
 * demo of what they'd get — and this card is the one place the purchase starts. It also names
 * the other half of the deal: the free-plan notice on their public page goes away.
 */
function UnlockPro(props: { onUnlocked: () => Promise<void> }) {
  const [price, setPrice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void host
      .purchaseInfo("pro")
      .then((info) => {
        if (info.price) {
          const major = (info.price.amountMinor / 100).toFixed(2);
          const amount = `${info.price.currency === "eur" ? "€" : info.price.currency === "usd" ? "$" : info.price.currency.toUpperCase() + " "}${major}`;
          setPrice(info.price.kind === "one_time" ? amount : `${amount}/${info.price.interval === "year" ? "yr" : "mo"}`);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="banner info stack" style={{ gap: 8 }}>
      <div>
        <strong>Personalisation is part of AffiliatePoppy Pro{price ? ` — ${price}` : ""}.</strong> Unlocking it lets
        you set the logo, colour, offer and terms below — and removes the "AffiliatePoppy Free" notice your
        affiliates currently see on your sign-up page. Everything else, including your numbers and your name, works
        in full without it.
      </div>
      {error && <div className="banner err">{error}</div>}
      <div>
        <Button
          className="btn btn-primary btn-sm"
          busyLabel="Waiting for the payment…"
          onClick={async () => {
            setError(null);
            try {
              const { owned } = await host.buyProduct("pro");
              if (!owned) {
                setError("The payment didn't complete — nothing was charged. Try again whenever you like.");
                return;
              }
              await api.setPlan(true);
              await props.onUnlocked();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Unlock Pro
        </Button>
      </div>
    </div>
  );
}


/**
 * P10: the permanent, friendly address — affiliates.agentspoppy.com/<name>. Pro-only (the
 * paid plan is what pays for the hosting), and the poppy keeps the page fed automatically on
 * every Settings save once published.
 */
function PortalPublish(props: { config: ProgramConfig | null; onPublished: () => Promise<void> }) {
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const published = props.config?.portal.slug ?? "";

  if (published) {
    return (
      <div className="card stack">
        <h2 className="section-title">Your permanent address</h2>
        <p className="muted" style={{ margin: 0 }}>
          This link never changes — share it instead of the AWS one. The page updates itself every time you save
          these settings.
        </p>
        <div className="row">
          <span className="chip" style={{ overflowWrap: "anywhere" }}>{props.config!.portal.url}</span>
        </div>
        <PortalFeed portal={props.config!.portal} onConnected={props.onPublished} />
      </div>
    );
  }

  return (
    <div className="card stack">
      <h2 className="section-title">Get your permanent address</h2>
      <p className="muted" style={{ margin: 0 }}>
        Publish your sign-up page to <span className="chip">affiliates.agentspoppy.com/your-name</span> — a friendly
        link that survives anything (the AWS one changes if you ever rebuild). Lowercase letters, digits and
        hyphens, 3–30 characters.
      </p>
      {error && <div className="banner err">{error}</div>}
      <div className="row">
        <input
          className="input mono"
          style={{ maxWidth: 220 }}
          value={slug}
          placeholder="your-name"
          onChange={(e) => setSlug(e.target.value)}
        />
        <Button
          className="btn btn-primary btn-sm"
          busyLabel="Claiming the name…"
          disabled={!slug.trim()}
          onClick={async () => {
            setError(null);
            try {
              await api.publishPortal(slug);
              await props.onPublished();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Publish
        </Button>
      </div>
    </div>
  );
}

/**
 * Q3: connect the merchant's Stripe to the platform ledger, so their public page's numbers
 * are computed by AgentsPoppy from Stripe's own events — the third-party guarantee the paid
 * portal is sold on. One more webhook, the same gesture as Setup step 2; the secret passes
 * straight through to the platform and is never kept in the merchant's AWS.
 */
function PortalFeed(props: {
  portal: { feedUrl: string; feedDay: string };
  onConnected: () => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setError(null);
    try {
      await api.portalFeedSecret(secret);
      setSecret("");
      setRotating(false);
      await props.onConnected();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const form = (
    <>
      {error && <div className="banner err">{error}</div>}
      <div className="row">
        <input
          className="input mono"
          style={{ maxWidth: 320 }}
          type="password"
          value={secret}
          placeholder="whsec_…"
          onChange={(e) => setSecret(e.target.value)}
        />
        <Button className="btn btn-primary btn-sm" busyLabel="Connecting…" disabled={!secret.trim()} onClick={send}>
          Connect the feed
        </Button>
      </div>
    </>
  );

  if (props.portal.feedDay && !rotating) {
    return (
      <div className="stack" style={{ borderTop: "1px solid var(--poppy-border)", paddingTop: 10 }}>
        <p className="muted" style={{ margin: 0 }}>
          <span className="badge ok"><span className="dot" /> Ledger feed connected</span>{" "}
          since {props.portal.feedDay}. Your publishers' earnings on the page are computed by AgentsPoppy directly
          from Stripe's events — independently of this app.
        </p>
        <div className="row">
          <button className="btn btn-sm btn-ghost" onClick={() => setRotating(true)}>
            Replace the signing secret
          </button>
        </div>
        {rotating && form}
      </div>
    );
  }

  return (
    <div className="stack" style={{ borderTop: "1px solid var(--poppy-border)", paddingTop: 10 }}>
      <strong style={{ fontSize: 13 }}>One more step: feed the page's ledger</strong>
      <p className="muted" style={{ margin: 0 }}>
        Right now your page shows no earnings. Add <strong>one more webhook</strong> in Stripe — same gesture as
        Setup step 2 — and AgentsPoppy will compute your publishers' earnings straight from Stripe's events, as an
        independent record they can trust. In Stripe: <strong>Developers → Webhooks → Add destination</strong>,
        scope <strong>"Your account"</strong>, API version <span className="chip">{WEBHOOK_API_VERSION}</span>,
        events <span className="chip">checkout.session.completed</span>{" "}
        <span className="chip">invoice.paid</span> <span className="chip">charge.refunded</span>, and this
        endpoint URL:
      </p>
      <div className="row">
        <span className="chip" style={{ overflowWrap: "anywhere" }}>{props.portal.feedUrl}</span>
        <CopyButton text={props.portal.feedUrl} label="endpoint URL" />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Then paste the destination's <strong>signing secret</strong> here. It goes straight to AgentsPoppy — it is
        not kept in your AWS.
      </p>
      {form}
    </div>
  );
}
