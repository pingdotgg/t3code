import { EnvironmentId } from "@t3tools/contracts";
import * as NodeAssert from "node:assert/strict";
import { describe, expect, it } from "vite-plus/test";

import { buildFileContextMenuItems, resolveFileContextMenuAbsolutePath } from "./fileContextMenu";

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

const EMPTY_CAPABILITIES = {
  revealLabel: undefined,
  canOpenDefault: false,
  editorIds: [],
};

describe("resolveFileContextMenuAbsolutePath", () => {
  it("resolves the workspace-root directory row of a repo-relative diff tree", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "packages/app",
      }),
    ).toBe("/workspace/project/packages/app");
  });

  it("joins workspace-relative diff paths onto the workspace root", () => {
    expect(resolveFileContextMenuAbsolutePath(BASE_TARGET)).toBe("/workspace/project/src/index.ts");
  });

  it("strips the repository prefix when the repo root is nested in the workspace", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "packages/app/src/index.ts",
      }),
    ).toBe("/workspace/project/packages/app/src/index.ts");
  });

  it("returns null for paths outside the workspace when a repository root is set", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "other/src/index.ts",
      }),
    ).toBeNull();
  });

  it("rejects absolute paths without a workspace root, matching diff path resolution", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "/absolute/src/index.ts",
      }),
    ).toBeNull();
  });
});

describe("buildFileContextMenuItems", () => {
  it("allows copying without any host editor or reveal capabilities", () => {
    expect(
      buildFileContextMenuItems({
        hasAbsolutePath: true,
        capabilities: EMPTY_CAPABILITIES,
      }),
    ).toEqual([{ id: "copy-full-path", label: "Copy full path" }]);
  });

  it("offers open, reveal, and an open-with submenu when all are available", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      capabilities: {
        revealLabel: "Reveal in Finder",
        canOpenDefault: true,
        editorIds: ["vscode", "cursor", "file-manager"],
      },
    });

    expect(items.map((item) => item.id)).toEqual([
      "open",
      "reveal-in-folder",
      "open-with",
      "copy-full-path",
    ]);
    expect(items[0]).toMatchObject({ label: "Open" });
    expect(items[1]).toMatchObject({ label: "Reveal in Finder" });
    const openWith = items[2];
    NodeAssert.ok(openWith);
    expect(openWith.children?.map((child) => child.id)).toEqual(["editor:vscode", "editor:cursor"]);
  });

  it("offers reveal and copying when just reveal is enabled", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      capabilities: {
        revealLabel: "Reveal in File Explorer",
        canOpenDefault: false,
        editorIds: [],
      },
    });

    expect(items.map((item) => item.id)).toEqual(["reveal-in-folder", "copy-full-path"]);
    expect(items[0]).toMatchObject({ label: "Reveal in File Explorer" });
  });

  it("offers nothing when the path cannot be resolved", () => {
    expect(
      buildFileContextMenuItems({
        hasAbsolutePath: false,
        capabilities: {
          revealLabel: "Reveal in Finder",
          canOpenDefault: true,
          editorIds: ["vscode"],
        },
      }),
    ).toEqual([]);
  });
});
