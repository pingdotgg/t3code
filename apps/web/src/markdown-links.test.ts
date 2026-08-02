import { describe, expect, it } from "vite-plus/test";

import {
  extractMarkdownLinkHrefs,
  normalizeMarkdownLinkHrefKey,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

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

  it("unwraps angle-bracketed file uri hrefs", () => {
    expect(
      rewriteMarkdownFileUriHref(" <file:///D:/Programme/t3code/apps/web/src/markdown-links.ts> "),
    ).toBe("D:/Programme/t3code/apps/web/src/markdown-links.ts");
  });
});

describe("extractMarkdownLinkHrefs", () => {
  it("extracts bare destinations", () => {
    expect(extractMarkdownLinkHrefs("[control](/tmp/link%20repro/manifest.tsv)")).toEqual([
      "/tmp/link%20repro/manifest.tsv",
    ]);
  });

  it("extracts angle-bracket destinations that contain spaces", () => {
    expect(extractMarkdownLinkHrefs("[angle](</tmp/link repro/manifest.tsv>)")).toEqual([
      "/tmp/link repro/manifest.tsv",
    ]);
  });

  it("keeps balanced parentheses inside bare destinations", () => {
    expect(extractMarkdownLinkHrefs("[parens](/tmp/a(1).txt)")).toEqual(["/tmp/a(1).txt"]);
  });

  it("ignores a trailing title after the destination", () => {
    expect(extractMarkdownLinkHrefs('[t](/tmp/a.txt "title")')).toEqual(["/tmp/a.txt"]);
  });

  it("extracts every link in a multi-line message", () => {
    const text = [
      "[angle](</tmp/link repro/manifest.tsv>)",
      "[parens](/tmp/a(1).txt)",
      "[control](/tmp/link%20repro/manifest.tsv)",
    ].join("\n\n");
    expect(extractMarkdownLinkHrefs(text)).toEqual([
      "/tmp/link repro/manifest.tsv",
      "/tmp/a(1).txt",
      "/tmp/link%20repro/manifest.tsv",
    ]);
  });
});

describe("normalizeMarkdownLinkHrefKey", () => {
  it("matches a percent-encoded href to its unencoded source destination", () => {
    // The angle-bracket source keeps a literal space; react-markdown renders it
    // as %20. Both must normalize to the same key so the file link is detected.
    expect(normalizeMarkdownLinkHrefKey("/tmp/link repro/manifest.tsv")).toBe(
      normalizeMarkdownLinkHrefKey("/tmp/link%20repro/manifest.tsv"),
    );
  });

  it("is stable for bare destinations with balanced parentheses", () => {
    expect(normalizeMarkdownLinkHrefKey("/tmp/a(1).txt")).toBe("/tmp/a(1).txt");
  });

  it("preserves single-decode semantics for file URIs", () => {
    expect(normalizeMarkdownLinkHrefKey("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
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

  it("resolves angle-bracketed windows drive paths", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "</D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1>",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1");
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});
