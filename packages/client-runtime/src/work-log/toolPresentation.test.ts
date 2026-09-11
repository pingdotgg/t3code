import { describe, expect, it } from "@effect/vitest";

import {
  extractToolActivityData,
  extractToolActivityPresentation,
  hasToolActivityData,
  toolActivityDataBody,
} from "./toolPresentation.ts";

const devinResourceToolEvent = {
  type: "item.completed",
  payload: {
    itemType: "dynamic_tool_call",
    status: "completed",
    title: "Resource fixture",
    data: {
      toolCallId: "devin-resource-tool",
      kind: "other",
      resource: {
        uri: "urn:acp:fixture:resource-link",
        name: "schema fixture",
        description: "typed protocol fixture",
        mimeType: "text/markdown",
      },
      content: [
        {
          type: "content",
          content: { type: "text", text: "ordinary tool output" },
        },
      ],
    },
  },
} as const;

describe("extractToolActivityPresentation", () => {
  it("expands generic resource URI and embedded text without serializing collapsed rows", () => {
    const resource = { uri: "urn:notes", text: "Resource notes" };
    const entry = { itemType: "dynamic_tool_call", toolData: { resource } };
    expect(hasToolActivityData(entry)).toBe(true);
    expect(toolActivityDataBody(entry)).toBe(`Resource\n${JSON.stringify(resource, null, 2)}`);
    expect(hasToolActivityData({ itemType: "dynamic_tool_call", toolData: {} })).toBe(false);
    expect(toolActivityDataBody({ itemType: "dynamic_tool_call" })).toBeUndefined();
  });

  it("retains canonical ACP resource metadata for generic tool activity", () => {
    expect(extractToolActivityData(devinResourceToolEvent.payload)).toBe(
      devinResourceToolEvent.payload.data,
    );
  });

  it("keeps MCP item extraction precedence when MCP data also has a resource", () => {
    const item = {
      type: "mcpToolCall",
      server: "t3-code",
      tool: "preview_status",
      result: { content: [{ type: "text", text: "attached" }] },
    };
    const data = {
      toolName: "mcp__t3_code__preview_status",
      item,
      resource: devinResourceToolEvent.payload.data.resource,
    };

    expect(extractToolActivityData({ itemType: "mcp_tool_call", data })).toBe(item);
    expect(toolActivityDataBody({ itemType: "mcp_tool_call", toolData: item })).toBe(
      `MCP call\n${JSON.stringify(item, null, 2)}`,
    );
  });

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
