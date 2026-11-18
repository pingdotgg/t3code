import { describe, expect, it } from "@effect/vitest";
import { mcpToolPresentation } from "./mcpToolPresentation.ts";

describe("mcpToolPresentation", () => {
  it.each([
    "javascript:alert(1)",
    "file:///tmp/logo.png",
    "not a URL",
    "https://example.com/" + "x".repeat(4096),
  ])("ignores an invalid logo %s", (iconUrl) => {
    expect(
      mcpToolPresentation({
        serverName: "weather",
        toolName: "get_weather",
        iconUrl,
        title: "x".repeat(161),
      }),
    ).toEqual({
      title: "get weather",
      toolSource: { key: "mcp:weather", name: "weather", kind: "integration" },
    });
  });

  it("presents Ada's own computer tools as computer use, not as an integration", () => {
    for (const toolName of [
      "mcp__t3-code__computer_use",
      "mcp__t3-code__computer_control",
      "mcp__t3-code__computer_status",
      "mcp__t3-code__computer_stop",
      "mcp__t3-code__computer_look",
      "mcp__t3-code__computer_act",
    ]) {
      expect(mcpToolPresentation({ toolName })).toEqual({
        toolSource: { key: "computer", name: "Computer use", kind: "computer" },
      });
    }
    // Another server's tool of the same name is that server's business.
    expect(mcpToolPresentation({ serverName: "weather", toolName: "computer_use" })).toMatchObject({
      toolSource: { kind: "integration" },
    });
  });
});
