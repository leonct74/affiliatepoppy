// Webhook signature verification — the check that decides whether a stranger can write
// commissions into the merchant's ledger.
//
// Every test below is an attack or a mistake, not a happy path with variations: a forged
// body, a replayed request, a rotated secret, a header that lies about its own timestamp.
// Signatures are BUILT here with node:crypto rather than pasted as hex, so the tests keep
// working if the scheme's details ever move, and can never pass by accidentally matching a
// stale constant.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignatureError, verifyStripeSignature } from "../../shared/src/stripe-signature";

const SECRET = "whsec_test_secret";
const NOW = 1_756_000_000;
const PAYLOAD = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", livemode: false });

/** A header exactly as Stripe sends one. */
function sign(payload: string, secret = SECRET, timestamp = NOW): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const verify = (over: Partial<Parameters<typeof verifyStripeSignature>[0]> = {}) =>
  verifyStripeSignature({ payload: PAYLOAD, header: sign(PAYLOAD), secret: SECRET, now: NOW, ...over });

describe("a request Stripe really sent", () => {
  it("verifies, and hands back the parsed event", () => {
    expect(verify()).toMatchObject({ id: "evt_1", type: "checkout.session.completed" });
  });

  it("still verifies during a secret rotation, when only one of several signatures matches", () => {
    // Stripe sends a v1 per active secret while a rollover is in progress. Requiring the
    // FIRST to match would break every webhook for the duration of a routine rotation.
    const good = sign(PAYLOAD).split("v1=")[1];
    const header = `t=${NOW},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${good}`;
    expect(verify({ header })).toMatchObject({ id: "evt_1" });
  });

  it("verifies at the edge of the tolerance window, so a slow network isn't an attack", () => {
    expect(verify({ header: sign(PAYLOAD, SECRET, NOW - 299) })).toMatchObject({ id: "evt_1" });
  });
});

describe("a request Stripe did not send", () => {
  const refused = (over: Parameters<typeof verify>[0], because: string) =>
    it(because, () => expect(() => verify(over)).toThrow(SignatureError));

  refused({ payload: PAYLOAD.replace("evt_1", "evt_2") }, "a tampered body is refused");
  refused({ header: sign(PAYLOAD, "whsec_someone_elses") }, "a signature made with another secret is refused");
  refused({ header: undefined }, "a request with no signature header at all is refused");
  refused({ header: `t=${NOW}` }, "a header carrying no v1 signature is refused");
  refused({ header: "not-a-header" }, "a malformed header is refused");
  refused({ secret: "" }, "an endpoint with no signing secret configured refuses everything");

  it("refuses a replay from outside the tolerance window, in BOTH directions", () => {
    // Old: a captured request must not work forever. Future: a clock the attacker controls
    // must not buy them an indefinite window either.
    expect(() => verify({ header: sign(PAYLOAD, SECRET, NOW - 600) })).toThrow(/tolerance/);
    expect(() => verify({ header: sign(PAYLOAD, SECRET, NOW + 600) })).toThrow(/tolerance/);
  });

  it("refuses a signature copied from a DIFFERENT timestamp", () => {
    // The signed payload is `${t}.${body}`, so moving `t` to dodge the replay window
    // invalidates the attacker's own signature. This is why the timestamp is signed at all.
    const stolen = sign(PAYLOAD, SECRET, NOW - 600).split("v1=")[1];
    expect(() => verify({ header: `t=${NOW},v1=${stolen}` })).toThrow(SignatureError);
  });

  it("refuses a candidate signature that isn't hex, instead of crashing on it", () => {
    expect(() => verify({ header: `t=${NOW},v1=zzzz` })).toThrow(SignatureError);
  });

  it("refuses a correctly-signed body that isn't JSON", () => {
    // Signed by us, but unusable: better a 400 than a receiver that hands `undefined` to the
    // ledger and calls it an event.
    const payload = "not json at all";
    expect(() => verify({ payload, header: sign(payload) })).toThrow(SignatureError);
  });
});
