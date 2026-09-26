import { describe, expect, it } from "vite-plus/test";

import {
  ACP_STDERR_TAIL_MAX_CHARS,
  appendAcpStderrTail,
  sanitizeAcpStderrExcerpt,
} from "./AcpStderr.ts";

describe("AcpStderr", () => {
  it("keeps a bounded tail of stderr chunks", () => {
    const prefix = "x".repeat(ACP_STDERR_TAIL_MAX_CHARS);
    expect(appendAcpStderrTail(prefix, "abc")).toBe(`${prefix.slice(3)}abc`);
  });

  it("redacts home paths, pairing URLs, and tokens from stderr excerpts", () => {
    const excerpt = sanitizeAcpStderrExcerpt(
      [
        "Invalid project config at /Users/ada/.cursor/cli.json",
        "Authorization: Bearer secret-token-value",
        "Visit http://localhost:5733/pair#token=ABCDEF for pairing",
        "key=sk-abcdefghijklmnopqrstuv",
        "Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?state=private-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A4000%2F",
        '__T3_ANTIGRAVITY_AUTH_URL__"https://accounts.google.com/o/oauth2/v2/auth?state=other-state"',
      ].join("\n"),
      { HOME: "/Users/ada" },
    );

    expect(excerpt).toContain("Invalid project config at ~/.cursor/cli.json");
    expect(excerpt).toContain("Bearer [redacted]");
    expect(excerpt).toContain("[pairing-url]");
    expect(excerpt).toContain("[redacted]");
    expect(excerpt).not.toContain("secret-token-value");
    expect(excerpt).not.toContain("ABCDEF");
    expect(excerpt).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(excerpt).toContain("[sign-in-url]");
    expect(excerpt).not.toContain("private-state");
    expect(excerpt).not.toContain("other-state");
  });

  it("redacts hyphenated OpenAI project keys and header credentials", () => {
    const excerpt = sanitizeAcpStderrExcerpt(
      [
        "openai=sk-proj-abcdefghijklmnopqrstuvwxyz012345",
        "svc=sk-svcacct-abcdefghijklmnopqrstuvwxyz012345",
        "anthropic=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
        "Authorization: Basic dXNlcjpwYXNz",
        "x-api-key: ant-api-key-value",
      ].join("\n"),
    );

    expect(excerpt).toContain("[redacted]");
    expect(excerpt).toContain("Authorization: Basic [redacted]");
    expect(excerpt).toContain("x-api-key: [redacted]");
    expect(excerpt).not.toContain("sk-proj-");
    expect(excerpt).not.toContain("sk-svcacct-");
    expect(excerpt).not.toContain("sk-ant-api03-");
    expect(excerpt).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(excerpt).not.toContain("dXNlcjpwYXNz");
    expect(excerpt).not.toContain("ant-api-key-value");
  });
});
