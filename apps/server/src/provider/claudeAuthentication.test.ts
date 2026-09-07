import { assert, describe, it } from "@effect/vitest";

import { supportsClaudeSubscriptionLogin } from "./claudeAuthentication.ts";

describe("supportsClaudeSubscriptionLogin", () => {
  it("allows subscription OAuth when no external credentials or backend are configured", () => {
    assert.isTrue(supportsClaudeSubscriptionLogin());
    assert.isTrue(supportsClaudeSubscriptionLogin({}, "oauth"));
    assert.isTrue(supportsClaudeSubscriptionLogin({}, "subscription"));
    assert.isTrue(supportsClaudeSubscriptionLogin({}, "first-party"));
    assert.isTrue(
      supportsClaudeSubscriptionLogin({
        CLAUDE_CODE_USE_BEDROCK: "false",
        CLAUDE_CODE_USE_VERTEX: "0",
        CLAUDE_CODE_USE_VERTEX_AI: "  ",
        CLAUDE_CODE_USE_FOUNDRY: "FALSE",
      }),
    );
  });

  it("rejects configured API credentials and alternate endpoints", () => {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
    ]) {
      assert.isFalse(supportsClaudeSubscriptionLogin({ [key]: "configured" }), key);
      assert.isTrue(supportsClaudeSubscriptionLogin({ [key]: "  " }), `${key} whitespace`);
    }
  });

  it("rejects enabled cloud backends while accepting explicit false flags", () => {
    for (const key of [
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_VERTEX_AI",
      "CLAUDE_CODE_USE_FOUNDRY",
    ]) {
      for (const value of ["1", "true", "TRUE", "yes", "on"]) {
        assert.isFalse(supportsClaudeSubscriptionLogin({ [key]: value }), `${key}=${value}`);
      }
      for (const value of ["0", "false", "FALSE", " "]) {
        assert.isTrue(supportsClaudeSubscriptionLogin({ [key]: value }), `${key}=${value}`);
      }
    }
  });

  it("rejects API and cloud auth types after normalizing case, spaces, hyphens, and underscores", () => {
    for (const authType of [
      "apiKey",
      "anthropic-api-key",
      "Anthropic Auth Token",
      "bedrock",
      "amazon_bedrock",
      "vertex",
      "vertex_ai",
      "google vertex ai",
      "foundry",
      "azure-foundry",
    ]) {
      assert.isFalse(supportsClaudeSubscriptionLogin({}, authType), authType);
    }

    for (const authType of [undefined, "oauth", "subscription", "first-party-oauth"]) {
      assert.isTrue(supportsClaudeSubscriptionLogin({}, authType), String(authType));
    }
  });
});
