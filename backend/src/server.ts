// AffiliatePoppy backend — the HTTP surface the host proxies frontend calls to, plus the
// teardown hook. Spawned by AgentsPoppy with AGENTSPOPPY_BOOTSTRAP; listens on the injected
// loopback port (never a fixed one). See AGENTS.md §7.
//
// Everything privileged happens here: the frontend has no AWS SDK, no Stripe key and no
// network of its own. In particular, the two Stripe secrets go IN through this server and
// never come back out — the UI can only ever learn that they are stored (secrets.ts).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient, GetFunctionUrlConfigCommand } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { readBootstrap, brokerCredentialsProvider } from "./boot";
import { DownloadHandoff, contentDisposition } from "./downloads";
import { exportFiles } from "./export-csv";
import { Program } from "./program";
import { describeSecrets, putSecret, type SecretName } from "./secrets";
import { deploy, getStatus, teardown, tableName, type AwsCtx } from "./stack";

const boot = readBootstrap();
const credentials = brokerCredentialsProvider(boot);
const region = boot.account.region;
const aws: AwsCtx = {
  cfn: new CloudFormationClient({ region, credentials }),
  s3: new S3Client({ region, credentials }),
  ssm: new SSMClient({ region, credentials }),
  region,
  accountId: boot.account.accountId,
};
const db = new DynamoDBClient({ region, credentials });
const lambda = new LambdaClient({ region, credentials });
const program = new Program(db, tableName, aws.ssm, { accountId: boot.account.accountId, connectionId: boot.connectionId });
/** Files waiting for the user's browser to collect them (downloads.ts). */
const handoff = new DownloadHandoff();

/** Attribution for anything we create (who made it) — separate from the AWS client context. */
const attribution = { accountId: boot.account.accountId, connectionId: boot.connectionId };

/** The current UTC day — the only date any write here uses. */
const today = () => new Date().toISOString().slice(0, 10);

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** One calm sentence for the UI — never a raw stack trace (AGENTS.md §9). */
function errorMessage(e: unknown): string {
  const err = e as { name?: string; message?: string };
  // DynamoDB's "Requested resource not found" means ONE thing here: the table isn't deployed
  // yet. Say that, in the merchant's terms — the raw wording reads like something broke.
  if (err?.name === "ResourceNotFoundException") {
    return "AffiliatePoppy isn't set up in your AWS account yet — finish the Setup tab first.";
  }
  const m = err?.message ?? String(e);
  return m.length > 400 ? `${m.slice(0, 400)}…` : m;
}

/** The live Function URL, preferred over the stack output (a repair can recreate it). */
async function liveUrl(functionName: string): Promise<string> {
  try {
    const out = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: functionName }));
    return out.FunctionUrl ?? "";
  } catch {
    return "";
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "GET" && (parts.length === 0 || parts[0] === "health")) return json(res, 200, { ok: true });
    if (method === "GET" && parts[0] === "meta") {
      return json(res, 200, { account: boot.account, connectionId: boot.connectionId });
    }

    // The live deployment state, read from CloudFormation on every call. The frontend holds no
    // memory of a deploy; this is what it mounts against and polls.
    if (method === "GET" && parts[0] === "status" && parts.length === 1) {
      const status = await getStatus(aws);
      if (status.phase === "ready") {
        const [receiver, portal] = await Promise.all([liveUrl("AffiliatePoppyReceiver"), liveUrl("AffiliatePoppyPortal")]);
        if (receiver) status.receiverUrl = receiver;
        if (portal) status.portalUrl = portal;
      }
      return json(res, 200, status);
    }

    // Start (or update) the deploy. Returns as soon as AWS accepts it — the work carries on in
    // the background whatever the UI does.
    if (method === "POST" && parts[0] === "deploy" && parts.length === 1) {
      return json(res, 200, await deploy(aws, attribution));
    }

    // ── the programme's settings, branding and Stripe connection ──────────────────────
    if (parts[0] === "config" && parts.length === 1) {
      if (method === "GET") {
        const [config, secrets] = await Promise.all([program.config(), describeSecrets(aws.ssm)]);
        return json(res, 200, { ...config, secrets });
      }
      if (method === "PUT") {
        const body = (await readBody(req)) ?? {};
        return json(res, 200, await program.saveConfig(body));
      }
    }

    // Store one Stripe secret. It goes straight into the merchant's own parameter store; the
    // response says only that it was saved, and shows the last four characters.
    if (method === "PUT" && parts[0] === "secrets" && parts.length === 2) {
      const which = parts[1] as SecretName;
      if (which !== "webhookSecret" && which !== "apiKey" && which !== "connectSecret") {
        return json(res, 404, { error: "No such secret." });
      }
      const body = (await readBody(req)) ?? {};
      const status = await putSecret(aws.ssm, which, str(body.value), attribution);
      // Saving the API key is also the moment to prove it works and make sure the coupon
      // exists — a wrong key must fail HERE, not later when an affiliate can't get a code.
      const connection = which === "apiKey" ? await program.connectStripe() : undefined;
      return json(res, 200, { ...status, connection });
    }

    // P10: publish this programme to affiliates.agentspoppy.com/<slug> (Pro only).
    if (method === "POST" && parts[0] === "portal" && parts[1] === "publish") {
      const body = (await readBody(req)) ?? {};
      return json(res, 200, await program.publishPortal(str(body.slug)));
    }

    // Q3: pass the ledger-feed webhook's signing secret through to the platform. Never
    // stored here, never echoed back — the response carries only the day it connected.
    if (method === "POST" && parts[0] === "portal" && parts[1] === "feed-secret") {
      const body = (await readBody(req)) ?? {};
      return json(res, 200, await program.portalFeedSecret(str(body.secret)));
    }

    // D20: create the webhook destinations with the merchant's own key — no Stripe forms.
    if (method === "POST" && parts[0] === "webhooks" && parts[1] === "auto") {
      return json(res, 200, await program.autoWebhooks(await liveUrl("AffiliatePoppyReceiver")));
    }

    // D19c: the UI checked the Pro entitlement with the commerce plane; we persist the answer
    // where the portal Lambda can read it.
    if (method === "PUT" && parts[0] === "plan" && parts.length === 1) {
      const body = (await readBody(req)) ?? {};
      return json(res, 200, await program.setPlan(body.pro === true));
    }

    if (method === "POST" && parts[0] === "stripe" && parts[1] === "check") {
      return json(res, 200, await program.connectStripe());
    }

    // ── P7: participating developers (connected accounts) ─────────────────────────────
    if (parts[0] === "partners") {
      if (method === "GET" && parts.length === 1) {
        const [partners, totals] = await Promise.all([program.partners(), program.partnerTotals()]);
        return json(res, 200, { partners, totals });
      }
      if (method === "POST" && parts.length === 1) {
        const body = (await readBody(req)) ?? {};
        return json(res, 200, await program.addPartner(str(body.account), str(body.label)));
      }
      if (method === "POST" && parts.length === 2 && parts[1] === "sync") {
        return json(res, 200, await program.syncCodes());
      }
      if (method === "DELETE" && parts.length === 2) {
        return json(res, 200, { partners: await program.removePartner(decodeURIComponent(parts[1]!)) });
      }
    }

    // ── affiliates ────────────────────────────────────────────────────────────────────
    if (parts[0] === "affiliates") {
      if (method === "GET" && parts.length === 1) {
        return json(res, 200, { affiliates: await program.affiliates() });
      }
      if (parts.length >= 2) {
        const affId = decodeURIComponent(parts[1]!);
        if (method === "POST" && parts[2] === "approve") {
          const body = (await readBody(req)) ?? {};
          return json(res, 200, { affiliate: await program.approve(affId, str(body.code) || undefined) });
        }
        if (method === "POST" && parts[2] === "retire") {
          return json(res, 200, { affiliate: await program.retire(affId) });
        }
        if (method === "PUT" && parts[2] === "rate") {
          const body = (await readBody(req)) ?? {};
          const pct = typeof body.pct === "number" ? body.pct : null;
          return json(res, 200, { affiliate: await program.setRate(affId, pct) });
        }
        if (method === "GET" && parts[2] === "ledger") {
          return json(res, 200, { entries: await program.ledgerFor(affId) });
        }
      }
    }

    // ── the ledger and payouts ────────────────────────────────────────────────────────
    if (method === "GET" && parts[0] === "payouts" && parts.length === 1) {
      return json(res, 200, { payouts: await program.payouts() });
    }
    if (method === "POST" && parts[0] === "payouts" && parts.length === 1) {
      const body = (await readBody(req)) ?? {};
      return json(
        res,
        200,
        await program.markPaid({
          affId: str(body.affId),
          currency: str(body.currency),
          amountCents: typeof body.amountCents === "number" ? body.amountCents : Number.NaN,
          batchId: str(body.batchId),
          note: str(body.note),
          day: today(),
        }),
      );
    }

    // The CSV the merchant's accountant opens. We hand the BYTES to the user's browser via a
    // one-shot token; we never write to their disk (this backend is confined to its own
    // folder) and the sandboxed frontend can't download at all. See downloads.ts.
    if (method === "POST" && parts[0] === "export" && parts.length === 1) {
      const affiliates = await program.affiliates();
      const entries = (await Promise.all(affiliates.map((a) => program.ledgerFor(a.affId)))).flat();
      const files = exportFiles(today(), affiliates, entries).map((f) => ({
        token: handoff.offer(f),
        filename: f.filename,
      }));
      return json(res, 200, { rows: entries.length, files });
    }

    // The browser collecting a file it was handed above. Reached through the host's
    // passthrough (GET /ext-dl/<id>/local-download/<token>), which carries no bearer token —
    // the single-use, one-minute token IS the authorisation. Bytes, not JSON.
    if (method === "GET" && parts[0] === "local-download" && parts.length === 2) {
      const file = handoff.take(decodeURIComponent(parts[1]!));
      if (!file) {
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        return res.end("This download link has expired or was already used. Export again from the Ledger tab.");
      }
      res.statusCode = 200;
      res.setHeader("content-type", file.contentType);
      res.setHeader("content-disposition", contentDisposition(file.filename));
      res.setHeader("content-length", String(file.bytes.length));
      return res.end(file.bytes);
    }

    // The teardown hook the host POSTs at the start of teardown. MUST be idempotent.
    if (method === "POST" && parts[0] === "teardown" && parts.length === 1) {
      return json(res, 200, { ok: true, ...(await teardown(aws)) });
    }

    return json(res, 404, { error: `No route for ${method} /${parts.join("/")}` });
  } catch (e) {
    return json(res, 500, { error: errorMessage(e) });
  }
});

const port = boot.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[affiliatepoppy] backend listening on 127.0.0.1:${actual} (region ${boot.account.region})`);
});

// Q4: the minting handshake — while the app runs, pick up sign-ups from the published
// portal every minute (DESIGN.md P10-Q4: the poppy polls; keys never leave this AWS).
// A no-op for unpublished installs (the pass exits on the missing slug before any network).
const PORTAL_SYNC_MS = 60_000;
const portalSyncPass = () => {
  void program
    .syncPlatformPortal()
    .then((r) => {
      if (r && (r.imported || r.minted || r.errors.length)) {
        console.log(
          `[affiliatepoppy] portal sync: ${r.imported} imported, ${r.minted} minted` +
            (r.skippedFull ? `, ${r.skippedFull} waiting (programme full)` : "") +
            (r.errors.length ? `; failed: ${r.errors.join(" | ")}` : ""),
        );
      }
    })
    .catch((e) => console.warn("[affiliatepoppy] portal sync failed:", errorMessage(e)));
};
setTimeout(portalSyncPass, 5_000); // shortly after boot, so a waiting publisher isn't a minute behind
setInterval(portalSyncPass, PORTAL_SYNC_MS);
