import { describe, expect, it } from "vite-plus/test";

import {
  normalizeWindowsMarkdownFileLinks,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

function firstMarkdownLinkDestination(markdown: string): string {
  const match = markdown.match(/\[[^\]]*]\(([^)]+)\)/);
  const dest = match?.[1];
  if (!dest) throw new Error(`expected a markdown link in: ${markdown}`);
  return dest;
}

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

  it("rewrites unc file urls into windows unc paths", () => {
    expect(rewriteMarkdownFileUriHref("file://server/share/file.txt")).toBe(
      "\\\\server\\share\\file.txt",
    );
  });

  it("keeps leftover windows drive and unc hrefs", () => {
    expect(rewriteMarkdownFileUriHref("D:/tmp/t3-link-repro/example.md")).toBe(
      "D:/tmp/t3-link-repro/example.md",
    );
    expect(rewriteMarkdownFileUriHref("M:\\batches\\issue-40-v1\\docs\\prompt.md")).toBe(
      "M:\\batches\\issue-40-v1\\docs\\prompt.md",
    );
    expect(rewriteMarkdownFileUriHref("\\\\server\\share\\file.txt")).toBe(
      "\\\\server\\share\\file.txt",
    );
  });

  it("does not treat other schemes as filesystem hrefs", () => {
    expect(rewriteMarkdownFileUriHref("https://example.com/docs")).toBeNull();
    expect(rewriteMarkdownFileUriHref("javascript:alert(1)")).toBeNull();
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

  it("resolves windows drive destinations", () => {
    expect(resolveMarkdownFileLinkTarget("D:/tmp/t3-link-repro/example.md")).toBe(
      "D:/tmp/t3-link-repro/example.md",
    );
  });

  it("resolves unc file urls back to windows unc paths", () => {
    expect(resolveMarkdownFileLinkTarget("file://server/share/file.txt")).toBe(
      "\\\\server\\share\\file.txt",
    );
  });
});

describe("normalizeWindowsMarkdownFileLinks", () => {
  it("rewrites windows drive destinations to file urls that resolve", () => {
    const rewritten = normalizeWindowsMarkdownFileLinks("[Open](D:/tmp/t3-link-repro/example.md)");
    const dest = firstMarkdownLinkDestination(rewritten);
    expect(dest).toBe("file:///D:/tmp/t3-link-repro/example.md");
    expect(rewriteMarkdownFileUriHref(dest)).toBe("D:/tmp/t3-link-repro/example.md");
    expect(resolveMarkdownFileLinkTarget(dest)).toBe("D:/tmp/t3-link-repro/example.md");
  });

  it("rewrites backslash drive destinations and angle-bracket destinations", () => {
    expect(normalizeWindowsMarkdownFileLinks("[Open](D:\\tmp\\t3-link-repro\\example.md)")).toBe(
      "[Open](file:///D:/tmp/t3-link-repro/example.md)",
    );
    expect(normalizeWindowsMarkdownFileLinks("[Open](<D:/tmp/t3-link-repro/example.md>)")).toBe(
      "[Open](<file:///D:/tmp/t3-link-repro/example.md>)",
    );
    expect(normalizeWindowsMarkdownFileLinks("<D:/tmp/t3-link-repro/example.md>")).toBe(
      "<file:///D:/tmp/t3-link-repro/example.md>",
    );
  });

  it("autolinks bare windows drive paths", () => {
    const rewritten = normalizeWindowsMarkdownFileLinks(
      "See M:\\batches\\issue-40-v1\\docs\\prompt.md please",
    );
    expect(rewritten).toBe(
      "See [M:\\batches\\issue-40-v1\\docs\\prompt.md](file:///M:/batches/issue-40-v1/docs/prompt.md) please",
    );
    expect(resolveMarkdownFileLinkTarget(firstMarkdownLinkDestination(rewritten))).toBe(
      "M:/batches/issue-40-v1/docs/prompt.md",
    );
  });

  it("autolinks unc paths", () => {
    const rewritten = normalizeWindowsMarkdownFileLinks("See \\\\server\\share\\file.txt");
    expect(rewritten).toBe("See [\\\\server\\share\\file.txt](file://server/share/file.txt)");
    expect(resolveMarkdownFileLinkTarget(firstMarkdownLinkDestination(rewritten))).toBe(
      "\\\\server\\share\\file.txt",
    );
  });

  it("does not rewrite inside fenced code or inline code", () => {
    const fenced = "```\nD:/tmp/t3-link-repro/example.md\n```";
    const inline = "Use `D:/tmp/t3-link-repro/example.md` here";
    const tilde = "~~~\nM:\\batches\\issue-40-v1\\docs\\prompt.md\n~~~";
    expect(normalizeWindowsMarkdownFileLinks(fenced)).toBe(fenced);
    expect(normalizeWindowsMarkdownFileLinks(inline)).toBe(inline);
    expect(normalizeWindowsMarkdownFileLinks(tilde)).toBe(tilde);
  });

  it("does not touch https links", () => {
    const httpsLink = "[docs](https://example.com/D:/not-a-path)";
    expect(normalizeWindowsMarkdownFileLinks(httpsLink)).toBe(httpsLink);
    expect(
      normalizeWindowsMarkdownFileLinks("See https://example.com/docs and D:/tmp/example.md"),
    ).toBe("See https://example.com/docs and [D:/tmp/example.md](file:///D:/tmp/example.md)");
  });

  it("leaves existing file urls and drive roots alone", () => {
    const fileUrl = "[Open](file:///D:/tmp/t3-link-repro/example.md)";
    expect(normalizeWindowsMarkdownFileLinks(fileUrl)).toBe(fileUrl);
    expect(normalizeWindowsMarkdownFileLinks("See D:\\ and C:/")).toBe("See D:\\ and C:/");
  });

  it("strips trailing sentence punctuation from autolinked paths", () => {
    expect(
      normalizeWindowsMarkdownFileLinks("See M:\\batches\\issue-40-v1\\docs\\prompt.md."),
    ).toBe(
      "See [M:\\batches\\issue-40-v1\\docs\\prompt.md](file:///M:/batches/issue-40-v1/docs/prompt.md).",
    );
  });

  it("does not consume emphasis markers around a bare windows path", () => {
    expect(normalizeWindowsMarkdownFileLinks("**D:\\foo.md**")).toBe(
      "**[D:\\foo.md](file:///D:/foo.md)**",
    );
  });

  it("does not rewrite indented code or fenced code with a mid-line fence sequence", () => {
    const indented = "    D:\\tmp\\file.md";
    const tabIndented = "\tD:\\tmp\\file.md";
    const fencedMidline = '```\nconst s = "```";\nD:\\tmp\\file.md\n```';
    expect(normalizeWindowsMarkdownFileLinks(indented)).toBe(indented);
    expect(normalizeWindowsMarkdownFileLinks(tabIndented)).toBe(tabIndented);
    expect(normalizeWindowsMarkdownFileLinks(fencedMidline)).toBe(fencedMidline);
  });

  it("still autolinks a path after a closed fence", () => {
    expect(normalizeWindowsMarkdownFileLinks("```\ncode\n```\nD:\\tmp\\file.md")).toBe(
      "```\ncode\n```\n[D:\\tmp\\file.md](file:///D:/tmp/file.md)",
    );
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
