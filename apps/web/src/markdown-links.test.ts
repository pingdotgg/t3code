import { describe, expect, it } from "vitest";

import {
  resolveInlineCodeFileLinkMeta,
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

describe("resolveInlineCodeFileLinkMeta", () => {
  const cwd = "/Users/julius/project";

  it("links relative and absolute file paths", () => {
    expect(resolveInlineCodeFileLinkMeta(".plans/worktree-management-v1.md", cwd)).toMatchObject({
      targetPath: "/Users/julius/project/.plans/worktree-management-v1.md",
      basename: "worktree-management-v1.md",
    });
    expect(resolveInlineCodeFileLinkMeta("/workspace/Makefile")).toMatchObject({
      basename: "Makefile",
    });
  });

  it("links Windows-style paths and line positions", () => {
    expect(resolveInlineCodeFileLinkMeta("C:\\Users\\mike\\project\\src\\main.ts")).toMatchObject({
      basename: "main.ts",
    });
    expect(resolveInlineCodeFileLinkMeta("src\\main.ts:71", cwd)).toMatchObject({
      targetPath: "/Users/julius/project/src/main.ts:71",
      line: 71,
    });
  });

  it("links conventional extensionless filenames only with line positions", () => {
    expect(resolveInlineCodeFileLinkMeta("Makefile:12", cwd)).toMatchObject({
      targetPath: "/Users/julius/project/Makefile:12",
      line: 12,
    });
    expect(resolveInlineCodeFileLinkMeta("Dockerfile:8:2", cwd)).toMatchObject({
      line: 8,
      column: 2,
    });
    expect(resolveInlineCodeFileLinkMeta("AGENTS.md", cwd)).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("error:1", cwd)).toBeNull();
  });

  it("rejects hosts, commands, refs, directories, globs, and URLs", () => {
    for (const value of [
      "127.0.0.1:3000",
      "localhost:3000",
      "example.com/index.html",
      "example.software/index.html",
      "api.internal/schema.json",
      "git worktree list --porcelain",
      "origin/main",
      "apps/web",
      "./src",
      "~/project",
      "/workspace/project",
      "release/v1.2",
      "refs/tags/v1.2.3",
      "src/**/*.ts",
      "https://example.com/docs.html",
    ]) {
      expect(resolveInlineCodeFileLinkMeta(value, cwd)).toBeNull();
    }
  });

  it("requires a cwd for relative paths", () => {
    expect(resolveInlineCodeFileLinkMeta(".plans/worktree-management-v1.md")).toBeNull();
  });
});
