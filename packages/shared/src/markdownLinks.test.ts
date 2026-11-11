import { MessageId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { collectThreadFilePaths, createThreadFilePathIndex } from "./threadFilePaths.ts";
import { workspaceRelativeFilePath } from "./path.ts";
import { describe, expect, it } from "vite-plus/test";
import { serializeComposerFileLink } from "./composerTrigger.ts";
import {
  extractMarkdownLinkHrefs,
  resolveMarkdownFileLinkTarget,
  resolveThreadFilePathCandidate,
} from "./markdownLinks.ts";

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
    ["example.ts:12-20", "/repo/src/example.ts:12-20", true],
    ["example.ts:12-20", "/repo/src/example.ts:12", false],
  ])("classifies %s for %s", (label, href, expected) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(expected);
  });
});

describe("inlineCodeFilePathCandidate", () => {
  // regression: #13909 model ids in inline code do not become file chips
  it.each([
    ["src\\main.ts", "src/main.ts"],
    ["allocator.cc:217", "allocator.cc:217"],
    ["src/http.ts:42-64", "src/http.ts:42-64"],
    ["http.ts:42-64", "http.ts:42-64"],
    ["origin/main", null],
    ["z-ai/glm-5.3", null],
    ["share/man/ls.1", "share/man/ls.1"],
    ["src/main.ts/", null],
    ["./patches/", "./patches/"],
    // regression: #30757 an agent's shortened path is not a file
    ["/tmp/claude-1000/...", null],
    ["/tmp/claude-1000/...:12", null],
    ["/tmp/.../scratchpad/notes.md", null],
    ["~/projects/…/notes.md", null],
    ["src/.../main.ts", null],
  ])("distinguishes file paths from code and hostnames in %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("parseMarkdownFileLink", () => {
  it.each([
    ["C:%5Crepo%5Cimage.png", "C:\\repo\\image.png"],
    ["</D:/Programme/t3code/ChatMarkdown.tsx:1>", "D:/Programme/t3code/ChatMarkdown.tsx"],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md"],
    ["app/routes/posts.$postId.tsx", "app/routes/posts.$postId.tsx"],
    ["src/routes/+page.svelte", "src/routes/+page.svelte"],
    ["app/(marketing)/page.tsx:12", "app/(marketing)/page.tsx"],
    ["pages/posts/%5Bid%5D.tsx", "pages/posts/[id].tsx"],
    ["+page.svelte", "+page.svelte"],
    ["[id].tsx", "[id].tsx"],
    ["/\\server\\share\\x.ts", "/\\server\\share\\x.ts"],
  ])("recognizes %s as a file", (href, path) => {
    expect(parseMarkdownFileLink(href)?.path).toBe(path);
  });

  it.each([
    "app/routes/posts.$postId.tsx",
    "pages/posts/[id].tsx",
    "docs/My File (draft).md",
    "@scope/package.json",
    "$postId.tsx",
  ])("reads back the composer's link to %s", (path) => {
    const destination = /\]\((.*)\)$/.exec(serializeComposerFileLink(path))?.[1];
    expect(parseMarkdownFileLink(destination ?? "")?.path).toBe(path);
  });

  it.each([
    "https://example.com/docs",
    "/chat/settings#L3",
    "TODO:12",
    "patches",
    "me@example.com",
    "foo(bar)",
    "$HOME",
    "\\foo.ts",
  ])("does not treat %s as a file", (href) => {
    expect(parseMarkdownFileLink(href)).toBeNull();
  });

  it("recognizes a relative folder that ends in a slash", () => {
    expect(parseMarkdownFileLink("patches/")).toEqual({ path: "patches/" });
    expect(parseMarkdownFileLink("docs/My%20Folder/")?.path).toBe("docs/My Folder/");
  });

  // regression: #16096 relative links with non-ASCII names open as files
  it("recognizes relative paths with non-ASCII names", () => {
    expect(parseMarkdownFileLink("pastexam/線性代數/exam_易志偉.pdf")?.path).toBe(
      "pastexam/線性代數/exam_易志偉.pdf",
    );
    expect(parseMarkdownFileLink("Résumé%20final.pdf")?.path).toBe("Résumé final.pdf");
    expect(parseMarkdownFileLink("資料.備份")?.path).toBe("資料.備份");
  });

  it("accepts conventional extensionless names with or without a position", () => {
    expect(parseMarkdownFileLink("Makefile")).toEqual({ path: "Makefile" });
    expect(parseMarkdownFileLink("Dockerfile:8")).toEqual({ path: "Dockerfile", line: 8 });
    expect(parseMarkdownFileLink("/srv/app/Makefile")).toEqual({ path: "/srv/app/Makefile" });
  });

  it("reads line ranges and opens them at their first line", () => {
    expect(parseMarkdownFileLink("/repo/src/http.ts:42-64")).toEqual({
      path: "/repo/src/http.ts",
      line: 42,
      endLine: 64,
    });
    expect(parseMarkdownFileLink("/repo/src/http.ts#L42-L64")).toEqual({
      path: "/repo/src/http.ts",
      line: 42,
      endLine: 64,
    });
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
  it("resolves a relative folder with a trailing slash against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("patches/", "/repo/project")).toBe(
      "/repo/project/patches/",
    );
    expect(resolveMarkdownFileLinkTarget("patches", "/repo/project")).toBeNull();
  });

  // regression: #33625 backslash-separated relative links open the workspace file
  it.each([
    ["src/Example.cs", "C:\\repo\\src\\Example.cs"],
    ["src\\Example.cs", "C:\\repo\\src\\Example.cs"],
    ["src%5CExample.cs", "C:\\repo\\src\\Example.cs"],
    ["src\\Example.cs:3", "C:\\repo\\src\\Example.cs:3"],
  ])("resolves the relative link %s against a windows cwd", (href, target) => {
    expect(resolveMarkdownFileLinkTarget(href, "C:\\repo")).toBe(target);
  });

  it("keeps a backslash in a relative link that already names a file", () => {
    expect(resolveMarkdownFileLinkTarget("./foo%5Cbar.ts", "/repo")).toBe("/repo/./foo\\bar.ts");
  });

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

  it("links a network path only inside the project's share", () => {
    const cwd = "\\\\server\\share";
    expect(resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg", cwd)).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
    // Opening these sent the Windows user's NTLM credentials to attacker.test.
    for (const href of ["file://attacker.test/s/x.ts", "\\\\attacker.test\\s\\x.ts"]) {
      expect(resolveMarkdownFileLinkTarget(href, cwd)).toBeNull();
    }
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

describe("thread-evidenced file candidates", () => {
  const cwd = "/repos/app-a";
  const itemBase = (ordinal: number) => ({
    id: TurnItemId.make(`file-evidence-${ordinal}`),
    threadId: ThreadId.make("file-evidence-thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-19T00:00:00.000Z"),
  });

  it("suggests files from visible tool evidence without changing normal link resolution", () => {
    const items = [
      {
        ...itemBase(0),
        type: "file_change",
        fileName: "./.worktrees/feature-b/docs/guide.md",
        changes: [{ operation: "update", path: "../app-b/src/api/rules/categories.ts" }],
      },
      {
        ...itemBase(1),
        type: "dynamic_tool",
        toolName: "Read",
        input: { file_path: "../../notes/meeting/summary.md" },
        output: { path: "/not-evidence/tool-output.md" },
      },
      {
        ...itemBase(2),
        type: "dynamic_tool",
        toolName: "view_image",
        input: null,
        viewedImagePath: "../../tmp/images/shot.png",
      },
      {
        ...itemBase(3),
        type: "file_search",
        results: [
          { fileName: "../app-b/tests/rules.test.ts", preview: "/not-evidence/search.txt" },
        ],
      },
      {
        ...itemBase(4),
        type: "command_execution",
        input: "cd /notes/meeting-42 && ls raw",
        output: "/not-evidence/command-output.md",
      },
      {
        ...itemBase(5),
        type: "assistant_message",
        messageId: MessageId.make("file-evidence-reply"),
        text: "Open /not-evidence/prose.md",
        streaming: false,
      },
    ] satisfies OrchestrationV2TurnItem[];
    const paths = collectThreadFilePaths(items, cwd);
    expect([...paths].sort()).toEqual(
      [
        "/notes/meeting-42",
        "/notes/meeting-42/raw",
        "/notes/meeting/summary.md",
        "/repos/app-a/.worktrees/feature-b/docs/guide.md",
        "/repos/app-b/src/api/rules/categories.ts",
        "/repos/app-b/tests/rules.test.ts",
        "/tmp/images/shot.png",
      ].sort(),
    );

    const index = createThreadFilePathIndex(paths);
    for (const [href, candidate] of [
      ["rules/categories.ts:2", "/repos/app-b/src/api/rules/categories.ts:2"],
      ["docs/guide.md", "/repos/app-a/.worktrees/feature-b/docs/guide.md"],
      ["raw/recording.mp3", "/notes/meeting-42/raw/recording.mp3"],
    ] as const) {
      expect(resolveThreadFilePathCandidate(href, cwd, index), href).toBe(candidate);
    }
    expect(resolveMarkdownFileLinkTarget("rules/categories.ts:2", cwd)).toBe(
      "/repos/app-a/rules/categories.ts:2",
    );
    expect(resolveMarkdownFileLinkTarget("docs/guide.md", cwd, "/repos/app-a/preview")).toBe(
      "/repos/app-a/preview/docs/guide.md",
    );
    expect(resolveThreadFilePathCandidate("raw/recording.mp3", null, index)).toBe(
      "/notes/meeting-42/raw/recording.mp3",
    );
    expect(resolveMarkdownFileLinkTarget("raw/recording.mp3")).toBeNull();
  });

  it("requires one whole-segment match and declines ambiguous or speculative targets", () => {
    const cases = [
      {
        href: "./docs/guide.md:12:3",
        paths: ["/other/docs/guide.md", "/elsewhere/docs/notes.md"],
        expected: "/other/docs/guide.md:12:3",
      },
      {
        href: "docs/guide.md#L12C3",
        paths: ["C:\\Work\\Docs\\Guide.md", "c:/work/docs/guide.md"],
        expected: "C:\\Work\\Docs\\Guide.md:12:3",
      },
      { href: "guide.md", paths: ["/other/docs/guide.md"], expected: null },
      { href: "../docs/guide.md", paths: ["/other/docs/guide.md"], expected: null },
      { href: "~/docs/guide.md", paths: ["/other/docs/guide.md"], expected: null },
      { href: "docs/../guide.md", paths: ["/other/docs/../guide.md"], expected: null },
      { href: "/other/docs/guide.md", paths: ["/other/docs/guide.md"], expected: null },
      { href: "docs/guide.md", paths: ["/other/mydocs/guide.md"], expected: null },
      { href: "DOCS/guide.md", paths: ["/other/docs/guide.md"], expected: null },
      { href: "docs/guide.md", paths: ["/repos/app-a/docs/guide.md"], expected: null },
      {
        href: "docs/guide.md",
        paths: ["./docs/guide.md", "/other/docs/guide.md"],
        expected: null,
      },
      { href: "docs/guide.md", paths: ["/repos/app-a/packages/web/docs/notes.md"], expected: null },
      {
        href: "docs/guide.md",
        paths: ["./docs/notes.md", "/other/docs/notes.md"],
        expected: null,
      },
      {
        href: "docs/guide.md",
        paths: ["/other/docs/notes.md"],
        expected: "/other/docs/guide.md",
      },
      {
        href: "docs/guide.md",
        paths: ["/other/docs/notes.md", "/elsewhere/docs/notes.md"],
        expected: null,
      },
      {
        href: "docs/guide.md",
        paths: [
          "/repos/app-a/one/docs/guide.md",
          "/repos/app-a/two/docs/guide.md",
          "/other/docs/notes.md",
        ],
        expected: null,
      },
    ];
    for (const { href, paths, expected } of cases) {
      const evidence = collectThreadFilePaths(
        [
          {
            ...itemBase(0),
            type: "file_search",
            results: paths.map((fileName) => ({ fileName })),
          },
        ],
        cwd,
      );
      expect
        .soft(
          resolveThreadFilePathCandidate(href, cwd, createThreadFilePathIndex(evidence)),
          JSON.stringify({ href, paths }),
        )
        .toBe(expected);
    }
  });

  it("uses literal paths and cwd without inheriting or guessing shell state", () => {
    const items = [
      'cd "../app b" && cat "docs/my guide.md"',
      "cat src/local.ts",
      "cd ../meeting/raw && ls",
      'cat "/notes/meeting 42/transcript.md"',
      'type "C:\\Work\\Docs\\Guide.md"',
      'cd "\\\\server\\share" && cat docs\\guide.md',
      "/bin/bash -lc 'cd ../wrapped-app && cat src/wrapped.ts'",
      "/bin/bash -lc 'cat /repos/app-b/src/api/rules/categories.ts'",
      'git commit -m "fix: update /repos/app-b/src/api/rules/categories.ts"',
      "echo 'see /repos/app-b/src/api/rules/categories.ts'",
      "cd /other | cat pipe/file.ts",
      "cd /other & cat background/file.ts",
      "cd /other || cat failure/file.ts",
      "cd /other; cd; cat unknown/home.ts",
      "cd /other; popd; cat unknown/stack.ts",
      "cd $DEST && cat unknown/variable.ts",
    ].map(
      (input, ordinal) =>
        ({
          ...itemBase(ordinal),
          type: "command_execution" as const,
          input,
        }) satisfies OrchestrationV2TurnItem,
    );
    const paths = collectThreadFilePaths(items, cwd);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/repos/app b",
        "/repos/app b/docs/my guide.md",
        "/repos/app-a/src/local.ts",
        "/repos/meeting/raw",
        "/notes/meeting 42/transcript.md",
        "C:\\Work\\Docs\\Guide.md",
        "\\\\server\\share\\docs\\guide.md",
        "/repos/wrapped-app/src/wrapped.ts",
        "/repos/app-b/src/api/rules/categories.ts",
      ]),
    );
    expect(paths).not.toContain("/repos/app b/src/local.ts");
    expect(
      resolveThreadFilePathCandidate("rules/categories.ts", cwd, createThreadFilePathIndex(paths)),
    ).toBe("/repos/app-b/src/api/rules/categories.ts");
    expect(
      paths.filter(
        (path) =>
          path.startsWith("/other/pipe/") ||
          path.startsWith("/other/background/") ||
          path.startsWith("/other/failure/") ||
          path.includes("/unknown/"),
      ),
    ).toEqual([]);
    expect(
      resolveThreadFilePathCandidate("raw/recording.mp3", cwd, createThreadFilePathIndex(paths)),
    ).toBe("/repos/meeting/raw/recording.mp3");

    const item = Object.freeze({
      ...itemBase(items.length),
      type: "dynamic_tool",
      toolName: "Read",
      input: { path: "docs/../docs/local.md" },
      viewedImagePath: "/tmp/[shot] #1?.png",
    } satisfies OrchestrationV2TurnItem);
    for (const [root, relativePaths] of [
      [cwd, ["/repos/app-a/docs/local.md"]],
      ["/other/app", ["/other/app/docs/local.md"]],
      [null, []],
      ["relative/root", []],
      [cwd, ["/repos/app-a/docs/local.md"]],
    ] as const) {
      expect
        .soft(collectThreadFilePaths([item], root), String(root))
        .toEqual(["/tmp/[shot] #1?.png", ...relativePaths]);
    }
  });
});
