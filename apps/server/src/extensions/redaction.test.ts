import { describe, expect, it } from "@effect/vitest";

import { redactCommandLine, redactUrl, scrubSecretValues } from "./redaction.ts";

describe("redaction", () => {
  it.each([
    [["--token=abc123"], "server --token=***"],
    [["--api-key", "abc123", "--port", "80"], "server --api-key *** --port 80"],
    [["-H", "Authorization: Bearer abc123"], 'server -H "Authorization: ***"'],
    [["Bearer abc123"], 'server "Bearer ***"'],
    [["GITHUB_TOKEN=abc123"], "server GITHUB_TOKEN=***"],
    [["https://x.dev/mcp?api_key=abc123&q=1"], "server https://x.dev/mcp?api_key=***&q=1"],
    [["-y", "@scope/pkg", "/work dir"], 'server -y @scope/pkg "/work dir"'],
  ])("masks %j", (args, expected) => {
    expect(redactCommandLine("server", args)).toBe(expected);
    expect(redactCommandLine("server", args)).not.toContain("abc123");
  });

  it("masks URL passwords and leaves plain URLs alone", () => {
    expect(redactUrl("https://user:pw123@x.dev/mcp")).toBe("https://user:***@x.dev/mcp");
    expect(redactUrl("https://mcp.trello.com/v1")).toBe("https://mcp.trello.com/v1");
  });

  it("scrubs known secret values from CLI output", () => {
    expect(scrubSecretValues("bad header Bearer s3cret!", ["Bearer s3cret!"])).toBe(
      "bad header ***",
    );
  });
});
