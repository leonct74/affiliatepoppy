// The stack lifecycle: deploy, report live status, tear down.
//
// The template is EMBEDDED in this bundle (backend-bundle.ts, generated from infra/ +
// lambdas/), so the merchant never needs cdk, node, or an internet round-trip to a template
// store. Everything except the deploy bucket and the two Stripe secrets lives inside the one
// stack, so a DeleteStack removes almost the whole footprint; the two exceptions are swept by
// teardown() below.
//
// Everything here takes its AWS clients by injection so the lifecycle logic is unit-testable
// without touching AWS.

import {
  ContinueUpdateRollbackCommand,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackDeleteComplete,
  type Capability,
  type CloudFormationClient,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SSMClient } from "@aws-sdk/client-ssm";
import {
  stackName,
  tableName,
  templateJson,
  templateKey,
  lambdaCodeKey,
  lambdaZipBase64,
  sourceCommit,
} from "./generated/backend-bundle";
import { deployBucketName, ensureDeployBucket, uploadLambdaCode, deleteDeployBucket } from "./deploy-bucket";
import { forgetSecrets } from "./secrets";
import { stackTags, type AttributionContext } from "./tags";

export { stackName, tableName, templateKey };

/** Everything the stack lifecycle needs to reach AWS. Clients injected → unit-testable. */
export interface AwsCtx {
  cfn: CloudFormationClient;
  s3: S3Client;
  ssm: SSMClient;
  region: string;
  accountId: string;
}

/** The stack creates named IAM roles, so CloudFormation needs these acknowledged. */
const CAPABILITIES: Capability[] = ["CAPABILITY_NAMED_IAM"];

/** How the UI should treat the stack right now — derived from AWS, never remembered. */
export type DeploymentPhase = "none" | "deploying" | "ready" | "removing" | "failed";

export interface DeploymentStatus {
  phase: DeploymentPhase;
  /** The raw CloudFormation StackStatus, for the technical/details view. */
  stackStatus?: string;
  stackName: string;
  region: string;
  tableName?: string;
  /** True while AWS is still working — the UI polls on this (AGENTS.md §5). */
  inProgress: boolean;
  /** One calm sentence for the user when something went wrong. */
  message?: string;
  /** The raw CloudFormation reason for a failure — for the technical details view. */
  failureReason?: string;
  /** The template this deployment actually runs, vs. the one this build ships. */
  deployedTemplateKey?: string;
  currentTemplateKey: string;
  updateAvailable: boolean;
  /** The webhook endpoint the merchant pastes into Stripe. */
  receiverUrl?: string;
  /** The affiliate portal — the link the merchant shares. */
  portalUrl?: string;
  affiliatePoolId?: string;
}

export type StackOperation = "CREATE" | "UPDATE" | "NO_CHANGE" | "RECREATE";

/** The tag recording WHICH template a stack runs — the NO_CHANGE cross-check. */
export const TEMPLATE_KEY_TAG = "affiliatepoppy:templateKey";

/** CloudFormation statuses that mean "AWS is mid-operation, poll me". */
const IN_PROGRESS = /_IN_PROGRESS$/;
/** Statuses that mean the last operation left the stack unusable. */
const FAILED = /(ROLLBACK_COMPLETE|ROLLBACK_FAILED|_FAILED)$/;

/** True when DescribeStacks says the stack simply isn't there. */
function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  return err?.name === "ValidationError" && /does not exist/i.test(err?.message ?? "");
}

/** The stack as AWS currently has it, or null if it doesn't exist. */
async function describe(cfn: CloudFormationClient, name: string): Promise<Stack | null> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    return out.Stacks?.[0] ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function phaseOf(status: string | undefined): DeploymentPhase {
  if (!status) return "none";
  if (status.startsWith("DELETE") && IN_PROGRESS.test(status)) return "removing";
  if (IN_PROGRESS.test(status)) return "deploying";
  if (FAILED.test(status)) return "failed";
  if (status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE") return "ready";
  return "deploying";
}

/**
 * Read the live deployment state straight from CloudFormation.
 *
 * This is the whole of AGENTS.md §5: the UI holds no memory of a deploy. It calls this on
 * every mount and derives where the user is from what's really in their account, so leaving
 * mid-deploy and coming back lands on live progress rather than a dead spinner.
 */
export async function getStatus(ctx: AwsCtx): Promise<DeploymentStatus> {
  const { cfn, region } = ctx;
  const stack = await describe(cfn, stackName);
  const stackStatus = stack?.StackStatus;
  const phase = phaseOf(stackStatus);
  const deployedTemplateKey = stack?.Tags?.find((t) => t.Key === TEMPLATE_KEY_TAG)?.Value;
  // The deployed Lambda-code key rides as a stack PARAMETER — a code-only change moves it
  // while the template key stays put, so updateAvailable must watch BOTH. (TrafficPoppy's
  // live lesson: a code-only release was invisible to the UI.)
  const deployedCodeKey = stack?.Parameters?.find((p) => p.ParameterKey === "LambdaCodeKey")?.ParameterValue;
  const output = (key: string) => stack?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue;

  // On a failure, pull the actual reason from the stack's events so the details view shows WHY
  // (e.g. an AccessDenied on a specific action), not just "it rolled back". Best-effort and
  // read-only — a permission gap here must never mask the failure itself.
  const failureReason = phase === "failed" ? await firstFailureReason(cfn) : undefined;

  return {
    phase,
    stackStatus,
    stackName,
    region,
    tableName: phase === "ready" ? tableName : undefined,
    inProgress: !!stackStatus && IN_PROGRESS.test(stackStatus),
    message: phase === "failed" ? failureMessage(stackStatus) : undefined,
    failureReason,
    deployedTemplateKey,
    currentTemplateKey: templateKey,
    // Only meaningful once we know what's deployed; a stack from before this tag existed
    // reports no key and we don't nag about an update we can't substantiate.
    updateAvailable:
      (!!deployedTemplateKey && deployedTemplateKey !== templateKey) ||
      (!!deployedCodeKey && deployedCodeKey !== lambdaCodeKey),
    receiverUrl: phase === "ready" ? output("ReceiverUrl") : undefined,
    portalUrl: phase === "ready" ? output("PortalUrl") : undefined,
    affiliatePoolId: output("AffiliatePoolId"),
  };
}

/**
 * The raw reason CloudFormation gives for the first resource that failed — the root-cause
 * event, which the later CREATE_FAILED/ROLLBACK noise buries.
 */
async function firstFailureReason(cfn: CloudFormationClient): Promise<string | undefined> {
  try {
    const out = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    // Events are newest-first; the earliest *_FAILED with a reason is the trigger. Ignore the
    // boilerplate rollback reason CloudFormation stamps on the stack itself.
    const failures = (out.StackEvents ?? []).filter(
      (e) =>
        e.ResourceStatus?.endsWith("_FAILED") &&
        e.ResourceStatusReason &&
        !/resource creation cancelled/i.test(e.ResourceStatusReason),
    );
    return failures[failures.length - 1]?.ResourceStatusReason;
  } catch {
    return undefined;
  }
}

function failureMessage(status: string | undefined): string {
  if (status === "ROLLBACK_COMPLETE" || status === "ROLLBACK_FAILED") {
    return "The last setup attempt didn't finish and AWS undid it. You can safely try again.";
  }
  return "Something went wrong in your AWS account during the last change. You can try again, or remove AffiliatePoppy and start fresh.";
}

export interface DeployResult {
  operation: StackOperation;
  stackName: string;
  templateKey: string;
}

/**
 * The `PermissionsBoundaryArn` the template's roles are capped by on THIS deploy
 * (broker-role-v2 step 2). Precedence, fail-safe in both directions:
 *
 *  - the host CONFIRMED the boundary policy exists (it sent the ARN in the bootstrap) → use
 *    it; naming it only when confirmed is what stops CreateRole failing on a missing policy;
 *  - the stack is one deploy() is about to DELETE and recreate → nothing to preserve (below);
 *  - otherwise PRESERVE whatever the deployed stack already carries. "Absent from the
 *    bootstrap" also covers a transient host-side read, and a code update must never strip an
 *    applied boundary because of a hiccup;
 *  - nothing deployed yet → empty, i.e. unbounded, which is the only thing that works before
 *    the account has the policy.
 *
 * Pure, and takes the stack the deploy already described — the boundary is not worth a second
 * DescribeStacks. NB the caller must pass `null` ONLY for a stack that positively does not
 * exist: a stack we merely failed to read is not "no boundary" (see deploy()).
 */
export function boundaryParameterValue(confirmedArn: string | undefined, deployed: Stack | null): string {
  if (confirmedArn) return confirmedArn;
  // A dead stack is deleted and recreated below, so it has no live roles left to protect —
  // preserving its ARN buys no safety and costs a lot: it names an UNCONFIRMED policy in a
  // fresh CreateRole. If that policy is absent, IAM refuses, the create rolls back carrying
  // the same bad ARN, the user retries, and it fails again — a self-perpetuating outage.
  if (deployed?.StackStatus && RECREATE_STATUSES.has(deployed.StackStatus)) return "";
  return deployed?.Parameters?.find((p) => p.ParameterKey === BOUNDARY_PARAM)?.ParameterValue ?? "";
}

/** The template parameter carrying the boundary — see infra/src/template.ts. */
const BOUNDARY_PARAM = "PermissionsBoundaryArn";

/**
 * Statuses a stack cannot be updated out of: deploy() deletes and recreates instead. Shared
 * with boundaryParameterValue so "this stack is about to die" can never mean two things.
 */
const RECREATE_STATUSES = new Set(["ROLLBACK_COMPLETE", "REVIEW_IN_PROGRESS"]);

/** What we say when we could not read the stack — see the catch in deploy(). */
export const STACK_READ_FAILED =
  "Couldn't read your AffiliatePoppy stack in AWS, so we stopped rather than risk changing it blindly.";

/**
 * Create or update the stack. Returns as soon as AWS accepts the request — the work runs in
 * the background (AGENTS.md §5); poll getStatus for completion.
 *
 * `permissionsBoundaryArn` comes from the bootstrap and is only ever set when the host has
 * confirmed the boundary policy is in the account (boundaryParameterValue).
 */
export async function deploy(
  ctx: AwsCtx,
  attribution: AttributionContext,
  permissionsBoundaryArn?: string,
): Promise<DeployResult> {
  const { cfn, s3, region, accountId } = ctx;
  // The stack MUST carry attribution or AgentsPoppy can neither show nor tear down what we
  // made — so refuse rather than deploy an untrackable footprint.
  if (!attribution.accountId || !attribution.connectionId) {
    throw new Error(
      "AffiliatePoppy isn't connected to your AWS account yet. Approve it in AgentsPoppy, then try again.",
    );
  }

  const attrTags = stackTags({ ...attribution, sourceCommit: sourceCommit || undefined });
  const Tags = [...attrTags, { Key: TEMPLATE_KEY_TAG, Value: templateKey }];

  // The deploy bucket is out-of-stack — tag it as ours so it's swept up, and upload the code
  // the stack will reference.
  const bucket = deployBucketName(accountId, region);
  await ensureDeployBucket(s3, bucket, region, attrTags);
  await uploadLambdaCode(s3, bucket, lambdaCodeKey, lambdaZipBase64);

  // Described before the parameters are built: the boundary's "preserve what's deployed"
  // fallback reads this same stack, and the create/update branches below need it anyway.
  //
  // describe() returns null ONLY for a positive "does not exist"; every other failure throws,
  // and must. "No stack" and "couldn't read the stack" answering alike would send
  // CloudFormation an empty PermissionsBoundaryArn on an existing stack, which STRIPS the
  // boundary off every role in it — a security ceiling removed by a throttle or a dropped
  // connection, with nothing shown to the user. So a read failure aborts, in plain words.
  let existing: Stack | null;
  try {
    existing = await describe(cfn, stackName);
  } catch (e) {
    throw new Error(`${STACK_READ_FAILED} Try again in a moment. (${(e as Error).message})`);
  }
  const status = existing?.StackStatus;

  const Parameters = [
    { ParameterKey: "LambdaCodeBucket", ParameterValue: bucket },
    { ParameterKey: "LambdaCodeKey", ParameterValue: lambdaCodeKey },
    // The affiliate pool is born tagged from these rather than relying on stack-tag
    // propagation (which TrafficPoppy proved is not universal). A pool's ARN carries a random
    // id, so its grant can only be tag-scoped: these two are load-bearing.
    { ParameterKey: "AttrAccountId", ParameterValue: attribution.accountId },
    { ParameterKey: "AttrConnectionId", ParameterValue: attribution.connectionId },
    // Always an explicit value, never UsePreviousValue: that fails on the first update after
    // the template gains a parameter, which is exactly the update every existing stack is
    // about to take.
    { ParameterKey: BOUNDARY_PARAM, ParameterValue: boundaryParameterValue(permissionsBoundaryArn, existing) },
  ];
  const args = {
    StackName: stackName,
    TemplateBody: templateJson,
    Parameters,
    Capabilities: CAPABILITIES,
    Tags,
  };

  // A previous failed create leaves ROLLBACK_COMPLETE: it can't be updated, and creating over
  // it fails until it's fully gone. Delete, wait, recreate.
  if (status && RECREATE_STATUSES.has(status)) {
    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 300 }, { StackName: stackName });
    await cfn.send(new CreateStackCommand(args));
    return { operation: "RECREATE", stackName, templateKey };
  }

  if (!status) {
    await cfn.send(new CreateStackCommand(args));
    return { operation: "CREATE", stackName, templateKey };
  }

  // A failed update whose rollback ALSO failed strands the stack: it can only leave
  // UPDATE_ROLLBACK_FAILED via ContinueUpdateRollback — or a delete, which would destroy the
  // Function URLs and silently break the merchant's registered Stripe webhook and every
  // portal link their affiliates have bookmarked. So: finish the rollback, then update.
  if (status === "UPDATE_ROLLBACK_FAILED") {
    await cfn.send(new ContinueUpdateRollbackCommand({ StackName: stackName }));
    const settled = await waitUntilRollbackSettles(cfn);
    if (settled !== "UPDATE_ROLLBACK_COMPLETE") {
      throw new Error(`The previous change could not be rolled back (stack is ${settled}).`);
    }
  }

  try {
    await cfn.send(new UpdateStackCommand(args));
    return { operation: "UPDATE", stackName, templateKey };
  } catch (e) {
    // Not an error: the account already runs exactly this template + code.
    if (/No updates are to be performed/i.test((e as Error).message ?? "")) {
      return { operation: "NO_CHANGE", stackName, templateKey };
    }
    throw e;
  }
}

/** Poll until a continued rollback stops being in-progress; returns the final status. */
async function waitUntilRollbackSettles(cfn: CloudFormationClient): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const stack = await describe(cfn, stackName);
    const status = stack?.StackStatus ?? "";
    if (!IN_PROGRESS.test(status)) return status;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Timed out waiting for the previous change to finish rolling back.");
}

export interface TeardownResult {
  /** What we actually asked AWS to remove (empty when there was nothing left). */
  removed: string[];
}

/**
 * The teardown hook (AGENTS.md §4). The host POSTs this at the START of teardown, then deletes
 * our stack itself — but certification runs with the host's cleanup OFF, so this must do the
 * real work on its own.
 *
 * MUST be idempotent: it can run more than once, including after a partial teardown, and
 * "already gone" is a success, not an error.
 *
 * Three things to remove: the stack (table, Lambdas, roles, log groups, Function URLs, the
 * affiliate pool — all in-stack), the deploy bucket, and the merchant's Stripe secrets. The
 * secrets go FIRST: they are the only thing here that would be genuinely harmful to leave
 * behind, and they are useless the moment the Lambdas are gone anyway.
 */
export async function teardown(ctx: AwsCtx): Promise<TeardownResult> {
  const { cfn, s3, ssm, region, accountId } = ctx;
  const removed: string[] = [];

  removed.push(...(await forgetSecrets(ssm)));

  const stack = await describe(cfn, stackName);
  if (stack) {
    if (stack.StackStatus !== "DELETE_IN_PROGRESS") {
      await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    }
    // Wait for the delete to actually land: returning early would report success while the
    // table still exists, and certification's tag sweep would (correctly) find it.
    await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 600 }, { StackName: stackName });
    removed.push(stackName);
  }

  // The out-of-stack deploy bucket, last: never pull the Lambda code out from under an
  // in-flight stack operation. (Idempotent — a missing bucket is success.)
  const bucket = deployBucketName(accountId, region);
  if (await deleteDeployBucket(s3, bucket)) removed.push(bucket);

  return { removed };
}
