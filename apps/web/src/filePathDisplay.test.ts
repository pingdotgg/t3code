import { describe, expect, it } from "vite-plus/test";
import { formatWorkspaceAbsolutePath, resolveChangedFilePaths } from "./filePathDisplay";

describe("changed-file path aliases", () => {
  it("formats paths that include the workspace label as absolute workspace paths", () => {
    expect(
      formatWorkspaceAbsolutePath(
        "t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501");
  });

  it("collapses absolute and workspace-relative aliases for changed files", () => {
    expect(
      resolveChangedFilePaths(
        ["/home/me/projects/jobagent/individuell/target.php", "jobagent/individuell/target.php"],
        "/home/me/projects/jobagent",
      ),
    ).toEqual([
      {
        displayPath: "jobagent/individuell/target.php",
        fullPath: "/home/me/projects/jobagent/individuell/target.php",
      },
    ]);
  });

  it("keeps distinct changed files while resolving their full paths", () => {
    expect(
      resolveChangedFilePaths(
        ["apps/web/src/index.ts", "apps/web/src/main.ts"],
        "/home/me/projects/t3code",
      ),
    ).toEqual([
      {
        displayPath: "t3code/apps/web/src/index.ts",
        fullPath: "/home/me/projects/t3code/apps/web/src/index.ts",
      },
      {
        displayPath: "t3code/apps/web/src/main.ts",
        fullPath: "/home/me/projects/t3code/apps/web/src/main.ts",
      },
    ]);
  });

  it("keeps differently cased POSIX paths distinct", () => {
    expect(
      resolveChangedFilePaths(
        ["/home/me/project/File.ts", "/home/me/project/file.ts"],
        "/home/me/project",
      ),
    ).toHaveLength(2);
  });

  it("collapses differently cased Windows path aliases", () => {
    expect(
      resolveChangedFilePaths(
        ["c:/users/mike/project/src/File.ts", "project/src/file.ts"],
        "C:/Users/Mike/Project",
      ),
    ).toEqual([
      {
        displayPath: "Project/src/File.ts",
        fullPath: "c:/users/mike/project/src/File.ts",
      },
    ]);
  });
});
