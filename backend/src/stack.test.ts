import { describe, expect, it, vi } from "vitest";
import type { CloudFormationClient, Stack } from "@aws-sdk/client-cloudformation";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { boundaryParameterValue, deploy, STACK_READ_FAILED } from "./stack";

const BOUNDARY = "arn:aws:iam::123456789012:policy/AgentsPoppyBoundary";

const deployedWith = (value: string, StackStatus = "CREATE_COMPLETE"): Stack =>
  ({ StackStatus, Parameters: [{ ParameterKey: "PermissionsBoundaryArn", ParameterValue: value }] }) as Stack;

describe("which permissions boundary a deploy passes (broker-role-v2 step 2)", () => {
  it("uses the ARN when the host has confirmed the policy exists", () => {
    expect(boundaryParameterValue(BOUNDARY, null)).toBe(BOUNDARY);
  });

  it("deploys unbounded on a fresh create, because CreateRole refuses a policy that isn't there", () => {
    expect(boundaryParameterValue(undefined, null)).toBe("");
  });

  it("PRESERVES a boundary the stack already carries when the host says nothing", () => {
    // The dangerous direction: a host-side hiccup must never strip an applied boundary and
    // quietly hand the account's roles their ceiling back.
    expect(boundaryParameterValue(undefined, deployedWith(BOUNDARY))).toBe(BOUNDARY);
  });

  it("does not invent one for a stack deployed before the parameter existed", () => {
    expect(boundaryParameterValue(undefined, {} as Stack)).toBe("");
    expect(boundaryParameterValue(undefined, deployedWith(""))).toBe("");
  });

  it("lets a confirmed ARN replace whatever is deployed", () => {
    expect(boundaryParameterValue(BOUNDARY, deployedWith(""))).toBe(BOUNDARY);
  });

  it("carries NOTHING forward from a dead stack the deploy is about to recreate", () => {
    // A ROLLBACK_COMPLETE/REVIEW_IN_PROGRESS stack is deleted and recreated, so it has no live
    // roles to protect — while its ARN is UNCONFIRMED, and naming a policy that isn't there
    // fails CreateRole into another rollback carrying the same ARN: a self-perpetuating outage.
    for (const status of ["ROLLBACK_COMPLETE", "REVIEW_IN_PROGRESS"]) {
      expect(boundaryParameterValue(undefined, deployedWith(BOUNDARY, status)), status).toBe("");
    }
  });

  it("still applies a CONFIRMED ARN to a stack being recreated", () => {
    // Confirmed means the host checked the policy exists, so there is no CreateRole trap here.
    expect(boundaryParameterValue(BOUNDARY, deployedWith("", "ROLLBACK_COMPLETE"))).toBe(BOUNDARY);
  });
});

/** A CloudFormation client whose DescribeStacks answer (or failure) the test chooses. */
function fakeCfn(describeStacks: () => unknown) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      sent.push({ name, input: cmd.input });
      // After the delete, the waiter polls until the stack is gone.
      if (name === "DescribeStacksCommand") {
        if (sent.some((s) => s.name === "DeleteStackCommand")) return { Stacks: [{ StackStatus: "DELETE_COMPLETE" }] };
        return describeStacks();
      }
      return {};
    }),
  } as unknown as CloudFormationClient;
  return { client, sent, of: (name: string) => sent.find((s) => s.name === name) };
}

const okS3 = () => ({ send: vi.fn(async () => ({})) }) as unknown as S3Client;

const ctxWith = (cfn: CloudFormationClient) => ({
  cfn,
  s3: okS3(),
  ssm: {} as SSMClient,
  region: "eu-west-1",
  accountId: "123456789012",
});

const ATTRIBUTION = { accountId: "123456789012", connectionId: "conn-1" };

const boundaryParamOf = (input: Record<string, unknown>) =>
  (input.Parameters as { ParameterKey: string; ParameterValue: string }[]).find(
    (p) => p.ParameterKey === "PermissionsBoundaryArn",
  )?.ParameterValue;

describe("deploy() and the boundary parameter it actually sends", () => {
  it("ABORTS in plain words when the stack can't be read, instead of deploying blind", async () => {
    // The fail direction that matters: answering "" for an unreadable stack hands
    // CloudFormation an empty parameter, which STRIPS the boundary off every role it has.
    const cfn = fakeCfn(() => {
      throw Object.assign(new Error("Rate exceeded"), { name: "Throttling" });
    });
    await expect(deploy(ctxWith(cfn.client), ATTRIBUTION)).rejects.toThrow(STACK_READ_FAILED);
    expect(cfn.of("UpdateStackCommand"), "no change may be attempted on an unreadable stack").toBeUndefined();
    expect(cfn.of("CreateStackCommand")).toBeUndefined();
  });

  it("recreates a rolled-back stack WITHOUT its unconfirmed boundary", async () => {
    const cfn = fakeCfn(() => ({ Stacks: [deployedWith(BOUNDARY, "ROLLBACK_COMPLETE")] }));
    const result = await deploy(ctxWith(cfn.client), ATTRIBUTION);
    expect(result.operation).toBe("RECREATE");
    expect(cfn.of("DeleteStackCommand")).toBeDefined();
    expect(boundaryParamOf(cfn.of("CreateStackCommand")!.input)).toBe("");
  });

  it("keeps a live stack's boundary on an ordinary update", async () => {
    const cfn = fakeCfn(() => ({ Stacks: [deployedWith(BOUNDARY)] }));
    const result = await deploy(ctxWith(cfn.client), ATTRIBUTION);
    expect(result.operation).toBe("UPDATE");
    expect(boundaryParamOf(cfn.of("UpdateStackCommand")!.input)).toBe(BOUNDARY);
  });

  it("passes the confirmed ARN through on a first create", async () => {
    const cfn = fakeCfn(() => {
      throw Object.assign(new Error("Stack with id X does not exist"), { name: "ValidationError" });
    });
    const result = await deploy(ctxWith(cfn.client), ATTRIBUTION, BOUNDARY);
    expect(result.operation).toBe("CREATE");
    expect(boundaryParamOf(cfn.of("CreateStackCommand")!.input)).toBe(BOUNDARY);
  });
});
