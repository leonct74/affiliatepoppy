// Handing a file to the user WITHOUT touching their disk.
//
// This backend runs confined (`backend.isolation: "strict"`): it may read its own install
// directory and write only its data directory and the OS temp dir. The user's Documents and
// Downloads folders are off limits by design — a poppy is not allowed to reach into the rest
// of the machine, and the merchant should never have to trust that it doesn't.
//
// So a file leaves the poppy the way the host sanctions: the backend keeps the bytes in
// memory under a one-shot token, the frontend opens the host's passthrough URL
// (`/ext-dl/<id>/local-download/<token>`) in the system browser, and the browser saves it
// wherever the user keeps downloads. Nothing is written anywhere by us. The token is
// single-use and short-lived, so a URL that leaks in a screenshot is worthless within a
// minute — and worthless immediately once it has been fetched.

import { randomUUID } from "node:crypto";

export interface FileToHandOver {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

interface Pending extends FileToHandOver {
  expiresAt: number;
}

/** How long an unclaimed handoff lives. Long enough for a browser to open; not longer. */
export const HANDOFF_TTL_MS = 60_000;

export class DownloadHandoff {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly ttlMs = HANDOFF_TTL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly mintToken: () => string = randomUUID,
  ) {}

  /** Register a file; returns the token the browser must present. */
  offer(file: FileToHandOver): string {
    this.sweep();
    const token = this.mintToken();
    this.pending.set(token, { ...file, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /** Claim a file. Single-use: the second call with the same token gets nothing. */
  take(token: string): FileToHandOver | undefined {
    this.sweep();
    const item = this.pending.get(token);
    if (!item) return undefined;
    this.pending.delete(token);
    const { expiresAt: _expiresAt, ...file } = item;
    return file;
  }

  /** Drop everything past its time. Called on every access, so no timers to keep alive. */
  private sweep(): void {
    const t = this.now();
    for (const [token, item] of this.pending) {
      if (item.expiresAt <= t) this.pending.delete(token);
    }
  }
}

/**
 * The Content-Disposition value for `filename`: the plain form is scrubbed of anything that
 * could break the header, and the RFC 5987 form carries the real name for non-ASCII cases.
 */
export function contentDisposition(filename: string): string {
  const safe = filename.replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
