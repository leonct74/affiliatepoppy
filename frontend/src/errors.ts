// The host bridge reports a failed backend call as the raw wire string —
// `backend 500: {"error":"…"}` — which is debugging text, not something a merchant should
// ever read (live lesson, 2026-08-21: the founder hit it on the publish card). Every API
// call unwraps here so each error surfaces as the sentence the backend actually wrote.

export function friendlyBackendError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e);
  const body = raw.match(/^backend \d+:\s*(\{[\s\S]*\})\s*$/)?.[1];
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) return new Error(parsed.error);
    } catch {
      /* not JSON after all — fall through to the raw text */
    }
  }
  return e instanceof Error ? e : new Error(raw);
}
