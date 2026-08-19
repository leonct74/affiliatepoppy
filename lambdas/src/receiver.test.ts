// The receiver with TWO endpoints behind it (P7): the merchant's own account endpoint and a
// "connected accounts" one, each signing with its own secret. What is protected here is that
// the second secret widens what we accept to exactly one more legitimate sender — and nothing
// else: an unsigned or wrongly-signed body is still refused, and a merchant without a connect
// endpoint is exactly as strict as before.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleWebhook, type WebhookDeps } from "./receiver";
import type { LedgerStore } from "./attribute";

const OWN = "whsec_own";
const CONNECT = "whsec_connect";
const NOW = 1_756_000_000;
const body = JSON.stringify({ id: "evt_1", type: "customer.created", created: NOW, data: { object: { id: "cus_1" } } });
const sign = (secret: string) => {
  const v1 = createHmac("sha256", secret).update(`${NOW}.${body}`, "utf8").digest("hex");
  return `t=${NOW},v1=${v1}`;
};

// Nothing here reaches the store: the event type is one we ignore on purpose.
const store = new Proxy({}, { get: () => async () => undefined }) as unknown as LedgerStore;
const deps = (connect: string | undefined): WebhookDeps => ({
  store,
  secret: async () => OWN,
  ...(connect === undefined ? {} : { connectSecret: async () => connect }),
});
const call = (signature: string, connect?: string) => handleWebhook({ rawBody: body, signature, now: NOW }, deps(connect));

describe("two endpoints, two secrets", () => {
  it("accepts a body signed by the account endpoint", async () => {
    expect((await call(sign(OWN), CONNECT)).statusCode).toBe(200);
  });
  it("accepts a body signed by the connected-accounts endpoint", async () => {
    expect((await call(sign(CONNECT), CONNECT)).statusCode).toBe(200);
  });
  it("refuses the connect signature when the merchant has no connect endpoint", async () => {
    expect((await call(sign(CONNECT))).statusCode).toBe(400);
    expect((await call(sign(CONNECT), "")).statusCode).toBe(400);
  });
  it("still refuses a stranger", async () => {
    expect((await call(sign("whsec_guess"), CONNECT)).statusCode).toBe(400);
  });
});
