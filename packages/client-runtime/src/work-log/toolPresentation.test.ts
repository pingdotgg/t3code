import { describe, expect, it } from "@effect/vitest";

import { extractMcpToolData, extractToolActivityPresentation } from "./toolPresentation.ts";

describe("extractToolActivityPresentation", () => {
  it("reads provider-neutral presentation fields", () => {
    expect(
      extractToolActivityPresentation({
        toolSurface: "browser",
        toolIcon: {
          _tag: "website",
          pageUrl: "https://example.com/docs",
          faviconUrl: "https://example.com/favicon.png",
          faviconUrlDark: "https://example.com/favicon-dark.png",
        },
        toolSource: {
          key: "integration:example",
          name: "Example",
          kind: "integration",
          icon: {
            _tag: "themed-logo",
            logoUrl: "https://example.com/logo-light.png",
            logoUrlDark: "https://example.com/logo-dark.png",
          },
        },
      }),
    ).toEqual({
      toolSurface: "browser",
      toolIcon: {
        _tag: "website",
        pageUrl: "https://example.com/docs",
        faviconUrl: "https://example.com/favicon.png",
        faviconUrlDark: "https://example.com/favicon-dark.png",
      },
      toolSource: {
        key: "integration:example",
        name: "Example",
        kind: "integration",
        icon: {
          _tag: "themed-logo",
          logoUrl: "https://example.com/logo-light.png",
          logoUrlDark: "https://example.com/logo-dark.png",
        },
      },
    });
  });

  it("reads provider-neutral native app icons", () => {
    expect(
      extractToolActivityPresentation({
        toolSurface: "computer",
        toolIcon: {
          _tag: "native-app",
          app: { _tag: "app-id", appId: "com.example.Editor" },
        },
        toolSource: {
          key: "native-app:com.example.editor",
          name: "Editor",
          kind: "computer",
        },
      }),
    ).toEqual({
      toolSurface: "computer",
      toolIcon: {
        _tag: "native-app",
        app: { _tag: "app-id", appId: "com.example.Editor" },
      },
      toolSource: {
        key: "native-app:com.example.editor",
        name: "Editor",
        kind: "computer",
      },
    });
  });

  it("does not infer presentation from provider-specific payload data", () => {
    expect(
      extractToolActivityPresentation({
        data: {
          item: {
            arguments: { code: 'await sky.click({ app: "Finder" })' },
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "computerUse",
                  app: { kind: "displayName", displayName: "Finder" },
                },
              },
            },
          },
        },
      }),
    ).toEqual({});
  });
});

describe("MCP sources", () => {
  it.each([
    { item: { server: "logfire", tool: "arbitrary_query" } },
    { toolName: "mcp__logfire__arbitrary_query" },
    { tool: "mcp__logfire__arbitrary_query", state: { input: { query: "SELECT 1" } } },
  ])("shows a source and bundled logo before a result arrives", (data) => {
    const presentation = extractToolActivityPresentation({ itemType: "mcp_tool_call", data });
    expect(presentation.toolSource).toMatchObject({
      key: "mcp:logfire",
      name: "Pydantic Logfire MCP",
      kind: "integration",
      icon: { _tag: "themed-logo", logoUrl: expect.stringMatching(/^data:image\/png;base64,/) },
    });
    expect(extractMcpToolData({ itemType: "mcp_tool_call", data })).toEqual(
      "item" in data ? data.item : data,
    );
  });

  it("keeps unknown servers visible without assigning them Pydantic branding", () => {
    expect(
      extractToolActivityPresentation({
        itemType: "mcp_tool_call",
        data: {
          item: { server: "github", tool: "search_issues" },
        },
      }).toolSource,
    ).toEqual({ key: "mcp:github", name: "github MCP", kind: "integration" });
  });

  it("keeps provider presentation and T3 browser tools intact", () => {
    const source = { key: "browser:chrome", name: "Chrome", kind: "browser" };
    expect(
      extractToolActivityPresentation({
        itemType: "mcp_tool_call",
        toolSource: source,
        data: { item: { server: "browser", tool: "click" } },
      }).toolSource,
    ).toEqual(source);
    expect(
      extractToolActivityPresentation({
        itemType: "mcp_tool_call",
        data: { item: { server: "t3-code", tool: "preview_click" } },
      }),
    ).toEqual({});
  });

  it("does not infer MCP usage from a shell command or result mentioning Logfire", () => {
    expect(
      extractToolActivityPresentation({
        itemType: "command_execution",
        data: {
          command: "logfire mcp query run",
          result: "mcp__logfire__arbitrary_query",
        },
      }),
    ).toEqual({});
  });
});
