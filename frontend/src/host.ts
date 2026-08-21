// Minimal host-bridge client (inlined — the AgentsPoppy SDK isn't published to npm,
// so like MailPoppy we mirror the tiny wire contract instead of taking a cross-repo
// build dependency). Protocol mirrors @agentspoppy/extension-sdk bridge.ts exactly:
// post { id, method, params } to the parent; await { id, ok, result | error }.

export type AccessState = "granted" | "pending" | "denied";

export interface BackendInvoke {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}

interface HostRequest {
  id: string;
  method: string;
  params: unknown[];
}
type HostResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const res = e.data as HostResponse;
  if (!res || typeof (res as { id?: unknown }).id !== "string" || !("ok" in res)) return;
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  clearTimeout(p.timer);
  if (res.ok) p.resolve(res.result);
  else p.reject(new Error(res.error));
});

function call<T>(method: string, params: unknown[], timeoutMs = 120_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    seq += 1;
    const id = `req-${Date.now().toString(36)}-${seq}`;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`AgentsPoppy didn't respond in time (${method}).`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    const req: HostRequest = { id, method, params };
    window.parent.postMessage(req, "*");
  });
}

export const host = {
  ensureAccess: (): Promise<AccessState> => call("ensureAccess", []),
  getConnection: (): Promise<{ id: string; status: string; app?: { id: string; name: string } }> =>
    call("getConnection", []),
  /** `timeoutMs` overrides the 2-minute default for calls that legitimately run long
   *  (teardown waits for CloudFormation to finish deleting). */
  invokeBackend: <T = unknown>(request: BackendInvoke, timeoutMs?: number): Promise<T> =>
    call("invokeBackend", [request], timeoutMs),
  /** Opens a URL in the system browser — a sandboxed frame cannot (window.open no-ops). */
  openExternal: (url: string): Promise<void> => call("openExternal", [url]),
  notify: (n: { title: string; body?: string }): Promise<void> => call("notify", [n]),
  // Commerce (capability commerce:purchase) — the D19c Pro tier. The entitlement lives with
  // the PLATFORM, keyed to this install's buyer id; the poppy only asks and remembers.
  purchaseInfo: (productId: string): Promise<{ productId: string; name: string; price: { amountMinor: number; currency: string; kind: string; interval?: string } | null; owned: boolean }> =>
    call("purchaseInfo", [productId]),
  /** Opens hosted Checkout in the system browser and resolves once the entitlement lands (~2 min max). */
  buyProduct: (productId: string): Promise<{ owned: boolean }> => call("buyProduct", [productId], 3 * 60_000),
  isPurchased: (productId: string): Promise<boolean> => call("isPurchased", [productId]),
  manageSubscription: (): Promise<void> => call("manageSubscription", []),
};

// The commerce methods above exist because Settings' unlock button calls them (D19c) — the
// manifest declares `commerce:purchase` in the same change, per AGENTS.md ("capabilities list
// only what the frontend actually calls").
