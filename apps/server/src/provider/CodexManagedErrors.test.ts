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
      code: "subscription_sharing_v2_invalid_user",
      usageLimit: false,
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
  }
});

it("treats only ChatGPT sharing allowance limits as usage limits", () => {
  assert.deepInclude(
    classifyCodexManagedError(
      "stream disconnected before completion: The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.",
    ),
    { code: "subscription_sharing_usage_limit_exceeded", usageLimit: true },
  );
  assert.isTrue(
    classifyCodexManagedError("subscription_sharing_workplace_individual_usage_limit_exceeded")!
      .usageLimit,
  );
  assert.isFalse(classifyCodexManagedError("subscription_sharing_usage_unavailable")!.usageLimit);
  assert.isUndefined(
    classifyCodexManagedError("stream disconnected before completion: error decoding response"),
  );
  assert.isUndefined(classifyCodexManagedError("You've hit your usage limit."));
});

it("does not infer sharing codes from incidental mentions in turn errors", () => {
  const mention = "Transport unavailable; this is not subscription_sharing_usage_limit_exceeded.";
  for (const value of [
    mention,
    { message: mention },
    { message: "Transport unavailable", additionalDetails: mention },
    { code: "other", message: mention },
  ]) {
    assert.isUndefined(classifyCodexManagedError(value));
  }
  assert.deepInclude(
    classifyCodexManagedError({
      error: { code: "subscription_sharing_usage_unavailable", message: mention },
    }),
    { code: "subscription_sharing_usage_unavailable", usageLimit: false },
  );
});

it("reads sharing codes from structured errors and exact turn details", () => {
  const code = "subscription_sharing_usage_limit_exceeded";
  const response = { error: { code } };
  for (const value of [
    response,
    JSON.stringify(response),
    { message: "Provider stopped", additionalDetails: code },
    { message: "Provider stopped", additionalDetails: JSON.stringify(response) },
  ]) {
    assert.deepInclude(classifyCodexManagedError(value), { code, usageLimit: true });
  }
});
