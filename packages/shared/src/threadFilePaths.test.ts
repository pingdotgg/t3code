import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownFileLinkTarget } from "./markdownLinks.ts";
import {
  buildThreadFilePathIndex,
  matchThreadFilePath,
  threadFilePaths,
} from "./threadFilePaths.ts";

function item(fields: Record<string, unknown>): OrchestrationV2TurnItem {
  return fields as unknown as OrchestrationV2TurnItem;
}

const index = (...paths: string[]) => buildThreadFilePathIndex(paths);

describe("threadFilePaths", () => {
  it("collects absolute paths from file, tool, search and command items", () => {
    expect(
      threadFilePaths([
        item({
          type: "file_change",
          fileName: "/repos/app-b/src/api/rules/categories.ts",
          changes: [{ operation: "update", path: "/repos/app-b/src/api/rules/index.ts" }],
        }),
        item({ type: "dynamic_tool", input: { file_path: "/notes/meeting/summary.md" } }),
        item({ type: "dynamic_tool", viewedImagePath: "/tmp/shot.png", input: null }),
        item({ type: "file_search", results: [{ fileName: "/repos/app-b/docs/guide.md" }] }),
        item({
          type: "command_execution",
          input: `ffmpeg -i "/notes/meeting/raw/remote.mp3" out.wav && cat '/etc/hosts'`,
        }),
        item({ type: "assistant_message", text: "/not/a/tool/path.ts" }),
      ]),
    ).toEqual([
      "/repos/app-b/src/api/rules/categories.ts",
      "/repos/app-b/src/api/rules/index.ts",
      "/notes/meeting/summary.md",
      "/tmp/shot.png",
      "/repos/app-b/docs/guide.md",
      "/notes/meeting/raw/remote.mp3",
      "/etc/hosts",
    ]);
  });

  it("skips relative paths and repeats", () => {
    expect(
      threadFilePaths([
        item({ type: "file_change", fileName: "src/app.ts" }),
        item({ type: "file_change", fileName: "/repo/src/app.ts" }),
        item({ type: "dynamic_tool", input: { path: "/repo/src/app.ts" } }),
        item({ type: "command_execution", input: "sed -n 1,20p src/app.ts" }),
      ]),
    ).toEqual(["/repo/src/app.ts"]);
  });

  it("reads relative operands against a cd to an absolute folder in the same command", () => {
    expect(
      threadFilePaths([
        item({
          type: "command_execution",
          input:
            "cd /records/meeting-42; cat README.md; cat manifest.json | head -80; ls raw slides; ls ../meeting-41",
        }),
        item({
          type: "command_execution",
          input: "cd /records && wc -l meeting-42/notes.md && cd meeting-42/raw && ls",
        }),
      ]),
    ).toEqual([
      "/records/meeting-42",
      "/records/meeting-42/README.md",
      "/records/meeting-42/manifest.json",
      "/records/meeting-42/raw",
      "/records/meeting-42/slides",
      "/records/meeting-41",
      "/records",
      "/records/meeting-42/notes.md",
    ]);
  });

  it("starts each command in the workspace root", () => {
    expect(
      threadFilePaths(
        [
          item({
            type: "command_execution",
            input: "cd ../app-b && cat src/api/rules/categories.ts",
          }),
        ],
        "/repos/app-a",
      ),
    ).toEqual(["/repos/app-b", "/repos/app-b/src/api/rules/categories.ts"]);
  });

  it("records the folder a relative cd moves into", () => {
    expect(
      threadFilePaths(
        [item({ type: "command_execution", input: "cd ../meeting/raw && ls" })],
        "/repos/app",
      ),
    ).toEqual(["/repos/meeting/raw"]);
  });

  it("ignores a cd that does not govern the next command", () => {
    expect(
      threadFilePaths(
        [
          item({ type: "command_execution", input: "cd /other | cat src/app.ts" }),
          item({ type: "command_execution", input: "cd /other || cat src/b.ts" }),
          item({ type: "command_execution", input: "cd /other; cd; cat c.md; popd; cat d.md" }),
          item({ type: "command_execution", input: "cd - && cat e.md" }),
        ],
        "/repo",
      ),
    ).toEqual(["/other", "/repo/src/app.ts", "/repo/src/b.ts"]);
  });

  it("keeps quoted paths with spaces and paths after an option or redirect", () => {
    expect(
      threadFilePaths([
        item({
          type: "command_execution",
          input: 'cat "/notes/meeting 42/raw/recording.mp3" > /tmp/out.txt --log=/var/log/x.log',
        }),
      ]),
    ).toContain("/notes/meeting 42/raw/recording.mp3");
  });

  it("reads quoted relative operands with spaces against the folder", () => {
    expect(
      threadFilePaths([
        item({ type: "command_execution", input: 'cd /other && cat "docs/my guide.md"' }),
      ]),
    ).toEqual(["/other", "/other/docs/my guide.md"]);
  });

  it("ignores relative operands without a known folder", () => {
    expect(
      threadFilePaths([
        item({ type: "command_execution", input: "ls raw && cd - && cat notes.md" }),
        item({ type: "command_execution", input: "cd $HOME/notes && cat a.md" }),
        item({ type: "command_execution", input: 'cd /tmp; grep -n "x.*y" -- "*.md" $FILE' }),
      ]),
    ).toEqual(["/tmp"]);
  });

  it("reads Windows drive paths from commands", () => {
    expect(
      threadFilePaths([item({ type: "command_execution", input: 'type "C:\\work\\a\\b.txt"' })]),
    ).toEqual(["C:\\work\\a\\b.txt"]);
  });
});

describe("matchThreadFilePath", () => {
  it("binds a reference to the one thread path that ends with it", () => {
    expect(
      matchThreadFilePath(
        "rules/categories.ts",
        "/repos/app-a/rules/categories.ts",
        "/repos/app-a",
        index("/repos/app-b/src/api/rules/categories.ts", "/repos/app-b/src/api/rules/index.ts"),
      ),
    ).toBe("/repos/app-b/src/api/rules/categories.ts");
  });

  it("matches whole segments only", () => {
    expect(
      matchThreadFilePath("rules/categories.ts", null, null, index("/repo/myrules/categories.ts")),
    ).toBeNull();
  });

  it("keeps the root join when the thread touched it", () => {
    expect(
      matchThreadFilePath(
        "docs/guide.md",
        "/repo/docs/guide.md",
        "/repo",
        index("/repo/docs/guide.md", "/repo/.worktrees/b/docs/guide.md"),
      ),
    ).toBeNull();
  });

  it("resolves nothing when several thread paths match", () => {
    expect(
      matchThreadFilePath(
        "src/index.ts",
        "/work/src/index.ts",
        "/work",
        index("/work/repo-a/src/index.ts", "/work/repo-b/src/index.ts"),
      ),
    ).toBeNull();
  });

  it.each(["index.ts", "../other/index.ts", "~/notes/index.ts"])(
    "leaves %s to the existing lookups",
    (reference) => {
      expect(matchThreadFilePath(reference, null, null, index("/other/notes/index.ts"))).toBeNull();
    },
  );

  it("places a reference inside a folder the thread looked at outside the workspace", () => {
    const listed = buildThreadFilePathIndex(
      threadFilePaths([
        item({ type: "command_execution", input: "cd /records/meeting-42; ls raw slides" }),
      ]),
    );
    expect(matchThreadFilePath("raw/remote.mp3", "/repo/raw/remote.mp3", "/repo", listed)).toBe(
      "/records/meeting-42/raw/remote.mp3",
    );
  });

  it("places a reference inside a folder a relative cd moved into", () => {
    const moved = buildThreadFilePathIndex(
      threadFilePaths(
        [item({ type: "command_execution", input: "cd ../meeting/raw && ls" })],
        "/repos/app",
      ),
    );
    expect(
      matchThreadFilePath("raw/remote.mp3", "/repos/app/raw/remote.mp3", "/repos/app", moved),
    ).toBe("/repos/meeting/raw/remote.mp3");
  });

  it("does not place a reference inside a folder within the workspace", () => {
    expect(
      matchThreadFilePath(
        "src/index.ts",
        "/repo/src/index.ts",
        "/repo",
        index("/repo/apps/web/src/main.ts"),
      ),
    ).toBeNull();
  });

  it("keeps the root join when the thread also looked at the root's folder", () => {
    expect(
      matchThreadFilePath(
        "raw/remote.mp3",
        "/repo/raw/remote.mp3",
        "/repo",
        index("/repo/raw/glossary.txt", "/records/meeting-42/raw/glossary.txt"),
      ),
    ).toBeNull();
  });

  it("resolves nothing when several outside folders match", () => {
    expect(
      matchThreadFilePath(
        "raw/remote.mp3",
        null,
        "/repo",
        index("/records/meeting-41/raw/a.txt", "/records/meeting-42/raw/b.txt"),
      ),
    ).toBeNull();
  });

  it("prefers a named file to a folder guess, even when the name is ambiguous", () => {
    expect(
      matchThreadFilePath(
        "raw/remote.mp3",
        null,
        "/repo",
        index("/a/raw/remote.mp3", "/b/raw/remote.mp3", "/c/raw/other.txt"),
      ),
    ).toBeNull();
  });

  it("accepts a leading ./ and folds case only for Windows paths", () => {
    expect(
      matchThreadFilePath("./raw/remote.mp3", null, null, index("/notes/m/raw/remote.mp3")),
    ).toBe("/notes/m/raw/remote.mp3");
    expect(
      matchThreadFilePath("RAW/remote.mp3", null, null, index("/notes/m/raw/remote.mp3")),
    ).toBe(null);
    expect(matchThreadFilePath("Docs/a.md", null, null, index("C:\\work\\docs\\a.md"))).toBe(
      "C:\\work\\docs\\a.md",
    );
  });
});

describe("resolveMarkdownFileLinkTarget with thread paths", () => {
  it("binds a relative link to the file the thread touched and keeps its position", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "references/notes.md:12",
        "/scratch/thread-1",
        "/scratch/thread-1",
        index("/home/me/repo-x/skills/tool-a/references/notes.md"),
      ),
    ).toBe("/home/me/repo-x/skills/tool-a/references/notes.md:12");
  });

  it("joins onto the workspace root when no thread path matches", () => {
    expect(
      resolveMarkdownFileLinkTarget("src/app.ts", "/repo", "/repo", index("/elsewhere/app.ts")),
    ).toBe("/repo/src/app.ts");
  });

  it("resolves a thread path without a workspace root", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "raw/remote.mp3",
        undefined,
        undefined,
        index("/notes/m/raw/remote.mp3"),
      ),
    ).toBe("/notes/m/raw/remote.mp3");
  });

  it("keeps a markdown file's links relative to the file", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "docs/guide.md",
        "/repo",
        "/repo/packages/a",
        index("/elsewhere/docs/guide.md"),
      ),
    ).toBe("/repo/packages/a/docs/guide.md");
  });

  it("leaves absolute links alone", () => {
    expect(
      resolveMarkdownFileLinkTarget("/repo/a/b.ts", "/repo", "/repo", index("/other/a/b.ts")),
    ).toBe("/repo/a/b.ts");
  });
});
