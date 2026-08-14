// The merchant's Stripe secrets. Two rules, both tested here because both are the kind of
// thing that looks fine in review and leaks in production:
//
//  1. A secret NEVER travels back to the UI. The poppy runs in a window people screen-share.
//  2. A secret is TAGGED, or the host's leaves-no-trace sweep can't see it and teardown
//     leaves a live API key behind in the merchant's account.

import { describe, expect, it } from "vitest";
import { SSM_API_KEY, SSM_WEBHOOK_SECRET } from "../../infra/src/template";
import { describeSecrets, forgetSecrets, putSecret, readSecret, SECRET_NAMES } from "./secrets";

/** A tiny fake SSM that records what it was asked to do. */
function fakeSsm(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const calls: { command: string; input: Record<string, any> }[] = [];
  return {
    store,
    calls,
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      const name = command.constructor.name;
      calls.push({ command: name, input: command.input });
      if (name === "PutParameterCommand") {
        store.set(command.input.Name, command.input.Value);
        return {};
      }
      if (name === "GetParameterCommand") {
        const value = store.get(command.input.Name);
        if (value === undefined) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
        return { Parameter: { Value: value } };
      }
      if (name === "DeleteParameterCommand") {
        if (!store.delete(command.input.Name)) {
          throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
        }
        return {};
      }
      if (name === "AddTagsToResourceCommand") return {};
      throw new Error(`unexpected command ${name}`);
    },
  } as never as import("@aws-sdk/client-ssm").SSMClient & { store: Map<string, string>; calls: any[] };
}

const attribution = { accountId: "111122223333", connectionId: "conn-1" };

describe("storing a secret", () => {
  it("writes it ENCRYPTED into the merchant's own parameter store", async () => {
    const ssm = fakeSsm();
    await putSecret(ssm, "webhookSecret", "whsec_abcd1234", attribution);
    const put = (ssm as any).calls.find((c: any) => c.command === "PutParameterCommand");
    expect(put.input).toMatchObject({ Name: SSM_WEBHOOK_SECRET, Type: "SecureString", Overwrite: true });
  });

  it("tags it, so teardown and the host's sweep can both find it", async () => {
    // An untagged parameter is invisible to the leaves-no-trace check — and a live Stripe key
    // is the last thing that should quietly outlive the poppy.
    const ssm = fakeSsm();
    await putSecret(ssm, "apiKey", "rk_test_1234", attribution);
    const tag = (ssm as any).calls.find((c: any) => c.command === "AddTagsToResourceCommand");
    expect(tag.input.ResourceId).toBe(SECRET_NAMES.apiKey.replace(/^\//, ""));
    const tags = Object.fromEntries(tag.input.Tags.map((t: any) => [t.Key, t.Value]));
    expect(tags).toMatchObject({
      "agentspoppy:app": "com.affiliatepoppy.desktop",
      "agentspoppy:account": "111122223333",
      "agentspoppy:connection": "conn-1",
    });
  });

  it("tags in a SEPARATE call — PutParameter refuses tags together with Overwrite", async () => {
    // Inline tags would work on the very first save and fail on every edit afterwards, which
    // is exactly the bug that ships: nobody re-tests the second save.
    const ssm = fakeSsm();
    await putSecret(ssm, "apiKey", "rk_test_1234", attribution);
    const put = (ssm as any).calls.find((c: any) => c.command === "PutParameterCommand");
    expect(put.input.Tags).toBeUndefined();
  });

  it("refuses an empty paste rather than storing a blank key", async () => {
    const ssm = fakeSsm();
    await expect(putSecret(ssm, "apiKey", "   ", attribution)).rejects.toThrow(/paste the whole secret/);
  });

  it("trims whitespace, because a pasted key usually carries a newline", async () => {
    const ssm = fakeSsm();
    await putSecret(ssm, "apiKey", "  rk_test_1234\n", attribution);
    expect(await readSecret(ssm, "apiKey")).toBe("rk_test_1234");
  });
});

describe("what the UI is allowed to know", () => {
  it("gets only 'stored' and the last four characters — never the secret", async () => {
    const ssm = fakeSsm({ [SSM_API_KEY]: "rk_live_supersecret9zx8", [SSM_WEBHOOK_SECRET]: "whsec_abcd1234" });
    const described = await describeSecrets(ssm);
    expect(described.apiKey).toEqual({ stored: true, hint: "…9zx8" });
    expect(JSON.stringify(described)).not.toContain("supersecret");
  });

  it("reports an absent secret as absent, not as an error", async () => {
    // The Setup tab renders this on first run, when neither secret exists yet.
    const described = await describeSecrets(fakeSsm());
    expect(described.apiKey).toEqual({ stored: false, hint: "" });
    expect(described.webhookSecret.stored).toBe(false);
  });
});

describe("forgetting them", () => {
  it("deletes both, and reports what it removed", async () => {
    const ssm = fakeSsm({ [SSM_API_KEY]: "rk", [SSM_WEBHOOK_SECRET]: "whsec" });
    expect(await forgetSecrets(ssm)).toEqual([SSM_WEBHOOK_SECRET, SSM_API_KEY]);
    expect((ssm as any).store.size).toBe(0);
  });

  it("is idempotent — teardown can run twice, and 'already gone' is success", async () => {
    const ssm = fakeSsm({ [SSM_API_KEY]: "rk" });
    await forgetSecrets(ssm);
    await expect(forgetSecrets(ssm)).resolves.toEqual([]);
  });
});
