import { assert, it } from "@effect/vitest";
import { classifyCodexManagedError } from "./CodexManagedErrors.ts";
it("maps streamed failures to safe actionable messages and reconnect decisions", () => {
  assert.deepEqual(
    classifyCodexManagedError({
      error: {
        code: "subscription_sharing_v2_invalid_user",
        message: "opaque token dummy-sensitive",
      },
    }),
    {
      message:
        "ChatGPT could not validate this connection. Check the selected account and sharing permissions.",
      revoke: false,
      code: "subscription_sharing_v2_invalid_user",
    },
  );
  assert.include(
    classifyCodexManagedError("subscription_sharing_usage_limit_exceeded")!.message,
    "Usage settings",
  );
  assert.equal(
    classifyCodexManagedError("subscription_sharing_usage_limit_exceeded")!.code,
    "subscription_sharing_usage_limit_exceeded",
  );
  assert.isFalse(classifyCodexManagedError("subscription_sharing_usage_unavailable")!.revoke);
  assert.include(
    classifyCodexManagedError("subscription_sharing_unsupported_capability")!.message,
    "feature",
  );
  assert.isUndefined(classifyCodexManagedError(undefined));
  assert.isUndefined(classifyCodexManagedError({ error: "unknown" }));
});

it("distinguishes unsupported tools from input items without exposing the raw response", () => {
  const code = "subscription_sharing_unsupported_capability";
  for (const [detail, expected] of [
    ["tool 'namespace' is not supported", "tool namespace"],
    ["input item 'additional_tools' is not supported", "input item"],
  ]) {
    const response = { error: { code, message: `${detail}; dummy-sensitive` } };
    for (const value of [response, JSON.stringify(response)]) {
      const failure = classifyCodexManagedError(value);
      assert.isDefined(failure);
      assert.include(failure!.message, expected!);
      assert.notInclude(failure!.message, "dummy-sensitive");
      assert.isFalse(failure!.revoke);
    }
  }
});

it("preserves credentials for the current subscriber and permission error codes", () => {
  for (const code of [
    "subscription_sharing_invalid_user",
    "subscription_sharing_user_not_eligible",
    "subscription_sharing_route_not_supported",
    "subscription_sharing_user_unavailable",
    "chatpass_v2_scope_not_authorized",
    "chatpass_v2_invalid_authorization_context",
  ]) {
    assert.strictEqual(classifyCodexManagedError({ error: { code } })?.code, code);
    assert.isFalse(classifyCodexManagedError({ error: { code } })!.revoke);
  }
});
