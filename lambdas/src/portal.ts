// The portal Lambda — the affiliate-facing half of the product (DESIGN.md §5).
//
// Serves two things on one Function URL:
//   GET  /            → the signup/dashboard page (public HTML; it contains no data)
//   POST /api/enroll  → create this person's affiliate record and, if the programme is on
//                       auto-approve, their code
//   GET  /api/me      → THEIR numbers, and only theirs
//
// SECURITY MODEL, in one line: every /api route acts on the verified token's `sub` and
// nothing else. There is no affiliate id in any path, query or body anywhere in this file —
// which is what makes it impossible for one affiliate to read or alter another's earnings,
// rather than merely unlikely.

import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createHash } from "node:crypto";
import { CFG_PK, CFG_SK_PORTAL, CFG_SK_STRIPE, DIR_PK, RATE_PK, rateSk } from "../../shared/src/keys";
import { owedCents } from "../../shared/src/money";
import {
  DEFAULT_BRANDING,
  defaultOfferCopy,
  sanitizeBranding,
  sanitizeSettings,
  type PortalBranding,
  type ProgramSettings,
} from "../../shared/src/settings";
import { StripeClient } from "../../shared/src/stripe-api";
import { CodeIssueError, issueCodeFor } from "../../shared/src/issue";
import { sanitizePlacements, type Placement } from "../../shared/src/placements";
import { bearerToken, verifyJwt, type AffiliateClaims, type Jwk } from "./auth";
import { portalHtml } from "./portal-page";
import { DynamoLedger } from "../../shared/src/ledger-store";
import type { AffiliateProfile, LedgerEntry, Totals } from "../../shared/src/ledger";

const TABLE = process.env.TABLE_NAME ?? "";
const POOL_ID = process.env.USER_POOL_ID ?? "";
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID ?? "";
const API_KEY_PARAM = process.env.API_KEY_PARAM ?? "";
const REGION = process.env.AWS_REGION ?? "";

const db = new DynamoDBClient({});
const ssm = new SSMClient({});

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
  /** The caller's address, used ONLY as a hashed, hourly, self-deleting rate-limit bucket. */
  sourceIp: string;
}
export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Everything the router needs from the outside world — injected, so routing is testable. */
export interface PortalDeps {
  authenticate(headers: Record<string, string | undefined>): Promise<AffiliateClaims | undefined>;
  branding(): Promise<PortalBranding>;
  settings(): Promise<ProgramSettings>;
  /** The programme's coupon id, empty until the merchant connects Stripe. */
  couponId(): Promise<string>;
  affiliate(affId: string): Promise<AffiliateProfile | undefined>;
  countAffiliates(): Promise<number>;
  createAffiliate(profile: AffiliateProfile): Promise<void>;
  issueCode(params: { affId: string; displayName: string; couponId: string }): Promise<void>;
  totalsFor(affId: string): Promise<Totals[]>;
  ledgerFor(affId: string): Promise<LedgerEntry[]>;
  /** The ONE thing an affiliate may change about themselves: where they share their code. */
  setPlacements(affId: string, placements: Placement[]): Promise<void>;
  /** false when this address has enrolled too often in the last hour. */
  allowEnrolment(sourceIp: string): Promise<boolean>;
  today(): string;
  region: string;
  clientId: string;
}

const json = (statusCode: number, body: unknown): HttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/** How many entries an affiliate's page shows. Their own history, newest first. */
const HISTORY_LIMIT = 100;

export async function route(req: HttpRequest, deps: PortalDeps): Promise<HttpResponse> {
  const path = req.path.replace(/\/+$/, "") || "/";

  // The page is public: it has to load before anyone can sign up. It carries the merchant's
  // offer and terms — never a number belonging to anybody.
  if (req.method === "GET" && !path.startsWith("/api/") && path !== "/favicon.ico") {
    const [branding, settings, couponId] = await Promise.all([deps.branding(), deps.settings(), deps.couponId()]);
    return {
      statusCode: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // An affiliate's earnings are private, and the sign-in form must never be framed.
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
      body: portalHtml({
        region: deps.region,
        userPoolClientId: deps.clientId,
        branding,
        settings,
        offer: branding.offerCopy || defaultOfferCopy(settings),
        stripeReady: !!couponId,
      }),
    };
  }

  if (!path.startsWith("/api/")) return json(404, { error: "not found" });

  // ── everything below this line requires a verified token ────────────────────────────
  const claims = await deps.authenticate(req.headers);
  if (!claims) return json(401, { error: "sign in to continue" });

  if (req.method === "POST" && path === "/api/enroll") {
    return enroll(claims, req, deps);
  }

  // The affiliate's own, optional list of where they share their code. Their id is the token's
  // subject; there is no way to write anybody else's list.
  if (req.method === "PUT" && path === "/api/placements") {
    const profile = await deps.affiliate(claims.sub);
    if (!profile) return json(404, { error: "you haven't joined this programme yet" });
    let body: unknown;
    try {
      body = req.body ? JSON.parse(req.body) : {};
    } catch {
      return json(400, { error: "That didn't look right — try again." });
    }
    const placements = sanitizePlacements((body as { placements?: unknown })?.placements);
    await deps.setPlacements(claims.sub, placements);
    return json(200, { placements });
  }

  if (req.method === "GET" && path === "/api/me") {
    const profile = await deps.affiliate(claims.sub);
    if (!profile) return json(404, { error: "you haven't joined this programme yet" });
    const [totals, entries] = await Promise.all([deps.totalsFor(claims.sub), deps.ledgerFor(claims.sub)]);
    return json(200, {
      affiliate: publicProfile(profile),
      totals: totals.map((t) => ({ ...t, owedCents: owedCents(t) })),
      // Newest first, and capped: an affiliate wants to see what just happened, and an
      // unbounded list would grow into a slow page for exactly the people doing best.
      entries: [...entries]
        .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
        .slice(0, HISTORY_LIMIT)
        .map((e) => ({ day: e.day, kind: e.kind, amountCents: e.amountCents, currency: e.currency })),
    });
  }

  return json(404, { error: "not found" });
}

/**
 * Join the programme. Idempotent by design: the portal calls it on every sign-in, so an
 * enrolment that half-finished (verified email, but the code failed to issue) heals itself on
 * the next visit instead of leaving someone stuck with no code and no way to ask for one.
 */
async function enroll(claims: AffiliateClaims, req: HttpRequest, deps: PortalDeps): Promise<HttpResponse> {
  const [settings, couponId] = await Promise.all([deps.settings(), deps.couponId()]);
  const existing = await deps.affiliate(claims.sub);

  if (!existing) {
    if (!(await deps.allowEnrolment(req.sourceIp))) {
      return json(429, { error: "Too many signups from here just now. Please try again in a little while." });
    }
    // The cap is the merchant's protection against a signup flood running up their bill.
    // Said plainly: full is full, and the person reading it should know it isn't their fault.
    if ((await deps.countAffiliates()) >= settings.maxAffiliates) {
      return json(409, { error: "This programme has reached the number of affiliates it can take right now." });
    }
    await deps.createAffiliate({
      affId: claims.sub,
      email: claims.email,
      displayName: claims.name || claims.email.split("@")[0] || "affiliate",
      // Everyone starts pending; a code is what makes someone active, and issuing it is the
      // step that can fail. Never record "active" for a person who has nothing to share.
      status: "pending",
      code: "",
      promotionCodeId: "",
      createdDay: deps.today(),
      placements: [],
    });
  }

  const profile = (await deps.affiliate(claims.sub))!;
  const needsCode = !profile.code && profile.status !== "retired";
  // D8: on auto-approve the code is issued now; otherwise the merchant approves in the poppy
  // and the code is issued there. A merchant who has already approved someone by hand leaves
  // status "active" with no code — that is also a case to heal here.
  const mayIssue = settings.autoApprove || profile.status === "active";
  if (needsCode && mayIssue && couponId) {
    try {
      await deps.issueCode({ affId: profile.affId, displayName: profile.displayName, couponId });
    } catch (e) {
      // Their record exists; the code is what's missing. Say so rather than failing the whole
      // enrolment and making them think their signup didn't work.
      const message =
        e instanceof CodeIssueError ? e.message : "Your account is ready, but the code couldn't be created just yet.";
      return json(200, { affiliate: publicProfile(await deps.affiliate(claims.sub)), warning: message });
    }
  }

  return json(200, { affiliate: publicProfile(await deps.affiliate(claims.sub)) });
}

/** What an affiliate may know about themselves. (There is nothing else in the row.) */
function publicProfile(profile: AffiliateProfile | undefined) {
  if (!profile) return null;
  return {
    displayName: profile.displayName,
    email: profile.email,
    status: profile.status,
    code: profile.code,
    createdDay: profile.createdDay,
    placements: profile.placements ?? [],
  };
}

// ── real-world wiring ───────────────────────────────────────────────────────────────────

let jwksCache: Jwk[] | undefined;
const issuer = () => `https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}`;

async function jwks(force = false): Promise<Jwk[]> {
  if (jwksCache && !force) return jwksCache;
  const res = await fetch(`${issuer()}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = body.keys ?? [];
  return jwksCache;
}

async function authenticate(headers: Record<string, string | undefined>): Promise<AffiliateClaims | undefined> {
  const token = bearerToken(headers);
  if (!token) return undefined;
  const opts = { issuer: issuer(), clientId: CLIENT_ID, now: Math.floor(Date.now() / 1000) };
  try {
    return verifyJwt(token, { ...opts, jwks: await jwks() });
  } catch {
    // A miss may just mean Cognito rotated its signing keys — refetch once before giving up.
    try {
      return verifyJwt(token, { ...opts, jwks: await jwks(true) });
    } catch {
      return undefined;
    }
  }
}

/** The restricted promotion-codes key, cached for the life of the container. */
let cachedKey: string | undefined;
async function stripeKey(): Promise<string> {
  if (cachedKey !== undefined) return cachedKey;
  const out = await ssm.send(new GetParameterCommand({ Name: API_KEY_PARAM, WithDecryption: true }));
  cachedKey = out.Parameter?.Value ?? "";
  return cachedKey;
}

const ledger = new DynamoLedger(db, TABLE);

async function config(sk: string): Promise<Record<string, { S?: string }>> {
  const out = await db.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: CFG_PK }, sk: { S: sk } } }));
  return (out.Item ?? {}) as Record<string, { S?: string }>;
}

/** Enrolments per address per hour. Hashed and self-deleting — see the note in the deps. */
const ENROLMENTS_PER_HOUR = 10;

const liveDeps: PortalDeps = {
  authenticate,
  region: REGION,
  clientId: CLIENT_ID,
  today: () => new Date().toISOString().slice(0, 10),
  async branding() {
    const item = await config(CFG_SK_PORTAL);
    return item.branding?.S ? sanitizeBranding(JSON.parse(item.branding.S)) : { ...DEFAULT_BRANDING };
  },
  async settings() {
    const item = await config(CFG_SK_PORTAL);
    return sanitizeSettings(item.settings?.S ? JSON.parse(item.settings.S) : undefined);
  },
  async couponId() {
    return (await config(CFG_SK_STRIPE)).couponId?.S ?? "";
  },
  affiliate: (affId) => ledger.affiliate(affId),
  createAffiliate: (profile) => ledger.createAffiliate(profile),
  totalsFor: (affId) => ledger.totalsFor(affId),
  ledgerFor: (affId) => ledger.ledgerFor(affId),
  setPlacements: (affId, placements) => ledger.setPlacements(affId, placements),
  async countAffiliates() {
    // Count rows in the directory partition rather than reading every profile.
    let count = 0;
    let startKey: Record<string, { S?: string }> | undefined;
    do {
      const out = await db.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: "pk = :p",
          ExpressionAttributeValues: { ":p": { S: DIR_PK } },
          Select: "COUNT",
          ExclusiveStartKey: startKey as never,
        }),
      );
      count += out.Count ?? 0;
      startKey = out.LastEvaluatedKey as never;
    } while (startKey);
    return count;
  },
  async issueCode({ affId, displayName, couponId }) {
    const stripe = new StripeClient({ apiKey: await stripeKey() });
    await issueCodeFor({ affId, displayName, couponId, issuer: stripe, registry: ledger });
  },
  async allowEnrolment(sourceIp) {
    if (!sourceIp) return true;
    // The address is HASHED and the row expires within the hour: we get abuse protection
    // without keeping a log of who visited the merchant's affiliate page. (The affiliates we
    // do keep are partners who gave us their details on purpose — visitors are not.)
    const hour = Math.floor(Date.now() / 3_600_000);
    const bucket = `${hour}#${createHash("sha256").update(sourceIp).digest("hex").slice(0, 16)}`;
    const key = { pk: { S: RATE_PK }, sk: { S: rateSk(bucket) } };
    const existing = await db.send(new GetItemCommand({ TableName: TABLE, Key: key }));
    const count = Number(existing.Item?.count?.N ?? "0");
    if (count >= ENROLMENTS_PER_HOUR) return false;
    await db.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: { ...key, count: { N: String(count + 1) }, expiresAt: { N: String(Math.floor(Date.now() / 1000) + 3600) } },
      }),
    );
    return true;
  },
};

/** Lambda Function URL entrypoint. */
export async function handler(event: {
  requestContext?: { http?: { method?: string; path?: string; sourceIp?: string } };
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}): Promise<HttpResponse> {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : (event.body ?? "");
  try {
    return await route(
      {
        method,
        path,
        headers: event.headers ?? {},
        body,
        sourceIp: event.requestContext?.http?.sourceIp ?? "",
      },
      liveDeps,
    );
  } catch (e) {
    // Never leak a stack trace, a table name or a Stripe error to an affiliate's browser.
    console.error("[affiliatepoppy] portal error", e);
    return json(500, { error: "something went wrong" });
  }
}
