import { workspaceRelativeFilePath } from "./path.ts";
import { describe, expect, it } from "vite-plus/test";
import { extractMarkdownLinkHrefs, resolveMarkdownFileLinkTarget } from "./markdownLinks.ts";

import {
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  parseMarkdownFileLink,
} from "./markdownLinks.ts";

describe("isMarkdownFileLinkLabel", () => {
  // regression: #15509 descriptive labels are not mistaken for the linked file name
  it.each([
    ["validates the input", "/repo/src/example.ts:12", false],
    ["example.ts:12", "/repo/src/example.ts:12", true],
    ["example.ts:99", "/repo/src/example.ts:12", false],
  ])("classifies %s for %s", (label, href, expected) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(expected);
  });
});

describe("inlineCodeFilePathCandidate", () => {
  // regression: #13909 model ids in inline code do not become file chips
  it.each([
    ["src\\main.ts", "src/main.ts"],
    ["origin/main", null],
    ["z-ai/glm-5.3", null],
    ["share/man/ls.1", "share/man/ls.1"],
  ])("distinguishes file paths from code and hostnames in %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("parseMarkdownFileLink", () => {
  it.each([
    ["C:%5Crepo%5Cimage.png", "C:\\repo\\image.png"],
    ["</D:/Programme/t3code/ChatMarkdown.tsx:1>", "D:/Programme/t3code/ChatMarkdown.tsx"],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md"],
  ])("recognizes %s as a file", (href, path) => {
    expect(parseMarkdownFileLink(href)?.path).toBe(path);
  });

  it.each(["https://example.com/docs", "/chat/settings#L3", "TODO:12"])(
    "does not treat %s as a file",
    (href) => {
      expect(parseMarkdownFileLink(href)).toBeNull();
    },
  );

  it("accepts conventional extensionless names with or without a position", () => {
    expect(parseMarkdownFileLink("Makefile")).toEqual({ path: "Makefile" });
    expect(parseMarkdownFileLink("Dockerfile:8")).toEqual({ path: "Dockerfile", line: 8 });
    expect(parseMarkdownFileLink("/srv/app/Makefile")).toEqual({ path: "/srv/app/Makefile" });
  });

  it("reads positions from suffixes and line anchors", () => {
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

describe("workspaceRelativeFilePath", () => {
  // regression: #12449 workspace root links resolve to "."
  it.each([
    ["/repo/project", "/repo/project", "."],
    ["C:/", "c:/", "."],
    ["/repo/project/a.ts", undefined, null],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});

describe("extractMarkdownLinkHrefs", () => {
  it.each([
    ["[".repeat(32_000), []],
    ["[a](<foo)bar> invalid [b](ok)", ["<foo", "ok"]],
    ["[[[nested](src/main.ts) [unfinished", ["src/main.ts"]],
  ])("extracts links from incomplete and nested text", (markdown, hrefs) => {
    expect(extractMarkdownLinkHrefs(markdown)).toEqual(hrefs);
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("//cdn.example.com/clip.mp4", "/workspace")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("resolves file uri authorities as windows UNC paths", () => {
    expect(resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  it("keeps an encoded final space in the absolute target", () => {
    expect(resolveMarkdownFileLinkTarget("/tmp/repo/file.ts%20", "/tmp/repo")).toBe(
      "/tmp/repo/file.ts ",
    );
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("decodes an encoded drive colon in a file uri before dropping its slash", () => {
    expect(resolveMarkdownFileLinkTarget("file:///c%3A/Users/x/shot.png")).toBe(
      "c:/Users/x/shot.png",
    );
  });
});
