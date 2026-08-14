// Webhook signature verification — the ONLY thing standing between a stranger and the
// merchant's commission ledger.
//
// The receiver's Function URL is open to the internet (AuthType NONE), because the caller is
// Stripe and Stripe authenticates with a signed header rather than SigV4. So this check IS
// the authentication: anything that fails it must be refused, and nothing about the request
// body may be believed until it passes.
//
// WHY NO LIBRARY: this is Stripe's documented scheme in thirty lines of node:crypto — a
// dependency here would be a supply-chain risk on the exact path that decides whether money
// is credited, and would add weight to a Lambda that shares a zip with the portal.
//
// Every rule below exists because skipping it is a known break:
//  · unchecked timestamp  → a captured request replays forever;
//  · non-constant-time compare → the signature can be recovered a byte at a time;
//  · trusting the header's own timestamp without recomputing → the signature covers `t`, so
//    an attacker who could change it would invalidate their own signature. That is why the
//    signed payload is `${t}.${body}` and not the body alone.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Stripe's own default: five minutes of clock skew, replayed events refused after that. */
export const DEFAULT_TOLERANCE_SEC = 300;

export class SignatureError extends Error {}

export interface VerifyOptions {
  /** The raw request body, byte for byte. A re-serialised JSON object will NOT verify. */
  payload: string;
  /** The `Stripe-Signature` header, verbatim. */
  header: string | undefined;
  /** The endpoint's signing secret (`whsec_…`) from the merchant's own parameter store. */
  secret: string;
  /** Epoch seconds; injected so expiry is testable without waiting. */
  now: number;
  toleranceSec?: number;
}

/** Parse `t=…,v1=…,v1=…` into its parts. Unknown schemes are ignored, not an error. */
function parseHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (!key || !value) continue;
    if (key.trim() === "t") timestamp = Number(value.trim());
    else if (key.trim() === "v1") signatures.push(value.trim());
  }
  return { timestamp, signatures };
}

/** Constant-time hex comparison that never throws on a malformed candidate. */
function hexEquals(expected: string, candidate: string): boolean {
  if (candidate.length !== expected.length) return false;
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(expected, "hex");
    b = Buffer.from(candidate, "hex");
  } catch {
    return false;
  }
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Verify a webhook request and return its parsed event. Throws SignatureError on ANY problem;
 * callers must answer 400 and must never fall back to "unsigned but probably fine".
 */
export function verifyStripeSignature(opts: VerifyOptions): unknown {
  if (!opts.secret) throw new SignatureError("no signing secret configured");
  if (!opts.header) throw new SignatureError("missing Stripe-Signature header");

  const { timestamp, signatures } = parseHeader(opts.header);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new SignatureError("malformed signature header");
  if (signatures.length === 0) throw new SignatureError("no v1 signature in header");

  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(opts.now - timestamp) > tolerance) throw new SignatureError("signature timestamp outside tolerance");

  const expected = createHmac("sha256", opts.secret).update(`${timestamp}.${opts.payload}`, "utf8").digest("hex");
  // Stripe sends several v1 values during a secret rotation; any ONE matching is valid.
  if (!signatures.some((candidate) => hexEquals(expected, candidate))) {
    throw new SignatureError("signature does not match");
  }

  try {
    return JSON.parse(opts.payload);
  } catch {
    throw new SignatureError("signed body is not valid JSON");
  }
}
