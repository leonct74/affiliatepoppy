// Getting a file out of the poppy and into the user's hands.
//
// Neither half of a poppy may save a file: the frontend is a sandboxed frame where
// `<a download>` and blob URLs silently do nothing, and the backend is confined to its own
// folder — it must not write into the user's Documents. So the backend holds the bytes under a
// one-shot token, and we open the host's passthrough URL in the SYSTEM browser, which saves
// it wherever the user keeps downloads. The backend's port stays hidden throughout: the
// passthrough lives on the same origin that serves this frontend, so the URL is derived from
// our own location.

import { host } from "./host";

/** The URL the system browser should fetch for a handoff token. */
export function downloadUrlFor(token: string, href: string = window.location.href): string {
  // location.origin can read "null" in a sandboxed frame — parse the full href instead.
  const here = new URL(href);
  const m = here.pathname.match(/^\/ext-ui\/([^/]+)\//);
  if (!m) {
    throw new Error("This poppy isn't running inside AgentsPoppy, so there is no browser to hand the file to.");
  }
  return `${here.protocol}//${here.host}/ext-dl/${m[1]}/local-download/${encodeURIComponent(token)}`;
}

/** Open each handed-over file in the system browser, which saves it. */
export async function collectFiles(files: { token: string; filename: string }[]): Promise<void> {
  for (const f of files) await host.openExternal(downloadUrlFor(f.token));
}
