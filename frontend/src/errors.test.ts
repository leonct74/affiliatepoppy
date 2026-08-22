// The bridge's wire format must never reach a merchant's eyes (live lesson, 2026-08-21).
import { describe, expect, it } from "vitest";
import { friendlyBackendError } from "./errors";

describe("friendlyBackendError", () => {
  it("unwraps the bridge's `backend NNN: {json}` into the backend's own sentence", () => {
    const e = friendlyBackendError(
      new Error('backend 500: {"error":"That name can\'t be used: lowercase letters, digits and hyphens, 3–30 characters."}'),
    );
    expect(e.message).toBe("That name can't be used: lowercase letters, digits and hyphens, 3–30 characters.");
  });

  it("leaves ordinary errors and non-JSON bodies untouched", () => {
    expect(friendlyBackendError(new Error("AgentsPoppy didn't respond in time (invokeBackend).")).message).toContain(
      "didn't respond",
    );
    expect(friendlyBackendError(new Error("backend 502: <html>Bad Gateway</html>")).message).toBe(
      "backend 502: <html>Bad Gateway</html>",
    );
    expect(friendlyBackendError("plain string").message).toBe("plain string");
  });
});
