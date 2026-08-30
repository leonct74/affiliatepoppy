// The boundary check, made over the template we SHIP rather than the one we build.
//
// infra/src/template.test.ts asserts all of this against buildTemplate() — but what reaches a
// merchant's account is backend/src/generated/backend-bundle.ts, produced by
// scripts/build-backend-bundle.mjs. Those two drift for a living (a stale bundle is the
// classic poppy trap), and a boundary that is only in the source protects nobody. So: parse
// the embedded JSON and re-assert on the artifact.

import { describe, expect, it } from "vitest";
import { templateJson } from "./generated/backend-bundle";

const template = JSON.parse(templateJson) as {
  Parameters: Record<string, { Type: string; Default?: string }>;
  Conditions: Record<string, unknown>;
  Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
};

const BOUNDED = { "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: "AWS::NoValue" }] };

describe("the SHIPPED template's permissions boundary (broker-role-v2 step 2)", () => {
  it("carries the boundary as an OPTIONAL parameter — an account without the policy still deploys", () => {
    const param = template.Parameters.PermissionsBoundaryArn;
    expect(param, "the shipped template has no PermissionsBoundaryArn — the bundle is stale").toBeDefined();
    expect(param!.Type).toBe("String");
    expect(param!.Default).toBe("");
  });

  it("applies it only when one was passed", () => {
    expect(template.Conditions.HasPermissionsBoundary).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "PermissionsBoundaryArn" }, ""] }],
    });
  });

  it("caps EVERY AWS::IAM::Role it ships — one unbounded role is an uncapped role in the account", () => {
    const roles = Object.entries(template.Resources).filter(([, r]) => r.Type === "AWS::IAM::Role");
    expect(roles.length, "no roles found — the parse, not the template, is what's wrong").toBeGreaterThan(0);
    for (const [name, role] of roles) {
      expect(role.Properties.PermissionsBoundary, `${name} ships UNBOUNDED`).toEqual(BOUNDED);
    }
  });
});
