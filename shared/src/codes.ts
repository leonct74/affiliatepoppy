// Coupon codes: what an affiliate hands to their audience, and the only thing that carries
// attribution (D1). A code has to survive being read aloud in a video, typed on a phone, and
// pasted from a screenshot — so the alphabet excludes the characters people confuse.

/** No 0/O, no 1/I/L: the four that get mistyped when a code is read out or transcribed. */
const SAFE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Stripe accepts a broad set; we keep to A–Z and 0–9 so a code is unambiguous to dictate. */
export const CODE_PATTERN = /^[A-Z0-9]{4,20}$/;

/** What we store and compare — codes are case-insensitive everywhere in the product. */
export function normalizeCode(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
}

export function isValidCode(raw: string): boolean {
  return CODE_PATTERN.test(normalizeCode(raw));
}

/** `random(n)` returns n characters from SAFE_ALPHABET; injected so tests are deterministic. */
export type RandomChars = (n: number) => string;

/** Cryptographically-random suffix characters, without modulo bias. */
export const cryptoRandomChars: RandomChars = (n) => {
  const bytes = new Uint8Array(n * 2);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) {
    if (out.length === n) break;
    // Reject the tail that would bias the alphabet rather than folding it in.
    if (b >= 256 - (256 % SAFE_ALPHABET.length)) continue;
    out += SAFE_ALPHABET[b % SAFE_ALPHABET.length];
  }
  // Vanishingly rare: not enough unbiased bytes. Ask for more rather than return a short code.
  return out.length === n ? out : cryptoRandomChars(n);
};

/**
 * A code an affiliate will recognise as theirs: their name, then random characters.
 *
 * The name half is what makes a code worth sharing (OLIVER-something reads like a
 * partnership; a random string reads like spam), and the random half is what stops two
 * affiliates called Oliver colliding — and stops anyone guessing a colleague's code, which
 * matters because a code is the whole of attribution.
 */
export function suggestCode(displayName: string, random: RandomChars = cryptoRandomChars, suffixLength = 4): string {
  const stem = normalizeCode(displayName).slice(0, 12);
  const suffix = random(Math.max(2, suffixLength));
  // A nameless or unusable stem still yields a valid code, never a bare suffix that's too short.
  return normalizeCode(stem.length >= 2 ? stem + suffix : `AFF${suffix}${random(3)}`);
}
