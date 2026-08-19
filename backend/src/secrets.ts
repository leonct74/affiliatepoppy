// The merchant's two Stripe secrets, kept in THEIR OWN account's parameter store.
//
// Why SSM and not the stack: a CloudFormation parameter is stored in the stack's own history
// and shown by DescribeStacks — putting a secret there would leave it readable to anyone who
// can describe the stack, forever. Why SSM and not DynamoDB: SecureString is encrypted with
// the account's KMS key and the Lambda roles are scoped to one parameter each, so the webhook
// receiver cannot read the key that creates promotion codes and vice versa.
//
// THE RULE FOR THIS FILE: a secret goes IN from the merchant's own paste and comes back out
// only inside the merchant's own AWS. Nothing here ever returns a secret to the frontend — the
// UI is told "saved, ending in …abc" and nothing more, so a screen-share or a screenshot of
// the poppy can never leak the key. (`describeSecrets` below is the only read the UI gets.)

import {
  AddTagsToResourceCommand,
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import { SSM_API_KEY, SSM_CONNECT_WEBHOOK_SECRET, SSM_WEBHOOK_SECRET } from "../../infra/src/template";
import type { AttributionContext } from "./tags";
import { APP_ID, TAG_ACCOUNT, TAG_APP, TAG_CONNECTION } from "./tags";

export const SECRET_NAMES = {
  webhookSecret: SSM_WEBHOOK_SECRET,
  apiKey: SSM_API_KEY,
  /** P7, optional: the "connected accounts" endpoint's own signing secret. */
  connectSecret: SSM_CONNECT_WEBHOOK_SECRET,
} as const;
export type SecretName = keyof typeof SECRET_NAMES;

/** What the UI may know about a stored secret: that it exists, and its last four characters. */
export interface SecretStatus {
  stored: boolean;
  /** e.g. "…a4f2" — enough to check you pasted the right one, useless to anyone else. */
  hint: string;
}

const isMissing = (e: unknown) => (e as { name?: string })?.name === "ParameterNotFound";

/** Store (or replace) one secret, tagged as ours so teardown and the host's sweep can see it. */
export async function putSecret(
  ssm: SSMClient,
  which: SecretName,
  value: string,
  attribution: AttributionContext,
): Promise<SecretStatus> {
  const Name = SECRET_NAMES[which];
  const trimmed = value.trim();
  if (!trimmed) throw new Error("That value was empty — paste the whole secret from Stripe.");

  await ssm.send(
    new PutParameterCommand({
      Name,
      Value: trimmed,
      Type: "SecureString",
      Overwrite: true,
      Description: "AffiliatePoppy — created by AgentsPoppy. Safe to delete once the poppy is removed.",
    }),
  );
  // Tags go in a SEPARATE call on purpose: PutParameter refuses Tags together with
  // Overwrite:true, so tagging inline would work on the first save and fail on every edit.
  await ssm.send(
    new AddTagsToResourceCommand({
      ResourceType: "Parameter",
      // AddTagsToResource wants the parameter's NAME without the leading slash.
      ResourceId: Name.replace(/^\//, ""),
      Tags: [
        { Key: TAG_ACCOUNT, Value: attribution.accountId },
        { Key: TAG_APP, Value: APP_ID },
        { Key: TAG_CONNECTION, Value: attribution.connectionId },
      ],
    }),
  );
  return { stored: true, hint: hintFor(trimmed) };
}

/** Read a secret — for our own AWS-side use only. Never route this to the frontend. */
export async function readSecret(ssm: SSMClient, which: SecretName): Promise<string> {
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: SECRET_NAMES[which], WithDecryption: true }));
    return out.Parameter?.Value ?? "";
  } catch (e) {
    if (isMissing(e)) return "";
    throw e;
  }
}

/** What the Setup tab renders: whether each secret is stored, and its harmless hint. */
export async function describeSecrets(ssm: SSMClient): Promise<Record<SecretName, SecretStatus>> {
  const entries = await Promise.all(
    (Object.keys(SECRET_NAMES) as SecretName[]).map(async (which) => {
      const value = await readSecret(ssm, which);
      return [which, { stored: !!value, hint: value ? hintFor(value) : "" }] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<SecretName, SecretStatus>;
}

/** Delete every secret. Idempotent — "already gone" is success. Returns what was removed. */
export async function forgetSecrets(ssm: SSMClient): Promise<string[]> {
  const removed: string[] = [];
  for (const Name of Object.values(SECRET_NAMES)) {
    try {
      await ssm.send(new DeleteParameterCommand({ Name }));
      removed.push(Name);
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
  }
  return removed;
}

function hintFor(value: string): string {
  return `…${value.slice(-4)}`;
}
