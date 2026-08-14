// Money, as the merchant reads it. The arithmetic lives in shared/src/money.ts; this is only
// presentation — but presentation with one rule: never show a bare number where a currency is
// involved, because a merchant running a programme in two currencies must never have to guess
// which one a figure is in.

/** "€10.00" from 1000 minor units. Falls back gracefully for an unknown currency code. */
export function money(cents: number, currency: string): string {
  const value = (cents ?? 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: (currency || "usd").toUpperCase() }).format(
      value,
    );
  } catch {
    return `${value.toFixed(2)} ${(currency || "").toUpperCase()}`;
  }
}

/** Parse what a merchant typed into an amount box, in minor units. NaN when it isn't money. */
export function parseAmount(raw: string): number {
  const cleaned = (raw ?? "").replace(/[^0-9.,-]/g, "").replace(",", ".");
  const value = Number(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : Number.NaN;
}

/** "2 minutes ago" for the last-heard-from-Stripe line. Empty when we never have. */
export function ago(epochSeconds: number, now = Date.now()): string {
  if (!epochSeconds) return "";
  const seconds = Math.max(0, Math.round(now / 1000 - epochSeconds));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}
