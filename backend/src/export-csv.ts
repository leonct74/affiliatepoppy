// The ledger as a CSV file the merchant keeps.
//
// This module only BUILDS the files. It never writes one: the backend runs confined and has
// no business in the merchant's Documents folder (or anywhere else on their machine). The
// bytes are handed to the user's browser through a one-shot token instead — see downloads.ts.
// The frontend can't do it either: a poppy's UI runs in a sandboxed frame where `<a download>`
// and blob URLs silently do nothing (the family's most expensive UI lesson).
//
// A merchant paying commissions needs this for their own books, and it is also the answer to
// "what if I stop using this poppy": every number can leave, in a format any spreadsheet and
// any accountant can read.

import type { AffiliateProfile, LedgerEntry } from "../../shared/src/ledger";
import type { FileToHandOver } from "./downloads";

/** One name per day, deterministic — exporting twice gives the same file, not a second one. */
export function commissionsFilename(today: string): string {
  return `AffiliatePoppy-commissions-${today}.csv`;
}

export function placementsFilename(today: string): string {
  return `AffiliatePoppy-placements-${today}.csv`;
}

/** RFC 4180 quoting: wrap in quotes and double any quote inside. */
function cell(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The ledger as rows a person can read. Amounts are written in MAJOR units with two decimals
 * (12.34, not 1234) because this file is opened in a spreadsheet by someone reconciling real
 * payments — cents-as-integers is our internal representation, not theirs.
 */
export function toCsv(
  affiliates: AffiliateProfile[],
  entries: LedgerEntry[],
): string {
  const byId = new Map(affiliates.map((a) => [a.affId, a]));
  const header = ["date", "affiliate", "email", "code", "kind", "commission", "currency", "rate_pct", "base", "stripe_ref", "account"];
  // Placements are per affiliate, not per entry — they get their own small file-section
  // rather than being repeated on every row. See placementsCsv().
  const rows = [...entries]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((e) => {
      const affiliate = byId.get(e.affId);
      return [
        e.day,
        affiliate?.displayName ?? e.affId,
        affiliate?.email ?? "",
        affiliate?.code ?? "",
        e.kind,
        (e.amountCents / 100).toFixed(2),
        e.currency.toUpperCase(),
        e.pct,
        (e.baseCents / 100).toFixed(2),
        e.orderRef,
        // P7: which connected account the sale was on — "" means the merchant's own.
        e.account ?? "",
      ].map(cell).join(",");
    });
  return [header.join(","), ...rows].join("\n") + "\n";
}

/**
 * Everything the merchant should walk away with, as files ready to hand over. The commissions
 * file always; the placements file only when anyone has declared where they share their code
 * — an empty second file would be one more thing to explain.
 */
export function exportFiles(
  today: string,
  affiliates: AffiliateProfile[],
  entries: LedgerEntry[],
): FileToHandOver[] {
  const files: FileToHandOver[] = [
    { filename: commissionsFilename(today), contentType: CSV, bytes: Buffer.from(toCsv(affiliates, entries), "utf8") },
  ];
  const withLinks = affiliates.filter((a) => a.placements?.length);
  if (withLinks.length) {
    files.push({ filename: placementsFilename(today), contentType: CSV, bytes: Buffer.from(placementsCsv(withLinks), "utf8") });
  }
  return files;
}

const CSV = "text/csv; charset=utf-8";

/**
 * A second, small CSV: where each affiliate says they share their code. Kept separate from
 * the commissions file on purpose — one row per link is the shape a person can filter, and
 * repeating twenty URLs on every commission row would make the main file unreadable.
 */
export function placementsCsv(affiliates: AffiliateProfile[]): string {
  const header = ["affiliate", "email", "code", "url", "note"];
  const rows: string[] = [];
  for (const a of affiliates) {
    for (const p of a.placements ?? []) {
      rows.push([a.displayName, a.email, a.code, p.url, p.note].map(cell).join(","));
    }
  }
  return [header.join(","), ...rows].join("\n") + "\n";
}
