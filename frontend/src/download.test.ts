// The URL a handed-over file is collected from. It has to be built from where THIS frontend is
// served, because the backend's port is hidden and the host's passthrough sits on our origin.

import { describe, expect, it } from "vitest";
import { downloadUrlFor } from "./download";

describe("the collection URL", () => {
  it("swaps ext-ui for ext-dl on the same origin, keeping the extension id", () => {
    expect(downloadUrlFor("tok/1", "http://127.0.0.1:4310/ext-ui/com.affiliatepoppy.desktop/index.html")).toBe(
      "http://127.0.0.1:4310/ext-dl/com.affiliatepoppy.desktop/local-download/tok%2F1",
    );
  });

  it("refuses to guess when not served by AgentsPoppy — there is no browser to hand to", () => {
    expect(() => downloadUrlFor("t", "http://localhost:5173/")).toThrow(/inside AgentsPoppy/);
  });
});
