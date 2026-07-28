import { describe, expect, it } from "vite-plus/test";

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

describe("resolveInlineCodeFileLinkMeta", () => {
  it("links relative paths with file extensions", () => {
    expect(
      resolveInlineCodeFileLinkMeta(".plans/worktree-management-v1.md", "/Users/julius/project"),
    ).toMatchObject({
      targetPath: "/Users/julius/project/.plans/worktree-management-v1.md",
      basename: "worktree-management-v1.md",
    });
  });

  it("links absolute posix paths", () => {
    expect(resolveInlineCodeFileLinkMeta("/Users/julius/project/AGENTS.md")).toMatchObject({
      targetPath: "/Users/julius/project/AGENTS.md",
    });
    expect(resolveInlineCodeFileLinkMeta("/usr/local/bin/tool")).toMatchObject({
      targetPath: "/usr/local/bin/tool",
    });
    expect(resolveInlineCodeFileLinkMeta("/workspace/Makefile")).toMatchObject({
      basename: "Makefile",
    });
    expect(resolveInlineCodeFileLinkMeta("/chat/settings")).toBeNull();
  });

  it("links windows drive paths", () => {
    expect(resolveInlineCodeFileLinkMeta("C:\\Users\\mike\\project\\src\\main.ts")).toMatchObject({
      basename: "main.ts",
    });
  });

  it("links relative paths with line positions", () => {
    expect(
      resolveInlineCodeFileLinkMeta("src/processRunner.ts:71", "/Users/julius/project"),
    ).toMatchObject({
      targetPath: "/Users/julius/project/src/processRunner.ts:71",
      line: 71,
    });
  });

  it("links bare filenames only when a line suffix marks them as file references", () => {
    expect(resolveInlineCodeFileLinkMeta("script.ts:10", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/script.ts:10",
      line: 10,
    });
    expect(resolveInlineCodeFileLinkMeta("AGENTS.md", "/Users/julius/project")).toBeNull();
  });

  it("links extensionless bare filenames with a line suffix", () => {
    expect(resolveInlineCodeFileLinkMeta("Makefile:12", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/Makefile:12",
      basename: "Makefile",
      line: 12,
    });
    expect(resolveInlineCodeFileLinkMeta("Dockerfile:8:2", "/Users/julius/project")).toMatchObject({
      line: 8,
      column: 2,
    });
    expect(resolveInlineCodeFileLinkMeta("Makefile:12")).toBeNull();
  });

  it("does not treat arbitrary name:digits shapes as files", () => {
    expect(resolveInlineCodeFileLinkMeta("error:1", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("TODO:12", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("exit:0", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("port:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("http:80", "/Users/julius/project")).toBeNull();
  });

  it("links dot-prefixed relative paths without extensions", () => {
    expect(
      resolveInlineCodeFileLinkMeta("./scripts/deploy", "/Users/julius/project"),
    ).toMatchObject({
      basename: "deploy",
    });
  });

  it("links relative windows-style paths by normalizing backslashes", () => {
    expect(resolveInlineCodeFileLinkMeta("src\\main.ts", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/src/main.ts",
      basename: "main.ts",
    });
    expect(
      resolveInlineCodeFileLinkMeta(".\\scripts\\deploy", "/Users/julius/project"),
    ).toMatchObject({
      basename: "deploy",
    });
  });

  it("ignores hosts, ports, and versions", () => {
    expect(resolveInlineCodeFileLinkMeta("127.0.0.1:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("localhost:3000", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.com/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("example.com:8080", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("10.0.0.1:80:1", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("localhost/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.uk/index.html", "/Users/julius/project"),
    ).toBeNull();
  });

  it("still links files whose extension merely resembles a tld", () => {
    expect(resolveInlineCodeFileLinkMeta("script.ts:10", "/Users/julius/project")).not.toBeNull();
    expect(resolveInlineCodeFileLinkMeta("src/setup.sh:3", "/Users/julius/project")).not.toBeNull();
    expect(resolveInlineCodeFileLinkMeta("Makefile.in:12", "/Users/julius/project")).not.toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("conf.d/nginx.conf", "/Users/julius/project"),
    ).not.toBeNull();
  });

  it("prefers file over country-code host when a line suffix is present", () => {
    expect(resolveInlineCodeFileLinkMeta("script.pl:10", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/script.pl:10",
      line: 10,
    });
    expect(resolveInlineCodeFileLinkMeta("model.pt:3", "/Users/julius/project")).not.toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.pl/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("example.com:8080", "/Users/julius/project")).toBeNull();
  });

  it("ignores commands, flags, and expressions", () => {
    expect(resolveInlineCodeFileLinkMeta("git worktree list --porcelain")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("node.meta", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("pnpm install", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("src/**/*.ts", "/Users/julius/project")).toBeNull();
  });

  it("ignores extension-less relative segments like git refs and directories", () => {
    expect(resolveInlineCodeFileLinkMeta("origin/main", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("apps/web", "/Users/julius/project")).toBeNull();
  });

  it("ignores external urls", () => {
    expect(resolveInlineCodeFileLinkMeta("https://example.com/docs.html")).toBeNull();
  });

  it("ignores relative paths without a cwd to resolve against", () => {
    expect(resolveInlineCodeFileLinkMeta(".plans/worktree-management-v1.md")).toBeNull();
  });
});
