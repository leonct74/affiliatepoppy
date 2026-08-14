// The ledger as a CSV file on the merchant's own machine.
//
// THE BACKEND WRITES THE FILE — not the frontend. A poppy's UI runs in a sandboxed frame
// where `<a download>` and blob URLs silently do nothing, so a download button implemented in
// the frontend is a dead button (the family's most expensive UI lesson). The sidecar writes
// to Documents and hands the path back, and the UI shows the path.
//
// A merchant paying commissions needs this for their own books, and it is also the answer to
// "what if I stop using this poppy": every number can leave, in a format any spreadsheet and
// any accountant can read.

import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AffiliateProfile, LedgerEntry } from "../../shared/src/ledger";

export interface ExportSummary {
  path: string;
  rows: number;
}

/** One file per day, deterministic name — re-running overwrites rather than multiplying. */
export function exportPath(dir: string, today: string): string {
  return join(dir, `AffiliatePoppy-commissions-${today}.csv`);
}

export function defaultExportDir(): string {
  return join(homedir(), "Documents");
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
  const header = ["date", "affiliate", "email", "code", "kind", "commission", "currency", "rate_pct", "base", "stripe_ref"];
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
      ].map(cell).join(",");
    });
  return [header.join(","), ...rows].join("\n") + "\n";
}

export async function writeCsv(
  dir: string,
  today: string,
  affiliates: AffiliateProfile[],
  entries: LedgerEntry[],
): Promise<ExportSummary> {
  const path = exportPath(dir, today);
  await writeFile(path, toCsv(affiliates, entries), "utf8");
  return { path, rows: entries.length };
}
