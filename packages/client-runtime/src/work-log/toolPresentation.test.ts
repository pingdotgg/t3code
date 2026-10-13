import { describe, expect, it } from "@effect/vitest";

import { extractToolActivityPresentation } from "./toolPresentation.ts";

describe("extractToolActivityPresentation", () => {
  it("recovers computer-use presentation for retained calls without result metadata", () => {
    const item = {
      type: "dynamic_tool",
      toolName: "js",
      input: { code: "await sky.get_app_state(app);" },
    };
    expect(extractToolActivityPresentation(item)).toEqual({
      toolSurface: "computer",
      toolSource: { key: "computer-use", name: "Computer Use", kind: "computer" },
    });
    expect(extractToolActivityPresentation({ ...item, toolSurface: "browser" })).toEqual({
      toolSurface: "browser",
    });
    expect(
      extractToolActivityPresentation({ ...item, input: { code: "await fs.readFile(path);" } }),
    ).toEqual({});
  });

  it("replaces a failed Sky call's generic node REPL source", () => {
    const source = { key: "mcp:node_repl", name: "node repl", kind: "integration" };
    const item = {
      type: "dynamic_tool",
      toolName: "node_repl.js",
      title: "js",
      status: "failed",
      toolSource: source,
      input: {
        title: "Restrict the breakpoint to Git actions",
        code: "await sky.type_text({app:'T3 Code (Nightly)',text:'debug(ga.run)'});",
      },
    };
    expect(extractToolActivityPresentation(item)).toEqual({
      toolSurface: "computer",
      toolSource: { key: "computer-use", name: "Computer Use", kind: "computer" },
    });
    expect(
      extractToolActivityPresentation({
        ...item,
        input: { code: "await fetch('http://127.0.0.1/json/list');" },
      }),
    ).toEqual({ toolSource: source });
  });

  it("retains valid image paths independently of redacted output", () => {
    expect(
      extractToolActivityPresentation({ viewedImagePath: " /workspace/reference.webp " }),
    ).toEqual({ viewedImagePath: "/workspace/reference.webp" });
    for (const viewedImagePath of [
      "/workspace/README.md",
      "/workspace/a.png\nother",
      "x".repeat(4097) + ".png",
    ])
      expect(extractToolActivityPresentation({ viewedImagePath })).toEqual({});
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
