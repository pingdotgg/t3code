import { EnvironmentId } from "@t3tools/contracts";
import * as NodeAssert from "node:assert/strict";
import { describe, expect, it } from "vite-plus/test";

import { buildFileContextMenuItems, resolveFileContextMenuAbsolutePath } from "./fileContextMenu";

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

describe("resolveFileContextMenuAbsolutePath", () => {
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

  it("passes absolute environment-host paths through unchanged", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        filePath: "/absolute/src/index.ts",
      }),
    ).toBe("/absolute/src/index.ts");
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "C:\\temp\\report.pdf",
      }),
    ).toBe("C:\\temp\\report.pdf");
  });

  it("returns null for relative paths without a workspace root, matching diff path resolution", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "src/index.ts",
      }),
    ).toBeNull();
  });

  it("does not treat drive-relative Windows paths as absolute", () => {
    // C:notes.md is relative to the current directory on C:, so it cannot
    // pass through as an environment-host path or resolve to a workspace file.
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "C:notes.md",
      }),
    ).toBeNull();
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        filePath: "C:src\\index.ts",
      }),
    ).toBeNull();
  });

  it("passes UNC environment-host paths through unchanged", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        filePath: "\\\\server\\share\\report.pdf",
      }),
    ).toBe("\\\\server\\share\\report.pdf");
  });
});

describe("buildFileContextMenuItems", () => {
  it("offers open, reveal, and an open-with submenu when all are available", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      capabilities: {
        revealLabel: "Reveal in Finder",
        canOpenDefault: true,
        editorIds: ["vscode", "cursor", "file-manager"],
      },
    });

    expect(items.map((item) => item.id)).toEqual(["open", "reveal-in-folder", "open-with"]);
    expect(items[0]).toMatchObject({ label: "Open" });
    expect(items[1]).toMatchObject({ label: "Reveal in Finder" });
    const openWith = items[2];
    NodeAssert.ok(openWith);
    expect(openWith.children?.map((child) => child.id)).toEqual(["editor:vscode", "editor:cursor"]);
  });

  it("offers only the reveal item when just reveal is enabled", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      capabilities: {
        revealLabel: "Reveal in File Explorer",
        canOpenDefault: false,
        editorIds: [],
      },
    });

    expect(items.map((item) => item.id)).toEqual(["reveal-in-folder"]);
    expect(items[0]).toMatchObject({ label: "Reveal in File Explorer" });
  });

  it("folds the default-app open into Open with when the caller has its own open row", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasPrimaryOpenItem: true,
      capabilities: {
        revealLabel: "Reveal in Finder",
        canOpenDefault: true,
        editorIds: ["vscode", "cursor", "file-manager"],
      },
    });

    expect(items.map((item) => item.id)).toEqual(["reveal-in-folder", "open-with"]);
    const openWith = items[1];
    NodeAssert.ok(openWith);
    expect(openWith.children?.map((child) => child.id)).toEqual([
      "open",
      "editor:vscode",
      "editor:cursor",
    ]);
    expect(openWith.children?.[0]).toMatchObject({ label: "Default Application" });
  });

  it("keeps the top-level open when no submenu exists to fold it into", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasPrimaryOpenItem: true,
      capabilities: {
        revealLabel: "Reveal in Finder",
        canOpenDefault: true,
        editorIds: ["file-manager"],
      },
    });

    expect(items.map((item) => item.id)).toEqual(["open", "reveal-in-folder"]);
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
