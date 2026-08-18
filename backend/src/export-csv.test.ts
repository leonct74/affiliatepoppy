// The commissions CSV — the file the merchant's accountant actually opens, and the answer to
// "what happens to my numbers if I stop using this poppy".
//
// Two things are worth testing about a CSV: that a spreadsheet can read it (quoting), and
// that the amounts are in the units a human expects. Everything else here is plumbing.

import { describe, expect, it } from "vitest";
import type { AffiliateProfile, LedgerEntry } from "../../shared/src/ledger";
import { commissionsFilename, exportFiles, toCsv } from "./export-csv";

const affiliate = (over: Partial<AffiliateProfile> = {}): AffiliateProfile => ({
  affId: "aff-oliver",
  email: "oliver@example.com",
  displayName: "Oliver",
  status: "active",
  code: "OLIVER7K3M",
  promotionCodeId: "promo_1",
  createdDay: "2026-08-01",
  placements: [],
  ...over,
});

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  affId: "aff-oliver",
  ledgerId: "cs_1",
  kind: "sale",
  amountCents: 1000,
  baseCents: 10000,
  currency: "eur",
  pct: 10,
  orderRef: "cs_1",
  day: "2026-08-02",
  ...over,
});

describe("the file a person opens", () => {
  it("writes money in major units, because that is what the reader is reconciling", () => {
    // Cents-as-integers is our internal representation; a merchant matching this against a
    // bank transfer needs 10.00, not 1000.
    const csv = toCsv([affiliate()], [entry()]);
    const row = csv.split("\n")[1]!;
    expect(row).toContain(",10.00,EUR,10,100.00,");
  });

  it("names the affiliate a human recognises, not their internal id", () => {
    const csv = toCsv([affiliate()], [entry()]);
    expect(csv.split("\n")[1]).toContain("Oliver,oliver@example.com,OLIVER7K3M");
  });

  it("still exports an entry whose affiliate record has gone, rather than dropping the money", () => {
    // A row we cannot name is still a row that was paid. Losing it silently would make the
    // CSV disagree with the ledger — the one thing this file must never do.
    const csv = toCsv([], [entry()]);
    expect(csv.split("\n")[1]).toContain("aff-oliver");
  });

  it("quotes the things that would otherwise break a spreadsheet", () => {
    const csv = toCsv([affiliate({ displayName: 'Olly, "the Digital" one' })], [entry()]);
    expect(csv).toContain('"Olly, ""the Digital"" one"');
    // …and the parsed row still has the expected number of columns.
    expect(csv.split("\n")[0]!.split(",")).toHaveLength(10);
  });

  it("shows a refund as the negative it is", () => {
    const csv = toCsv([affiliate()], [entry({ kind: "refund", amountCents: -1000, ledgerId: "rf#ch_1" })]);
    expect(csv.split("\n")[1]).toContain("refund,-10.00,");
  });

  it("is ordered oldest-first, the way a ledger is read", () => {
    const csv = toCsv(
      [affiliate()],
      [entry({ day: "2026-08-09", ledgerId: "cs_2" }), entry({ day: "2026-08-02" })],
    );
    const days = csv.split("\n").slice(1).filter(Boolean).map((r) => r.split(",")[0]);
    expect(days).toEqual(["2026-08-02", "2026-08-09"]);
  });

  it("has a header row naming every column", () => {
    expect(toCsv([], []).split("\n")[0]).toBe(
      "date,affiliate,email,code,kind,commission,currency,rate_pct,base,stripe_ref",
    );
  });
});

describe("what leaves the poppy", () => {
  it("uses one deterministic name per day, so exporting twice gives the same file, not a second one", () => {
    expect(commissionsFilename("2026-08-14")).toBe("AffiliatePoppy-commissions-2026-08-14.csv");
    expect(commissionsFilename("2026-08-14")).toBe(commissionsFilename("2026-08-14"));
  });

  it("builds bytes to hand over — never a path, because this backend does not write to the user's disk", () => {
    // Confined by design (extension.json `isolation: "strict"`): the merchant's Documents
    // folder is not ours to write into. The file goes out through a one-shot token instead.
    const files = exportFiles("2026-08-14", [affiliate()], [entry()]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: "AffiliatePoppy-commissions-2026-08-14.csv", contentType: /text\/csv/ });
    expect(files[0]!.bytes.toString("utf8")).toContain("Oliver,oliver@example.com");
    expect(Object.keys(files[0]!)).not.toContain("path");
  });

  it("adds the placements file only when someone has actually declared a placement", () => {
    expect(exportFiles("2026-08-14", [affiliate()], [])).toHaveLength(1);
    const withLink = affiliate({ placements: [{ url: "https://blog.example/post", note: "review" }] });
    const files = exportFiles("2026-08-14", [withLink], []);
    expect(files.map((f) => f.filename)).toEqual([
      "AffiliatePoppy-commissions-2026-08-14.csv",
      "AffiliatePoppy-placements-2026-08-14.csv",
    ]);
    expect(files[1]!.bytes.toString("utf8")).toContain("https://blog.example/post");
  });
});
