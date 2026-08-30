import { describe, expect, it } from "vite-plus/test";

import {
  formatCompactFilePath,
  formatFileChipLabel,
  formatWorkspaceRelativePath,
} from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("formats absolute workspace paths from the workspace root", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("prefixes relative paths with the workspace root label", () => {
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("keeps paths already rooted at the workspace label stable", () => {
    expect(
      formatWorkspaceRelativePath(
        "t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("preserves columns when present", () => {
    expect(
      formatWorkspaceRelativePath(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501:9",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501:9");
  });
});

describe("formatCompactFilePath", () => {
  it.each([
    ["/root/project/src/main.ts", "/root/project", "./src/main.ts"],
    ["/root/project", "/root/project", "./"],
    ["/root/notes/todo.md", "/root/project", "~/notes/todo.md"],
    ["/root", "/root/project", "~/"],
    ["/opt/tools/run.ts", "/root/project", "/opt/tools/run.ts"],
    ["/home/alice/notes/todo.md", "/home/alice/project", "~/notes/todo.md"],
    ["C:/Users/mike/project/src/main.ts", "C:/Users/mike/project", "./src/main.ts"],
    ["C:/Users/mike/notes/todo.md", "C:/Users/mike/project", "~/notes/todo.md"],
    ["D:/tools/run.ts", "C:/Users/mike/project", "D:/tools/run.ts"],
  ])("formats %s from %s as %s", (path, workspaceRoot, expected) => {
    expect(formatCompactFilePath(path, workspaceRoot)).toBe(expected);
  });

  it("normalizes parent segments before choosing the shortest safe prefix", () => {
    const formatted = formatCompactFilePath(
      "/root/project/src/../../notes/todo.md:12:3",
      "/root/project",
    );

    expect(formatted).toBe("~/notes/todo.md:12:3");
    expect(formatted).not.toContain("../");
  });

  it("preserves UNC paths outside the workspace", () => {
    expect(formatCompactFilePath("//server/share/docs/readme.md", "C:/Users/mike/project")).toBe(
      "//server/share/docs/readme.md",
    );
  });
});

describe("formatFileChipLabel", () => {
  const input = {
    basename: "index.ts",
    parentSuffix: "project/src",
    targetPath: "/root/project/src/index.ts:12:3",
    workspaceRoot: "/root/project",
    line: 12,
    column: 3,
  };

  it("keeps the current short label when compact paths are disabled", () => {
    expect(formatFileChipLabel({ ...input, showFileLinkPaths: false })).toBe(
      "index.ts · project/src · L12:C3",
    );
  });

  it("uses one real compact path when compact paths are enabled", () => {
    expect(formatFileChipLabel({ ...input, showFileLinkPaths: true })).toBe("./src/index.ts:12:3");
  });
});
