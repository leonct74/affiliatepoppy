// The handoff that lets a confined backend give the user a file without touching their disk.
//
// Two properties carry the whole design: a token works ONCE, and not for long. Both are what
// make it safe for the download URL to travel through the system browser with no bearer token
// — the token is the authorisation, so it must be worthless the moment it has been used or has
// gone stale.

import { describe, expect, it } from "vitest";
import { DownloadHandoff, contentDisposition } from "./downloads";

const file = { filename: "a.csv", contentType: "text/csv", bytes: Buffer.from("x,y\n") };

describe("a handed-over file", () => {
  it("can be collected exactly once", () => {
    const h = new DownloadHandoff();
    const token = h.offer(file);
    expect(h.take(token)?.bytes.toString()).toBe("x,y\n");
    expect(h.take(token)).toBeUndefined();
  });

  it("is gone after its minute, even if nobody came for it", () => {
    let now = 1_000;
    const h = new DownloadHandoff(60_000, () => now);
    const token = h.offer(file);
    now += 59_999;
    expect(h.take(token)).toBeDefined();
    const second = h.offer(file);
    now += 60_000;
    expect(h.take(second)).toBeUndefined();
  });

  it("gives every offer its own token — two exports never collide", () => {
    const h = new DownloadHandoff();
    expect(h.offer(file)).not.toBe(h.offer(file));
  });

  it("does not leak the file to a token that was never issued", () => {
    const h = new DownloadHandoff();
    h.offer(file);
    expect(h.take("guess")).toBeUndefined();
  });
});

describe("the download header", () => {
  it("names the file, and cannot be broken by a quote in the name", () => {
    expect(contentDisposition('odd "name".csv')).toBe(
      `attachment; filename="odd _name_.csv"; filename*=UTF-8''odd%20%22name%22.csv`,
    );
  });
});
