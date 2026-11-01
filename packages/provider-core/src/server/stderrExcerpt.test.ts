import { describe, expect, it } from "vite-plus/test";

import { appendStderrTail, sanitizeStderrExcerpt } from "./stderrExcerpt.ts";

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
        "Authorization: Token abc123",
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
        "Authorization: [REDACTED]",
        "Unknown key: model-x",
      ].join("\n"),
    );
  });

  it("redacts whole header values and quoted values with embedded quotes", () => {
    const excerpt = sanitizeStderrExcerpt(
      [
        "x-api-key: first-secret;second-secret",
        "Authorization: Bearer first,second",
        `{"password":"first'second-secret"}`,
        String.raw`{"password":"a\"b-secret"}`,
      ].join("\n"),
      "/Users/ada",
      {},
    );

    expect(excerpt).toBe(
      [
        "x-api-key: [REDACTED]",
        "Authorization: [REDACTED]",
        '{"password":"[REDACTED]"}',
        '{"password":"[REDACTED]"}',
      ].join("\n"),
    );
  });

  it("drops the partial first line when the tail is truncated", () => {
    let tail = "";
    for (const chunk of ["API_", "KEY=super-secret\n", "x".repeat(4_080), "\nError: boom\n"]) {
      tail = appendStderrTail(tail, chunk);
    }

    expect(tail.length).toBeLessThanOrEqual(4_096);
    expect(sanitizeStderrExcerpt(tail, "/Users/ada", {})).toBe(`${"x".repeat(4_080)}\nError: boom`);
  });

  it("drops a secret whose name was cut off by truncation within one long line", () => {
    let tail = "";
    for (const chunk of [`${"a".repeat(5_000)} API_KEY=`, "super-secret\nError: boom\n"]) {
      tail = appendStderrTail(tail, chunk);
    }
    expect(sanitizeStderrExcerpt(tail, "/Users/ada", {})).toBe("Error: boom");

    let unterminated = "";
    for (const chunk of ["API_KEY=", "s".repeat(5_000)]) {
      unterminated = appendStderrTail(unterminated, chunk);
    }
    expect(sanitizeStderrExcerpt(unterminated, "/Users/ada", {})).toBe("");
  });

  it("strips credentials, query and fragment from URLs", () => {
    expect(
      sanitizeStderrExcerpt(
        "fetch https://alice:p4ss@example.test/api?token=abc#frag failed",
        "/Users/ada",
        {},
      ),
    ).toBe("fetch https://example.test/api failed");
  });

  it.each([
    ["Authorization: Negotiate abc123", "Authorization: [REDACTED]"],
    ['x-api-key: "first second"', "x-api-key: [REDACTED]"],
    [
      "connect postgres://dbuser:dbpassword@db.example/app failed",
      "connect postgres://[REDACTED]@db.example/app failed",
    ],
    [
      "connect redis://:hunter2@db.example:6379 failed",
      "connect redis://[REDACTED]@db.example:6379 failed",
    ],
    [
      "connect mongodb+srv://db.example/?authMechanismProperties=AWS_SESSION_TOKEN%3As3cr3t failed",
      "connect mongodb+srv://db.example/ failed",
    ],
    [
      'connect mongodb+srv://db.example/?password="s3cr3t" failed',
      "connect mongodb+srv://db.example/ failed",
    ],
    ['fetch https://example.test/?token="s3cr3t" failed', "fetch https://example.test/ failed"],
    [
      '{"url":"https://api.test/?a=1","password":"super secret"}',
      '{"url":"https://api.test/","password":"[REDACTED]"}',
    ],
    [
      '{"url":"mongodb+srv://db.example/?a=1","password":"super secret"}',
      '{"url":"mongodb+srv://db.example/","password":"[REDACTED]"}',
    ],
    ['see "https://example.test/path?a=1" here', 'see "https://example.test/path" here'],
    ['{"password":"topsecret\nError: boom', '{"password":"[REDACTED]"'],
    ['PASSWORD="first\nsecond-secret"\nError: boom', "PASSWORD=[REDACTED]"],
    ['{"password":"first\nsecond-secret"}', '{"password":"[REDACTED]"'],
    ['{"password":"topsecret\nPASSWORD="top secret', '{"password":"[REDACTED]"'],
  ])("redacts %j", (input, expected) => {
    expect(sanitizeStderrExcerpt(input, "/Users/ada", {})).toBe(expected);
  });

  it("redacts AWS secret access keys and apostrophe-quoted URL query values", () => {
    expect(
      sanitizeStderrExcerpt(
        [
          "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG",
          "fetch https://example.test/?password='sensitive' failed",
        ].join("\n"),
        "/Users/ada",
        {},
      ),
    ).toBe(["AWS_SECRET_ACCESS_KEY=[REDACTED]", "fetch https://example.test/ failed"].join("\n"));
  });
});
