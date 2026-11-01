import { describe, expect, it } from "vite-plus/test";

import { sanitizeStderrExcerpt } from "./stderrExcerpt.ts";

describe("stderrExcerpt", () => {
  it("redacts home paths, pairing URLs, and tokens from stderr excerpts", () => {
    const excerpt = sanitizeStderrExcerpt(
      [
        "Invalid project config at /Users/ada/.cursor/cli.json",
        "Authorization: Bearer secret-token-value",
        "Sign in: https://accounts.google.com/o/oauth2/v2/auth?state=oauth-state-value",
        "Visit http://localhost:5733/pair#token=ABCDEF for pairing",
        "key=sk-abcdefghijklmnopqrstuv",
      ].join("\n"),
      "/home/server",
      { HOME: "/Users/ada" },
    );

    expect(excerpt).toContain("Invalid project config at ~/.cursor/cli.json");
    expect(excerpt).toContain("Authorization: [REDACTED]");
    expect(excerpt).toContain("[pairing-url]");
    expect(excerpt).toContain("[redacted]");
    expect(excerpt).not.toContain("secret-token-value");
    expect(excerpt).not.toContain("ABCDEF");
    expect(excerpt).toContain("[sign-in-url]");
    expect(excerpt).not.toContain("oauth-state-value");
    expect(excerpt).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("redacts hyphenated OpenAI project keys and header credentials", () => {
    const excerpt = sanitizeStderrExcerpt(
      [
        "openai=sk-proj-abcdefghijklmnopqrstuvwxyz012345",
        "svc=sk-svcacct-abcdefghijklmnopqrstuvwxyz012345",
        "anthropic=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
        "Authorization: Basic dXNlcjpwYXNz",
        "x-api-key: ant-api-key-value",
      ].join("\n"),
      "/Users/ada",
      {},
    );

    expect(excerpt).toContain("[redacted]");
    expect(excerpt).toContain("Authorization: [REDACTED]");
    expect(excerpt).toContain("x-api-key: [REDACTED]");
    expect(excerpt).not.toContain("sk-proj-");
    expect(excerpt).not.toContain("sk-svcacct-");
    expect(excerpt).not.toContain("sk-ant-api03-");
    expect(excerpt).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(excerpt).not.toContain("dXNlcjpwYXNz");
    expect(excerpt).not.toContain("ant-api-key-value");
  });

  it("redacts the whole key when its body contains underscores", () => {
    const excerpt = sanitizeStderrExcerpt(
      [
        "anthropic=sk-ant-api03-AbCdEf_GhIjKlMnOpQr-StUvWx_yz0123456789-AA",
        "openai=sk-proj-AbCdEfGhIj_KlMnOpQrStUv-WxYz_0123456789",
      ].join("\n"),
      "/Users/ada",
      {},
    );

    expect(excerpt).toBe("anthropic=[redacted]\nopenai=[redacted]");
  });

  it("redacts values assigned to secret-named variables", () => {
    const excerpt = sanitizeStderrExcerpt(
      [
        "API_KEY=super-secret",
        "github_token: gh-value",
        'PASSWORD="first second third"',
        '{"message":"failed","apiKey":"custom-credential-value"}',
        "env:API_KEY=abc123",
        "Unknown key: model-x",
      ].join("\n"),
      "/Users/ada",
      {},
    );

    expect(excerpt).toBe(
      [
        "API_KEY=[REDACTED]",
        "github_token: [REDACTED]",
        "PASSWORD=[REDACTED]",
        '{"message":"failed","apiKey":"[REDACTED]"}',
        "env:API_KEY=[REDACTED]",
        "Unknown key: model-x",
      ].join("\n"),
    );
  });
});
