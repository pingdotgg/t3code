import { describe, expect, it } from "vite-plus/test";

import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  shouldOpenMarkdownFileLinkInBrowserByDefault,
  shouldOpenMarkdownFileLinkInEditor,
} from "./markdown-links";

describe("shouldOpenMarkdownFileLinkInEditor", () => {
  it("uses command-click on macOS", () => {
    expect(shouldOpenMarkdownFileLinkInEditor({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(
      true,
    );
    expect(shouldOpenMarkdownFileLinkInEditor({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(
      false,
    );
  });

  it("uses control-click on other platforms", () => {
    expect(
      shouldOpenMarkdownFileLinkInEditor({ metaKey: false, ctrlKey: true }, "Linux x86_64"),
    ).toBe(true);
    expect(
      shouldOpenMarkdownFileLinkInEditor({ metaKey: true, ctrlKey: false }, "Linux x86_64"),
    ).toBe(false);
  });
});

describe("shouldOpenMarkdownFileLinkInBrowserByDefault", () => {
  it("keeps PDFs browser-first while source files open in the file viewer", () => {
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.pdf")).toBe(true);
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.PDF?download=1")).toBe(true);
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.html")).toBe(false);
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.xml")).toBe(false);
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

  it("preserves file uri authorities as windows UNC paths", () => {
    expect(rewriteMarkdownFileUriHref("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  it("treats a localhost file uri as a local path", () => {
    expect(rewriteMarkdownFileUriHref("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
  });

  it("unwraps angle-bracketed file uri hrefs", () => {
    expect(
      rewriteMarkdownFileUriHref(" <file:///D:/Programme/t3code/apps/web/src/markdown-links.ts> "),
    ).toBe("D:/Programme/t3code/apps/web/src/markdown-links.ts");
  });
});

describe("relative links inside a rendered host file", () => {
  it("anchor to the file's directory while workspace membership follows cwd", () => {
    const meta = resolveMarkdownFileLinkMeta("appendix.md", "/repo", "/tmp/report");
    expect(meta).toMatchObject({
      filePath: "/tmp/report/appendix.md",
      workspaceRelativePath: null,
    });
    const inline = resolveInlineCodeFileLinkMeta("Makefile:12", "/repo", "/tmp/report");
    expect(inline).toMatchObject({ filePath: "/tmp/report/Makefile", line: 12 });
    expect(resolveMarkdownFileLinkMeta("src/main.ts", "/repo", "/repo/docs")).toMatchObject({
      filePath: "/repo/docs/src/main.ts",
      workspaceRelativePath: "docs/src/main.ts",
    });
  });

  it("resolve multi-segment inline code from the workspace root in a workspace file", () => {
    expect(
      resolveInlineCodeFileLinkMeta("docs/ai/design.md", "/repo", "/repo/docs/ai"),
    ).toMatchObject({ filePath: "/repo/docs/ai/design.md" });
    expect(
      resolveInlineCodeFileLinkMeta("src/index.ts:4", "/repo", "/repo/packages/a"),
    ).toMatchObject({ filePath: "/repo/src/index.ts", line: 4 });
  });

  it("keep sibling and explicitly relative inline code beside the file", () => {
    expect(resolveInlineCodeFileLinkMeta("design.md:12", "/repo", "/repo/docs/ai")).toMatchObject({
      filePath: "/repo/docs/ai/design.md",
      line: 12,
    });
    expect(
      resolveInlineCodeFileLinkMeta("./src/index.ts", "/repo", "/repo/packages/a"),
    ).toMatchObject({ filePath: "/repo/packages/a/./src/index.ts" });
    expect(resolveInlineCodeFileLinkMeta("../b/notes.md", "/repo", "/repo/docs/a")).toMatchObject({
      filePath: "/repo/docs/a/../b/notes.md",
    });
  });

  it("keep multi-segment inline code beside a file outside the workspace", () => {
    expect(resolveInlineCodeFileLinkMeta("src/main.ts", "/repo", "/tmp/report")).toMatchObject({
      filePath: "/tmp/report/src/main.ts",
      workspaceRelativePath: null,
    });
  });
});

describe("resolveInlineCodeFileLinkMeta", () => {
  it("links relative paths with file extensions", () => {
    expect(
      resolveInlineCodeFileLinkMeta("docs/internals/workspace-layout.md", "/Users/julius/project"),
    ).toMatchObject({
      targetPath: "/Users/julius/project/docs/internals/workspace-layout.md",
      basename: "workspace-layout.md",
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
    expect(resolveInlineCodeFileLinkMeta("docs/internals/workspace-layout.md")).toBeNull();
  });
});

describe("directory paths with a trailing separator", () => {
  it("keeps the final segment for a POSIX directory path", () => {
    expect(resolveMarkdownFileLinkMeta("/tmp/favicons/", "/repo/project")).toMatchObject({
      basename: "favicons",
    });
  });

  it("keeps the final segment for a Windows directory path", () => {
    expect(
      resolveMarkdownFileLinkMeta("C:\\Users\\kelchm\\.claude\\", "/repo/project"),
    ).toMatchObject({ basename: ".claude" });
  });

  it("matches the label of the same path without a trailing separator", () => {
    const withSlash = resolveMarkdownFileLinkMeta("/tmp/favicons/", "/repo/project");
    const withoutSlash = resolveMarkdownFileLinkMeta("/tmp/favicons", "/repo/project");
    expect(withSlash?.basename).toBe(withoutSlash?.basename);
  });

  it("does not produce an empty label for the filesystem root", () => {
    const meta = resolveMarkdownFileLinkMeta("/tmp/", "/repo/project");
    expect(meta?.basename).not.toBe("");
  });
});

it("routes the project-root code link to the workspace explorer", () => {
  const cwd = "/Users/saphid/.t3/worktrees/ov2-standalone-20260918";
  expect(resolveInlineCodeFileLinkMeta(cwd, cwd)).toMatchObject({
    workspaceRelativePath: ".",
    filePath: cwd,
  });
});
