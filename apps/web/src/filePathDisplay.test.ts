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

  it("keeps authored dot segments absolute instead of guessing across symlinks", () => {
    const formatted = formatCompactFilePath(
      "/root/project/src/../../notes/todo.md:12:3",
      "/root/project",
    );

    expect(formatted).toBe("/root/project/src/../../notes/todo.md:12:3");
    expect(formatted).not.toMatch(/^\.\.\//);
  });

  it.each([
    ["/srv/Project/src/main.ts", "/srv/project", "/srv/Project/src/main.ts"],
    ["C:/Users/MIKE/Project/src/main.ts", "c:/users/mike/project", "./src/main.ts"],
    ["//server/share/Project/src/main.ts", "//server/share/Project", "./src/main.ts"],
    [
      "//server/share/project/src/main.ts",
      "//server/share/Project",
      "//server/share/project/src/main.ts",
    ],
    [
      String.raw`\\wsl.localhost\Ubuntu\home\alice\Project\src\main.ts:12:3`,
      String.raw`\\wsl.localhost\Ubuntu\home\alice\Project`,
      "./src/main.ts:12:3",
    ],
    [
      "//wsl.localhost/Ubuntu/home/alice/project/src/main.ts:12:3",
      "//wsl.localhost/Ubuntu/home/alice/Project",
      "~/project/src/main.ts:12:3",
    ],
  ])("uses safe case rules for %s from %s", (path, workspaceRoot, expected) => {
    expect(formatCompactFilePath(path, workspaceRoot)).toBe(expected);
  });

  it.each([
    [
      String.raw`\\wsl.localhost\Ubuntu\home\alice\notes\todo.md:12:3`,
      String.raw`\\wsl.localhost\Ubuntu\home\alice\project`,
      "~/notes/todo.md:12:3",
    ],
    ["//wsl$/Ubuntu/root/notes/todo.md", "//wsl$/Ubuntu/root/project", "~/notes/todo.md"],
    [
      "//wsl.localhost/Ubuntu/home/Alice/notes/todo.md",
      "//wsl.localhost/Ubuntu/home/alice/project",
      "//wsl.localhost/Ubuntu/home/Alice/notes/todo.md",
    ],
    [
      "//server/share/home/alice/notes/todo.md",
      "//server/share/home/alice/project",
      "//server/share/home/alice/notes/todo.md",
    ],
  ])("infers WSL home paths safely for %s", (path, workspaceRoot, expected) => {
    expect(formatCompactFilePath(path, workspaceRoot)).toBe(expected);
  });

  it.each([
    ["/src/main.ts", "/", "./src/main.ts"],
    ["C:/src/main.ts", "C:/", "./src/main.ts"],
    ["//server/share/src/main.ts", "//server/share/", "./src/main.ts"],
    ["//server/share", "//server/share/", "./"],
  ])("handles path roots and trailing separators for %s", (path, workspaceRoot, expected) => {
    expect(formatCompactFilePath(path, workspaceRoot)).toBe(expected);
  });

  it("does not shorten against a workspace root containing dot segments", () => {
    expect(formatCompactFilePath("/srv/project/src/main.ts", "/srv/link/../project")).toBe(
      "/srv/project/src/main.ts",
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
