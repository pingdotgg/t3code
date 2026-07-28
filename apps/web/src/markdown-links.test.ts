import { describe, expect, it } from "vite-plus/test";

import {
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

describe("normalizeMarkdownLinkDestination", () => {
  it("unescapes markdown punctuation when normalizing destinations", () => {
    expect(
      resolveMarkdownFileLinkTarget("apps/web/src/routes/\\(chat\\)/\\[id\\].tsx", "/repo"),
    ).toBe("/repo/apps/web/src/routes/(chat)/[id].tsx");
  });

  it("preserves windows path separators before punctuation", () => {
    expect(resolveMarkdownFileLinkTarget(String.raw`C:\src\(group)\page.tsx`)).toBe(
      String.raw`C:\src\(group)\page.tsx`,
    );
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
  });

  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("normalizes file uri hrefs for windows drive paths", () => {
    expect(
      rewriteMarkdownFileUriHref(
        "file:///D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69");
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative paths with route group and dynamic segment characters", () => {
    expect(
      resolveMarkdownFileLinkTarget("apps/web/src/routes/(chat)/[threadId].tsx", "/repo/project"),
    ).toBe("/repo/project/apps/web/src/routes/(chat)/[threadId].tsx");
  });

  it("resolves encoded route group and dynamic segment characters", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "apps/web/src/routes/%28chat%29/%5BthreadId%5D.tsx",
        "/repo/project",
      ),
    ).toBe("/repo/project/apps/web/src/routes/(chat)/[threadId].tsx");
  });

  it("preserves support for conservative extensionless relative file paths", () => {
    expect(resolveMarkdownFileLinkTarget("scripts/release", "/repo/project")).toBe(
      "/repo/project/scripts/release",
    );
  });

  it("does not treat ambiguous encoded relative web links as file paths", () => {
    expect(resolveMarkdownFileLinkTarget("docs/user%20guide", "/repo/project")).toBeNull();
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("formats tooltip display paths relative to the cwd when possible", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath: "t3code/apps/web/src/session-logic.ts:501",
      workspaceRelativePath: "apps/web/src/session-logic.ts",
    });
  });

  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath:
        "t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
      workspaceRelativePath:
        "apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
  });

  it("does not create a preview path for files outside the workspace", () => {
    expect(resolveMarkdownFileLinkMeta("/tmp/report.ts", "/repo/project")).toMatchObject({
      workspaceRelativePath: null,
    });
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});
