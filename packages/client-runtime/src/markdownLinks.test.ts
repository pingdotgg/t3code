import { describe, expect, it } from "vite-plus/test";

import {
  fileBasename,
  formatFilePathPosition,
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  parseFileUrlHref,
  parseMarkdownFileLink,
  splitFilePathPosition,
  workspaceRelativeFilePath,
} from "./markdownLinks.ts";

describe("isMarkdownFileLinkLabel", () => {
  it.each([
    ["validates the input", "/repo/src/example.ts:12", false],
    ["read src/example.ts", "/repo/src/example.ts:12", false],
    ["example.ts?why this matters", "/repo/src/example.ts", false],
    ["example.ts", "/repo/src/example.ts:12", true],
    ["example.ts:12", "/repo/src/example.ts:12", true],
    ["example.ts:99", "/repo/src/example.ts:12", false],
    ["example.ts:12:2", "/repo/src/example.ts:12:2", true],
    ["example.ts:12:3", "/repo/src/example.ts:12:2", false],
    ["example.ts:49-74", "/repo/src/example.ts:49-74", true],
    ["example.ts:49-75", "/repo/src/example.ts:49-74", false],
    ["example.ts:49-74", "/repo/src/example.ts:49", false],
    ["example.ts:12", "/repo/src/example.ts", false],
    ["src/example.ts:12", "/repo/src/example.ts:12", true],
    ["./src/example.ts", "/repo/src/example.ts", true],
    ["/repo/src/example.ts", "/repo/src/example.ts", true],
    ["src/", "/home/me/project/src/", true],
    ["EXAMPLE.TS", "C:/repo/src/example.ts:12", true],
    ["file name.ts", "file:///repo/file%20name.ts", true],
    ["", "/repo/src/example.ts", true],
  ])("classifies %s for %s", (label, href, expected) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(expected);
  });
});

describe("inlineCodeFilePathCandidate", () => {
  it.each([
    ["src\\main.ts", "src/main.ts"],
    ["C:\\Users\\demo\\image.png", "C:\\Users\\demo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["conf.d/nginx.conf", "conf.d/nginx.conf"],
    ["script.pl:10", "script.pl:10"],
    ["main.ts:49-74", "main.ts:49-74"],
    ["src\\main.ts:49-74", "src/main.ts:49-74"],
    ["Makefile:49-74", "Makefile:49-74"],
    ["script.pl:49-74", "script.pl:49-74"],
    ["node.meta", null],
    ["Recorded evidence here: /tmp/image.png", null],
    ["origin/main", null],
    ["127.0.0.1:3000", null],
    ["localhost:49-74", null],
    ["example.com:49-74", null],
    ["example.com/index.html", null],
    ["example.pl/index.html", null],
    ["z-ai/glm-5.3", null],
    ["z-ai/glm-5.3:12", null],
    ["z-ai/glm-5.3:49-74", null],
    ["python/3.12", null],
    ["Qwen/Qwen2.5-Coder", null],
    ["meta-llama/Llama-3.1-8B", null],
    ["share/man/ls.1", "share/man/ls.1"],
    ["usr/lib/libfoo.so.1", "usr/lib/libfoo.so.1"],
    ["vendor/jquery-3.6.0.min.js", "vendor/jquery-3.6.0.min.js"],
    ["./models/glm-5.3", "./models/glm-5.3"],
  ])("distinguishes file paths from code and hostnames in %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("parseFileUrlHref", () => {
  it.each([
    ["file:///Users/julius/project/src/main.ts#L42", "/Users/julius/project/src/main.ts", "#L42"],
    [
      "file:///D:/Programme/t3code/OpenInPicker.tsx#L69",
      "D:/Programme/t3code/OpenInPicker.tsx",
      "#L69",
    ],
    ["file://server/share/workspace-image.svg", "\\\\server\\share\\workspace-image.svg", ""],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md", ""],
  ])("parses %s", (href, path, hash) => {
    expect(parseFileUrlHref(href)).toEqual({ path, hash });
  });

  it("keeps percent-encoding so the caller decodes once", () => {
    expect(parseFileUrlHref("file:///Users/julius/project/file%2520name.md")?.path).toBe(
      "/Users/julius/project/file%2520name.md",
    );
    expect(parseFileUrlHref("file:///c%3A/Users/x/shot.png")?.path).toBe("/c%3A/Users/x/shot.png");
  });

  it.each(["https://example.com/a.ts", "file://%", "/Users/julius/a.ts"])("rejects %s", (href) => {
    expect(parseFileUrlHref(href)).toBeNull();
  });
});

describe("splitFilePathPosition", () => {
  it.each([
    ["src/main.ts", "", { path: "src/main.ts" }],
    ["src/main.ts:12", "", { path: "src/main.ts", line: 12 }],
    ["src/main.ts:12:5", "", { path: "src/main.ts", line: 12, column: 5 }],
    ["src/main.ts:49-74", "", { path: "src/main.ts", line: 49, endLine: 74 }],
    ["src/main.ts:49-49", "", { path: "src/main.ts", line: 49, endLine: 49 }],
    ["src/main.ts:49-0", "", { path: "src/main.ts", line: 49 }],
    ["src/main.ts:74-49", "", { path: "src/main.ts", line: 74 }],
    ["src/main.ts:0-74", "", { path: "src/main.ts" }],
    ["src/main.ts:49-", "", { path: "src/main.ts:49-" }],
    ["src/main.ts", "#L18C2", { path: "src/main.ts", line: 18, column: 2 }],
    ["src/main.ts:3", "#L18C2", { path: "src/main.ts", line: 3 }],
    ["src/main.ts:0", "", { path: "src/main.ts" }],
    ["src/main.ts", "#section", { path: "src/main.ts" }],
  ])("splits %s%s", (path, hash, expected) => {
    expect(splitFilePathPosition(path, hash)).toEqual(expected);
  });
});

describe("parseMarkdownFileLink", () => {
  // Both clients consume this table, so a path the web app recognizes is one
  // the mobile app recognizes too.
  it.each([
    ["/Users/julius/project/AGENTS.md", "/Users/julius/project/AGENTS.md"],
    ["/home/me/notes.md", "/home/me/notes.md"],
    ["/usr/local/bin/tool", "/usr/local/bin/tool"],
    ["/workspace/Makefile", "/workspace/Makefile"],
    ["/tmp/favicons/", "/tmp/favicons/"],
    ["C:\\Users\\mike\\project\\src\\main.ts", "C:\\Users\\mike\\project\\src\\main.ts"],
    ["C:%5Crepo%5Cimage.png", "C:\\repo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["/D:/Programme/t3code/OpenInPicker.tsx", "D:/Programme/t3code/OpenInPicker.tsx"],
    ["</D:/Programme/t3code/ChatMarkdown.tsx:1>", "D:/Programme/t3code/ChatMarkdown.tsx"],
    ["file:///Users/julius/project/file%2520name.md", "/Users/julius/project/file%20name.md"],
    ["file://server/share/workspace-image.svg", "\\\\server\\share\\workspace-image.svg"],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md"],
    ["apps/mobile/src/index.ts:10", "apps/mobile/src/index.ts"],
    ["docs/My%20Folder/checklist.xml", "docs/My Folder/checklist.xml"],
    ["Updated%20cutover%20checklist.md", "Updated cutover checklist.md"],
    ["./scripts/deploy", "./scripts/deploy"],
    ["~/notes/today.md", "~/notes/today.md"],
    ["AGENTS.md", "AGENTS.md"],
    ["script.ts:10", "script.ts"],
    ["script.ts:49-74", "script.ts"],
    ["apps/mobile/src/index.ts:49-74", "apps/mobile/src/index.ts"],
    ["/Users/julius/project/src/main.ts:49-74", "/Users/julius/project/src/main.ts"],
    ["C:\\Users\\mike\\project\\src\\main.ts:49-74", "C:\\Users\\mike\\project\\src\\main.ts"],
    ["/tmp/clip%23one.mp4#t=2", "/tmp/clip#one.mp4"],
  ])("recognizes %s as a file", (href, path) => {
    expect(parseMarkdownFileLink(href)?.path).toBe(path);
  });

  it.each([
    "",
    "#anchor",
    "//cdn.example.com/clip.mp4",
    "https://example.com/docs",
    "mailto:someone@example.com",
    "javascript:alert(1)",
    "/chat/settings",
    "/chat/settings#L3",
    "/app#L1",
    "readme",
    "TODO:12",
    "TODO:49-74",
    "script.ts:49-",
    "script.ts:49-nope",
  ])("does not treat %s as a file", (href) => {
    expect(parseMarkdownFileLink(href)).toBeNull();
  });

  it("accepts conventional extensionless names with or without a position", () => {
    expect(parseMarkdownFileLink("Makefile")).toEqual({ path: "Makefile" });
    expect(parseMarkdownFileLink("Dockerfile:8")).toEqual({ path: "Dockerfile", line: 8 });
    expect(parseMarkdownFileLink("/srv/app/Makefile")).toEqual({ path: "/srv/app/Makefile" });
  });

  it("reads positions from suffixes and line anchors", () => {
    const range = parseMarkdownFileLink("script.ts:49-74");
    expect(range).toEqual({ path: "script.ts", line: 49, endLine: 74 });
    expect(formatFilePathPosition(range!)).toBe("script.ts:49-74");
    expect(parseMarkdownFileLink("/Users/julius/project/src/main.ts#L42C7")).toEqual({
      path: "/Users/julius/project/src/main.ts",
      line: 42,
      column: 7,
    });
    expect(parseMarkdownFileLink("file://server/share/src/main.ts#L42C7")).toMatchObject({
      path: "\\\\server\\share\\src\\main.ts",
      line: 42,
      column: 7,
    });
  });
});

describe("fileBasename", () => {
  it.each([
    ["/tmp/favicons/", "favicons"],
    ["C:\\Users\\kelchm\\.claude\\", ".claude"],
    ["/tmp/", "tmp"],
    ["AGENTS.md", "AGENTS.md"],
    ["/", "/"],
  ])("labels %s as %s", (path, basename) => {
    expect(fileBasename(path)).toBe(basename);
  });
});

describe("workspaceRelativeFilePath", () => {
  it.each([
    ["/repo/project", "/repo/project", "."],
    ["/repo/project/", "/repo/project/", "."],
    ["/", "/", "."],
    ["C:/USERS/mike/project", "c:/users/MIKE/project", "."],
    ["C:/", "c:/", "."],
    ["/repo/project/src/main.ts", "/repo/project", "src/main.ts"],
    ["/repo/project/src/main.ts", "/repo/project/", "src/main.ts"],
    ["C:\\Users\\mike\\t3code\\apps\\web\\a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/C:/Users/mike/t3code/apps/web/a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["/tmp/case/project/probe.txt", "/tmp/case/Project", null],
    ["//tmp/case/project/probe.txt", "//tmp/case/Project", null],
    ["/tmp/case/Project/probe.txt", "/tmp/case/Project", "probe.txt"],
    ["C:/USERS/mike/t3code/main.ts", "c:/users/MIKE/t3code", "main.ts"],
    ["/C:/USERS/mike/t3code/main.ts", "/c:/users/MIKE/t3code", "main.ts"],
    ["\\\\server\\share\\PROJECT\\main.ts", "\\\\Server\\Share\\Project", "main.ts"],
    ["/tmp/repo/file.ts", "/", "tmp/repo/file.ts"],
    ["C:/Users/MIKE/main.ts", "c:/", "Users/MIKE/main.ts"],
    ["\\\\server\\SHARE\\file.ts", "\\\\Server\\Share\\", "file.ts"],
    ["/tmp/repo/file.ts ", "/tmp/repo", "file.ts "],
    ["/tmp/report.ts", "/repo/project", null],
    ["/repo/project-two/a.ts", "/repo/project", null],
    ["/repo/project/a.ts", undefined, null],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});
