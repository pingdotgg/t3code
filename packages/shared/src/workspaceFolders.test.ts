import { describe, expect, it } from "vite-plus/test";

import {
  agentPathForWorkspaceFolder,
  deriveFolderLabels,
  formatWorkspaceFolderPath,
  isFolderContainedBy,
  PRIMARY_WORKSPACE_FOLDER_ID,
  relativizeAgainstFolders,
  resolveWorkspaceFolders,
} from "./workspaceFolders.ts";

describe("isFolderContainedBy", () => {
  it("matches a folder against itself and its descendants", () => {
    expect(isFolderContainedBy("/repo/app", "/repo/app")).toBe(true);
    expect(isFolderContainedBy("/repo/app/src/index.ts", "/repo/app")).toBe(true);
    expect(isFolderContainedBy("/repo/app", "/repo/app/src")).toBe(false);
  });

  it("does not treat a sibling with a shared prefix as contained", () => {
    expect(isFolderContainedBy("/repo/app-legacy", "/repo/app")).toBe(false);
  });

  it("ignores trailing and mixed separators", () => {
    expect(isFolderContainedBy("/repo/app/src", "/repo/app/")).toBe(true);
    expect(isFolderContainedBy("C:\\repo\\app\\src", "C:/repo/app")).toBe(true);
  });
});

describe("deriveFolderLabels", () => {
  it("uses the bare basename when it is unambiguous", () => {
    expect(deriveFolderLabels(["/repo/app", "/repo/docs"])).toEqual(["app", "docs"]);
  });

  it("extends leftward only for the folders that actually collide", () => {
    expect(deriveFolderLabels(["/dev/api", "/prod/api", "/repo/web"])).toEqual([
      "dev/api",
      "prod/api",
      "web",
    ]);
  });

  it("keeps extending until the labels are unique", () => {
    expect(deriveFolderLabels(["/a/x/src", "/b/x/src"])).toEqual(["a/x/src", "b/x/src"]);
  });
});

describe("resolveWorkspaceFolders", () => {
  it("puts the primary first with a fixed id", () => {
    const folders = resolveWorkspaceFolders({
      primaryRoot: "/repo/app",
      additionalFolders: [{ path: "/repo/docs" }],
    });

    expect(
      folders.map((folder) => [folder.id, folder.cwd, folder.label, folder.isPrimary]),
    ).toEqual([
      [PRIMARY_WORKSPACE_FOLDER_ID, "/repo/app", "app", true],
      ["/repo/docs", "/repo/docs", "docs", false],
    ]);
  });

  it("points only the primary at the worktree", () => {
    // Additional folders are separate trees; a worktree must not shadow them.
    const folders = resolveWorkspaceFolders({
      primaryRoot: "/repo/app",
      worktreePath: "/worktrees/feature",
      additionalFolders: [{ path: "/repo/docs" }],
    });

    expect(folders[0]?.cwd).toBe("/worktrees/feature");
    expect(folders[1]?.cwd).toBe("/repo/docs");
  });

  it("drops folders that duplicate or nest inside another", () => {
    const folders = resolveWorkspaceFolders({
      primaryRoot: "/repo/app",
      additionalFolders: [
        { path: "/repo/app/packages/ui" },
        { path: "/repo/app/" },
        { path: "/repo/docs" },
      ],
    });

    expect(folders.map((folder) => folder.cwd)).toEqual(["/repo/app", "/repo/docs"]);
  });

  it("prefers an explicit label over the derived one", () => {
    const folders = resolveWorkspaceFolders({
      primaryRoot: "/repo/app",
      additionalFolders: [{ path: "/repo/docs", label: "Handbook" }],
    });

    expect(folders[1]?.label).toBe("Handbook");
  });
});

describe("relativizeAgainstFolders", () => {
  const folders = resolveWorkspaceFolders({
    primaryRoot: "/repo/app",
    additionalFolders: [{ path: "/repo/docs" }],
  });

  it("attributes a path to its containing folder", () => {
    expect(relativizeAgainstFolders(folders, "/repo/docs/guide/intro.md")).toMatchObject({
      relativePath: "guide/intro.md",
    });
  });

  it("returns null for a path outside every folder", () => {
    expect(relativizeAgainstFolders(folders, "/elsewhere/file.ts")).toBeNull();
  });

  it("credits the deepest matching folder", () => {
    const nested = [
      { id: "primary", cwd: "/repo", label: "repo", isPrimary: true },
      { id: "/repo/app", cwd: "/repo/app", label: "app", isPrimary: false },
    ];
    expect(relativizeAgainstFolders(nested, "/repo/app/src/index.ts")?.folder.cwd).toBe(
      "/repo/app",
    );
  });
});

describe("formatWorkspaceFolderPath", () => {
  it("omits the folder prefix for a single-folder project", () => {
    // Single-folder projects must render exactly as they did before this feature.
    const folders = resolveWorkspaceFolders({ primaryRoot: "/repo/app", additionalFolders: [] });
    expect(formatWorkspaceFolderPath(folders, "/repo/app/src/index.ts")).toBe("src/index.ts");
  });

  it("qualifies with the folder label once there is more than one folder", () => {
    const folders = resolveWorkspaceFolders({
      primaryRoot: "/repo/app",
      additionalFolders: [{ path: "/repo/docs" }],
    });
    expect(formatWorkspaceFolderPath(folders, "/repo/app/src/index.ts")).toBe("app/src/index.ts");
    expect(formatWorkspaceFolderPath(folders, "/repo/docs/intro.md")).toBe("docs/intro.md");
  });

  it("leaves an unrelated path absolute", () => {
    const folders = resolveWorkspaceFolders({ primaryRoot: "/repo/app", additionalFolders: [] });
    expect(formatWorkspaceFolderPath(folders, "/elsewhere/x.ts")).toBe("/elsewhere/x.ts");
  });
});

describe("agentPathForWorkspaceFolder", () => {
  it("keeps primary references relative", () => {
    expect(
      agentPathForWorkspaceFolder({
        folder: { cwd: "/repo/app", isPrimary: true },
        relativePath: "src/index.ts",
      }),
    ).toBe("src/index.ts");
  });

  it("makes non-primary references absolute", () => {
    // The agent's cwd is the primary folder, so a bare relative path from
    // another folder would resolve to the wrong file inside the primary.
    expect(
      agentPathForWorkspaceFolder({
        folder: { cwd: "/repo/docs", isPrimary: false },
        relativePath: "guide/intro.md",
      }),
    ).toBe("/repo/docs/guide/intro.md");
  });

  it("uses backslashes for Windows folders", () => {
    expect(
      agentPathForWorkspaceFolder({
        folder: { cwd: "C:\\repo\\docs", isPrimary: false },
        relativePath: "guide/intro.md",
      }),
    ).toBe("C:\\repo\\docs\\guide\\intro.md");
  });
});
