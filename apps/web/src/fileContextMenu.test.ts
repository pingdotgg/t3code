import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveFileContextMenuAbsolutePath,
  resolveFileModifierClickAction,
} from "./fileContextMenu";

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

describe("resolveFileContextMenuAbsolutePath", () => {
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

describe("resolveFileModifierClickAction", () => {
  const click = (
    keys: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>,
  ) => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...keys,
  });
  const link = { modClickSelects: false };
  const tree = { modClickSelects: true };

  it("opens the editor on Mod-click and reveals on Mod+Alt-click", () => {
    expect(resolveFileModifierClickAction(click({ metaKey: true }), link, "MacIntel")).toBe(
      "open-in-editor",
    );
    expect(
      resolveFileModifierClickAction(click({ metaKey: true, altKey: true }), link, "MacIntel"),
    ).toBe("reveal");
    expect(resolveFileModifierClickAction(click({ ctrlKey: true }), link, "Win32")).toBe(
      "open-in-editor",
    );
    expect(resolveFileModifierClickAction(click({ ctrlKey: true }), link, "MacIntel")).toBeNull();
  });

  it("leaves Mod-click to multi-select in trees and opens the editor on Mod+Shift-click", () => {
    expect(resolveFileModifierClickAction(click({ metaKey: true }), tree, "MacIntel")).toBeNull();
    expect(
      resolveFileModifierClickAction(click({ metaKey: true, shiftKey: true }), tree, "MacIntel"),
    ).toBe("open-in-editor");
  });
});
