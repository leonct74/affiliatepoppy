// Placements — where an affiliate says they share their code (a YouTube video, an
// Instagram post, a blog page).
//
// This is DECLARED by the affiliate, not detected by us: nothing crawls anyone's channel.
// It is also entirely OPTIONAL — the founder's rule (2026-08-14): the affiliate must never feel
// they have to fill it in; it is a favour to the merchant, and the portal says so in as many
// words. Some partners will make the effort because it strengthens the partnership; those who
// don't lose nothing.
//
// What the merchant gets: a per-affiliate list of links they can open. What it does NOT tell
// them: which post drove which sale — a code says where it was posted, not which post
// converted. (One code per placement is the honest version of that; DESIGN.md §12.6.)

/** One declared place. `url` is the only required part; `note` is the affiliate's own label. */
export interface Placement {
  url: string;
  note: string;
}

/** Enough for a serious creator's whole footprint; small enough to keep the row light. */
export const MAX_PLACEMENTS = 20;
export const MAX_NOTE_LENGTH = 80;
export const MAX_URL_LENGTH = 500;

/**
 * Only http(s) links, so nothing an affiliate types can become a `javascript:` href when the
 * merchant clicks it — the merchant is the one opening these, and they trust their partners
 * more than a browser should.
 */
export function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
  } catch {
    return false;
  }
}

/** Placements as we will store them, whatever the caller sent. Bad rows are dropped, not fixed. */
export function sanitizePlacements(input: unknown): Placement[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Placement[] = [];
  for (const raw of input) {
    const url = typeof (raw as { url?: unknown })?.url === "string" ? (raw as { url: string }).url.trim() : "";
    if (!url || url.length > MAX_URL_LENGTH || !isSafeUrl(url)) continue;
    // Normalise so the same link pasted twice (with/without a trailing slash) counts once.
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const noteRaw = (raw as { note?: unknown })?.note;
    const note = typeof noteRaw === "string" ? noteRaw.trim().slice(0, MAX_NOTE_LENGTH) : "";
    out.push({ url, note });
    if (out.length >= MAX_PLACEMENTS) break;
  }
  return out;
}

/** "youtube.com" from a full URL — the short label the merchant's list shows next to a link. */
export function placementHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
