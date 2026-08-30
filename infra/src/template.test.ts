// The template, checked against the two things it must never drift from: the manifest's
// declared permissions, and the leaves-no-trace promise.
//
// Almost every assertion here exists because the family has PAID for it on a live deploy —
// a stack that creates the table and then rolls back on an AccessDenied nobody could see
// coming. A permission gap is invisible in review and expensive in production, so it is
// tested here instead.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildTemplate,
  PASSWORD_POLICY,
  PORTAL_FUNCTION_NAME,
  RECEIVER_FUNCTION_NAME,
  SSM_API_KEY,
  SSM_WEBHOOK_SECRET,
  STACK_NAME,
  TABLE_NAME,
  TTL_ATTRIBUTE,
} from "./template";

const template = buildTemplate();
const R = template.Resources as Record<string, { Type: string; Properties: Record<string, any>; DependsOn?: string[] }>;
const table = R.LedgerTable!;

/** The statements of a role's inline policy. */
const statementsOf = (roleName: string) =>
  R[roleName]!.Properties.Policies[0].PolicyDocument.Statement as {
    Action: string | string[];
    Resource: unknown;
  }[];

const statementFor = (roleName: string, service: string) =>
  statementsOf(roleName).find((s) => JSON.stringify(s.Action).includes(service))!;

describe("the ledger table", () => {
  it("bills on demand, so a programme with no sales costs ~$0", () => {
    expect(table.Properties.BillingMode).toBe("PAY_PER_REQUEST");
    expect(table.Properties).not.toHaveProperty("ProvisionedThroughput");
  });

  it("keys on (pk, sk) for the single-table design", () => {
    expect(table.Properties.KeySchema).toEqual([
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ]);
  });

  it("declares the TTL attribute from day one, so the portal's rate-limit rows can expire", () => {
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: TTL_ATTRIBUTE, Enabled: true });
  });

  it("is pure — two builds produce identical bytes", () => {
    // The build script content-addresses the template; a nondeterministic builder would make
    // the hash differ per machine, and every deploy would look like a change.
    expect(JSON.stringify(buildTemplate())).toBe(JSON.stringify(buildTemplate()));
  });
});

describe("the receiver — the endpoint Stripe calls", () => {
  it("is reachable by Stripe: a public Function URL with BOTH invoke permissions", () => {
    // With only InvokeFunctionUrl, anonymous requests 403 "even if the function URL uses the
    // NONE auth type" (docs: urls-auth). A full live-debugging day says never again.
    expect(R.ReceiverUrl!.Properties.AuthType).toBe("NONE");
    expect(R.ReceiverUrlPermission!.Properties.Action).toBe("lambda:InvokeFunctionUrl");
    expect(R.ReceiverUrlPermission!.Properties.FunctionUrlAuthType).toBe("NONE");
    expect(R.ReceiverUrlInvokePermission!.Properties.Action).toBe("lambda:InvokeFunction");
    // Gated to URL-originated calls only — never open direct SDK invocation to the world.
    expect(R.ReceiverUrlInvokePermission!.Properties.InvokedViaFunctionUrl).toBe(true);
  });

  it("CANNOT read the Stripe API key — only the signing secret it needs", () => {
    // The receiver is reachable by the whole internet. It has no business being able to
    // create promotion codes, so the key that can is not in its policy at all.
    const ssm = statementFor("ReceiverRole", "ssm");
    const resource = JSON.stringify(ssm.Resource);
    expect(resource).toContain(SSM_WEBHOOK_SECRET);
    expect(resource).not.toContain(SSM_API_KEY);
  });

  it("cannot delete a single ledger row, only add to the ledger", () => {
    const dynamo = statementFor("ReceiverRole", "dynamodb");
    expect(dynamo.Action).not.toContain("dynamodb:DeleteItem");
    expect(dynamo.Action).not.toContain("dynamodb:DeleteTable");
    // Scoped to the table's own ARN — never "*".
    expect(dynamo.Resource).toEqual({ "Fn::GetAtt": ["LedgerTable", "Arn"] });
  });

  it("builds its log-group ARN by name (Fn::Sub), never Fn::GetAtt on the LogGroup", () => {
    // Live-deploy lesson: GetAtt on a LogGroup Arn makes CloudFormation call
    // logs:DescribeLogGroups, which cannot be scoped in a session policy → deploy denied.
    const logs = statementFor("ReceiverRole", "logs");
    expect(JSON.stringify(logs.Resource)).not.toContain("GetAtt");
    expect((logs.Resource as { "Fn::Sub": string })["Fn::Sub"]).toContain(
      `log-group:/aws/lambda/${RECEIVER_FUNCTION_NAME}`,
    );
  });
});

describe("the portal — the page affiliates use", () => {
  it("shares ONE code artifact with the receiver (one key to upload and compare)", () => {
    expect(R.Portal!.Properties.Code).toEqual(R.Receiver!.Properties.Code);
    expect(R.Portal!.Properties.Handler).toBe("portal.handler");
    expect(R.Receiver!.Properties.Handler).toBe("receiver.handler");
  });

  it("holds the promotion-codes key and NOT the webhook signing secret", () => {
    const ssm = statementFor("PortalRole", "ssm");
    const resource = JSON.stringify(ssm.Resource);
    expect(resource).toContain(SSM_API_KEY);
    expect(resource).not.toContain(SSM_WEBHOOK_SECRET);
  });

  it("lets affiliates sign THEMSELVES up — the whole point of one shared link (D10)", () => {
    expect(R.AffiliatePool!.Properties.AdminCreateUserConfig).toEqual({ AllowAdminCreateUserOnly: false });
    expect(R.AffiliatePool!.Properties.AutoVerifiedAttributes).toEqual(["email"]);
    // Cognito's own sender: nothing for the merchant to verify in SES before their first
    // affiliate can enrol.
    expect(R.AffiliatePool!.Properties.EmailConfiguration.EmailSendingAccount).toBe("COGNITO_DEFAULT");
  });

  it("enforces exactly the password rule the portal page tells people", () => {
    expect(R.AffiliatePool!.Properties.Policies).toEqual({ PasswordPolicy: { ...PASSWORD_POLICY } });
  });

  it("keeps affiliates signed in, but loses a removed one within the hour", () => {
    const client = R.AffiliatePoolClient!.Properties;
    expect(client.RefreshTokenValidity).toBe(3650);
    expect(client.ExplicitAuthFlows).toContain("ALLOW_REFRESH_TOKEN_AUTH");
    expect(client.IdTokenValidity).toBe(60);
    expect(client.TokenValidityUnits.IdToken).toBe("minutes");
  });

  it("is born TAGGED, because a pool's ARN cannot be name-scoped", () => {
    // A user pool's ARN embeds a random id, so its grant is tag-scoped — which makes the tags
    // load-bearing rather than cosmetic. CloudFormation's propagation is not universal (the
    // ACM handler dropped them entirely on TrafficPoppy), so we set them explicitly.
    const tags = R.AffiliatePool!.Properties.UserPoolTags;
    expect(tags["agentspoppy:app"]).toBe("com.affiliatepoppy.desktop");
    expect(tags["agentspoppy:account"]).toEqual({ Ref: "AttrAccountId" });
    expect(tags["agentspoppy:connection"]).toEqual({ Ref: "AttrConnectionId" });
  });

  it("names every function and role under the prefix the manifest is scoped to", () => {
    for (const name of [RECEIVER_FUNCTION_NAME, PORTAL_FUNCTION_NAME]) expect(name).toMatch(/^AffiliatePoppy/);
    expect(R.ReceiverRole!.Properties.RoleName).toMatch(/^AffiliatePoppy/);
    expect(R.PortalRole!.Properties.RoleName).toMatch(/^AffiliatePoppy/);
  });
});

describe("no secret is ever written into the stack", () => {
  it("passes only non-secret parameters — a Stripe key would live in CloudFormation history forever", () => {
    const parameters = Object.keys(template.Parameters ?? {});
    expect(parameters.sort()).toEqual([
      "AttrAccountId",
      "AttrConnectionId",
      "LambdaCodeBucket",
      "LambdaCodeKey",
      "PermissionsBoundaryArn",
    ]);
    // The template may name WHERE a secret lives, but must never carry its value.
    const serialised = JSON.stringify(template);
    expect(serialised).toContain(SSM_WEBHOOK_SECRET); // the parameter path, by name
    expect(serialised).not.toMatch(/whsec_|rk_live|sk_live|rk_test|sk_test/);
  });
});

describe("the AgentsPoppy permissions boundary (broker-role-v2 step 2)", () => {
  const roles = Object.entries(R).filter(([, r]) => r.Type === "AWS::IAM::Role");

  it("takes the boundary as an optional parameter, defaulting to none", () => {
    // A hard-coded ARN would break every deploy in an account that doesn't have the policy
    // yet: IAM refuses CreateRole outright when the named boundary doesn't exist.
    const param = (template.Parameters as Record<string, { Type: string; Default?: string }>).PermissionsBoundaryArn!;
    expect(param.Type).toBe("String");
    expect(param.Default).toBe("");
  });

  it("applies it only when one was passed", () => {
    expect((template.Conditions as Record<string, unknown>).HasPermissionsBoundary).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "PermissionsBoundaryArn" }, ""] }],
    });
  });

  it("caps EVERY role in the stack — a role added later must not slip through", () => {
    expect(roles.map(([name]) => name).sort()).toEqual(["PortalRole", "ReceiverRole"]);
    for (const [name, role] of roles) {
      expect(role.Properties.PermissionsBoundary, `${name} must be capped by the boundary`).toEqual({
        "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: "AWS::NoValue" }],
      });
    }
  });

  it("caps, never grants — no execution policy is touched by it", () => {
    // The safety argument for shipping this at all: the boundary is a ceiling on the role, so
    // the policies the Lambdas actually run on are the same with it and without it, and no
    // Lambda can lose a permission by gaining one.
    for (const [name, role] of roles) {
      expect(JSON.stringify(role.Properties.Policies), `${name}'s own policy must not mention the boundary`)
        .not.toContain("PermissionsBoundary");
    }
  });
});

describe("leaves no trace (AGENTS.md §4)", () => {
  const resources = Object.entries(template.Resources) as [
    string,
    { DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties?: Record<string, unknown> },
  ][];

  it("retains nothing — deleting the stack must remove the whole footprint", () => {
    for (const [name, r] of resources) {
      expect(r.DeletionPolicy, `${name} must not be retained on delete`).not.toBe("Retain");
      expect(r.UpdateReplacePolicy, `${name} must not be retained on replace`).not.toBe("Retain");
    }
  });

  it("never enables deletion protection — CloudFormation could not then delete the table", () => {
    for (const [name, r] of resources) {
      expect(r.Properties?.DeletionProtectionEnabled, `${name} must stay deletable`).toBeUndefined();
    }
  });

  it("owns both log groups in-stack, so neither is orphaned by teardown", () => {
    for (const group of ["ReceiverLogGroup", "PortalLogGroup"]) {
      expect(R[group]!.Type).toBe("AWS::Logs::LogGroup");
      expect(R[group]!.Properties.RetentionInDays).toBeGreaterThan(0);
    }
  });
});

describe("the template stays in lockstep with the manifest's declared scope", () => {
  // AGENTS.md §6: "Keep it in lockstep with your real IAM deploy policy." If a resource ever
  // gets a name our grants don't cover, the deploy fails in the merchant's account with an
  // AccessDenied — this catches it here instead.
  const manifest = JSON.parse(readFileSync(new URL("../../extension.json", import.meta.url), "utf8")) as {
    permissionSet: { grants: { service: string; actions: string[]; resourceScope: string }[] };
  };
  const grantsFor = (service: string) => manifest.permissionSet.grants.filter((g) => g.service === service);
  const actionsOf = (service: string) => grantsFor(service).flatMap((g) => g.actions);

  /** Does an AWS ARN pattern (with `*` wildcards) cover this concrete ARN? */
  const covers = (pattern: string, arn: string) =>
    new RegExp(
      `^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
    ).test(arn);

  const anyGrantCovers = (service: string, arn: string) => grantsFor(service).some((g) => covers(g.resourceScope, arn));

  it("covers the table, the stack, the functions and the roles we actually create", () => {
    expect(anyGrantCovers("dynamodb", `arn:aws:dynamodb:eu-west-1:123456789012:table/${TABLE_NAME}`)).toBe(true);
    expect(anyGrantCovers("cloudformation", `arn:aws:cloudformation:eu-west-1:123456789012:stack/${STACK_NAME}/abc`)).toBe(true);
    for (const fn of [RECEIVER_FUNCTION_NAME, PORTAL_FUNCTION_NAME]) {
      expect(anyGrantCovers("lambda", `arn:aws:lambda:eu-west-1:123456789012:function:${fn}`)).toBe(true);
    }
    for (const role of [R.ReceiverRole!.Properties.RoleName, R.PortalRole!.Properties.RoleName]) {
      expect(anyGrantCovers("iam", `arn:aws:iam::123456789012:role/${role}`)).toBe(true);
    }
  });

  it("covers BOTH Stripe secrets' parameter paths", () => {
    for (const name of [SSM_WEBHOOK_SECRET, SSM_API_KEY]) {
      expect(anyGrantCovers("ssm", `arn:aws:ssm:eu-west-1:123456789012:parameter${name}`)).toBe(true);
    }
  });

  it("does not cover a resource that isn't ours", () => {
    expect(anyGrantCovers("dynamodb", "arn:aws:dynamodb:eu-west-1:123456789012:table/CustomerOrders")).toBe(false);
    expect(anyGrantCovers("ssm", "arn:aws:ssm:eu-west-1:123456789012:parameter/prod/db-password")).toBe(false);
  });

  it("grants the tag-READ actions a stack UPDATE needs on every taggable resource", () => {
    // Live lesson (TrafficPoppy's UPDATE_ROLLBACK_FAILED incident): every deploy changes a
    // stack-level tag, which makes CloudFormation reconcile tags on EVERY resource — and each
    // handler READS existing tags before writing. A missing read fails the update AND its
    // rollback with UnauthorizedTaggingOperation, stranding the stack.
    expect(actionsOf("logs")).toContain("ListTagsForResource");
    expect(actionsOf("lambda")).toContain("ListTags");
    expect(actionsOf("iam")).toContain("ListRoleTags");
    expect(actionsOf("dynamodb")).toContain("ListTagsOfResource");
    // And the only exit from UPDATE_ROLLBACK_FAILED that keeps the Function URLs alive:
    expect(actionsOf("cloudformation")).toContain("ContinueUpdateRollback");
  });

  it("grants the TTL permissions the template's TimeToLiveSpecification actually needs", () => {
    // CloudFormation enables TTL with a separate UpdateTimeToLive call (read back with
    // DescribeTimeToLive), so setting TTL in the template without granting these two creates
    // the table and then rolls the stack back.
    if ((table.Properties.TimeToLiveSpecification as { Enabled?: boolean })?.Enabled) {
      expect(actionsOf("dynamodb")).toContain("UpdateTimeToLive");
      expect(actionsOf("dynamodb")).toContain("DescribeTimeToLive");
    }
  });

  it("grants the boundary permissions the template's PermissionsBoundary actually needs", () => {
    // Attaching a boundary to a role that already exists is PutRolePermissionsBoundary, and
    // CloudFormation calls DeleteRolePermissionsBoundary when an update flips the parameter
    // back to empty — so a template carrying the property without both grants fails the
    // update in the merchant's account and then fails its rollback the same way.
    const bounded = Object.values(R).some((r) => r.Type === "AWS::IAM::Role" && r.Properties.PermissionsBoundary);
    if (bounded) {
      expect(actionsOf("iam")).toContain("PutRolePermissionsBoundary");
      expect(actionsOf("iam")).toContain("DeleteRolePermissionsBoundary");
    }
  });

  it("grants the tagging action the out-of-stack secrets need", () => {
    // The SSM parameters are created by the backend, not by CloudFormation, so nothing else
    // tags them — and an untagged parameter is invisible to the host's leaves-no-trace sweep.
    expect(actionsOf("ssm")).toContain("AddTagsToResource");
    expect(actionsOf("ssm")).toContain("DeleteParameter");
  });
});
