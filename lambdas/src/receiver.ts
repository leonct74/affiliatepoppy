// The receiver Lambda — the merchant's Stripe webhook endpoint, and the only thing in the
// product that can move money into the ledger.
//
// It is deliberately tiny: verify the signature, read the event, apply it, answer 200. All
// the judgement lives in attribute.ts (pure, injected store) and stripe-events.ts (pure
// parsing), which is what makes the money path testable without AWS or Stripe.
//
// ANSWERING 200 IS A FEATURE. Stripe retries a 5xx for days, so an event we don't recognise,
// a code that isn't ours, or a refund of a sale we never credited must all answer 200 — not
// because they succeeded, but because there is nothing to retry. The ONLY 400 is a request
// that fails signature verification, which is a request we have no reason to believe at all.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { CFG_PK, CFG_SK_STRIPE } from "../../shared/src/keys";
import { readEvent } from "../../shared/src/stripe-events";
import { SignatureError, verifyStripeSignature } from "../../shared/src/stripe-signature";
import { applyInstruction, type LedgerStore, type Outcome } from "./attribute";
import { DynamoLedger } from "../../shared/src/ledger-store";

const TABLE = process.env.TABLE_NAME ?? "";
const SECRET_PARAM = process.env.WEBHOOK_SECRET_PARAM ?? "";

const db = new DynamoDBClient({});
const ssm = new SSMClient({});

export interface WebhookRequest {
  /** The body exactly as sent — signature verification is over these bytes. */
  rawBody: string;
  signature: string | undefined;
  now: number;
}

export interface WebhookDeps {
  store: LedgerStore;
  secret(): Promise<string>;
  /** Records that Stripe reached us, so the Setup tab can say so. Best-effort. */
  noteEvent?(livemode: boolean, at: number): Promise<void>;
}

export interface WebhookResult {
  statusCode: number;
  body: string;
  outcomes?: Outcome[];
}

/** The whole request path, with its dependencies injected. */
export async function handleWebhook(req: WebhookRequest, deps: WebhookDeps): Promise<WebhookResult> {
  let event: unknown;
  try {
    event = verifyStripeSignature({
      payload: req.rawBody,
      header: req.signature,
      secret: await deps.secret(),
      now: req.now,
    });
  } catch (e) {
    if (e instanceof SignatureError) {
      // Say nothing useful: an unauthenticated caller learns only that it was refused.
      return { statusCode: 400, body: JSON.stringify({ error: "signature verification failed" }) };
    }
    throw e;
  }

  const outcomes = await applyInstruction(readEvent(event), deps.store);

  if (deps.noteEvent) {
    const livemode = !!(event as { livemode?: boolean })?.livemode;
    // Never let the "we heard from Stripe" breadcrumb fail a webhook that already worked.
    await deps.noteEvent(livemode, req.now).catch(() => {});
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }), outcomes };
}

// ── real-world wiring ───────────────────────────────────────────────────────────────────

/** The signing secret, cached for the life of the container (one SSM read per cold start). */
let cachedSecret: string | undefined;
async function secret(): Promise<string> {
  if (cachedSecret !== undefined) return cachedSecret;
  const out = await ssm.send(new GetParameterCommand({ Name: SECRET_PARAM, WithDecryption: true }));
  cachedSecret = out.Parameter?.Value ?? "";
  return cachedSecret;
}

async function noteEvent(livemode: boolean, at: number): Promise<void> {
  await db.send(
    new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: CFG_PK }, sk: { S: CFG_SK_STRIPE } },
      UpdateExpression: "SET lastEventAt = :at, livemode = :live",
      ExpressionAttributeValues: { ":at": { N: String(at) }, ":live": { BOOL: livemode } },
    }),
  );
}

/** Lambda Function URL entrypoint. */
export async function handler(event: {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
}): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const headers = event.headers ?? {};
  // Function URLs lowercase header names, but never assume it — a missed signature header
  // would look exactly like an attack and reject every real event.
  const signature = headers["stripe-signature"] ?? headers["Stripe-Signature"];
  // The raw bytes matter: re-serialising the JSON would change whitespace and key order, and
  // the signature would never verify again.
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : (event.body ?? "");

  try {
    const result = await handleWebhook(
      { rawBody, signature, now: Math.floor(Date.now() / 1000) },
      { store: new DynamoLedger(db, TABLE), secret, noteEvent },
    );
    if (result.outcomes) {
      // The merchant's own log, in their own account: what we did and why, with no buyer data.
      for (const outcome of result.outcomes) console.log("[affiliatepoppy]", JSON.stringify(outcome));
    }
    return { statusCode: result.statusCode, headers: { "content-type": "application/json" }, body: result.body };
  } catch (e) {
    // A real failure (DynamoDB down, a bug) SHOULD be retried by Stripe — this is the one
    // place a 500 is the right answer.
    console.error("[affiliatepoppy] receiver error", e);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "could not record this event" }),
    };
  }
}
