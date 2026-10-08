import { describe, expect, it } from "@effect/vitest";
import { mcpToolPresentation } from "./McpToolPresentation.ts";

describe("mcpToolPresentation", () => {
  it("uses supplied names and logos while retaining the server identity", () => {
    expect(
      mcpToolPresentation({
        serverName: "firecrawl-local",
        toolName: "firecrawl_scrape",
        title: "  Scrape\n page  ",
        serverDisplayName: "Firecrawl",
        iconUrl: "https://example.com/icon.png",
        iconUrlDark: "https://example.com/dark.png",
      }),
    ).toEqual({
      title: "Scrape page",
      toolIcon: {
        _tag: "themed-logo",
        logoUrl: "https://example.com/icon.png",
        logoUrlDark: "https://example.com/dark.png",
      },
      toolSource: {
        key: "mcp:firecrawl-local",
        name: "Firecrawl",
        kind: "integration",
        icon: {
          _tag: "themed-logo",
          logoUrl: "https://example.com/icon.png",
          logoUrlDark: "https://example.com/dark.png",
        },
      },
    });
  });

  it("uses MCP result source metadata for the tool and its integration", () => {
    const presentation = mcpToolPresentation({
      serverName: "firecrawl-local",
      toolName: "firecrawl_scrape",
      source: {
        name: "Firecrawl",
        logoUrl: "https://example.com/firecrawl.png",
        logoUrlDark: "https://example.com/firecrawl-dark.png",
      },
    });
    expect(presentation.toolSource?.name).toBe("Firecrawl");
    expect(presentation.toolIcon).toEqual({
      _tag: "themed-logo",
      logoUrl: "https://example.com/firecrawl.png",
      logoUrlDark: "https://example.com/firecrawl-dark.png",
    });
    expect(presentation.toolSource?.icon).toEqual(presentation.toolIcon);
  });

  it("uses readable fallback names without a guessed logo", () => {
    expect(mcpToolPresentation({ toolName: "mcp__my_server__get_weather" })).toEqual({
      title: "get weather",
      toolSource: { key: "mcp:my_server", name: "my server", kind: "integration" },
    });
    expect(mcpToolPresentation({ toolName: "Read" })).toEqual({});
    expect(mcpToolPresentation({ serverName: "t3-code", toolName: "delegate_task" })).toEqual({});
  });

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

  it("rejects malformed and overlong names", () => {
    expect(mcpToolPresentation({ serverName: {}, toolName: 1, title: [] })).toEqual({});
    expect(mcpToolPresentation({ serverName: "x".repeat(161), toolName: "get_weather" })).toEqual(
      {},
    );
    expect(mcpToolPresentation({ title: "Tool title" })).toEqual({ title: "Tool title" });
  });

  it.each([
    null,
    "logo",
    { logoUrl: "file:///tmp/logo.png" },
    { logoUrlDark: "https://example.com/dark.png" },
  ])("ignores source metadata without a valid logo: %j", (source) => {
    expect(mcpToolPresentation({ serverName: "weather", toolName: "get_weather", source })).toEqual(
      {
        title: "get weather",
        toolSource: { key: "mcp:weather", name: "weather", kind: "integration" },
      },
    );
  });
});
