import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveFileContextMenuAbsolutePath, useFileContextMenu } from "./fileContextMenu";
import type { RemoteOpenResolution } from "./remoteOpen";

const state = vi.hoisted(() => ({
  remoteOpen: { state: { mode: "local-exec" }, isResolved: true } as RemoteOpenResolution,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    availableEditors: ["vscode", "file-manager"],
    shellRevealInFileManager: true,
    shellRevealInFileManagerKind: "xdg-open",
    environment: { platform: { os: "linux" } },
  }),
}));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => async () => ({}) }));
vi.mock(import("./remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => state.remoteOpen,
  useRemoteOpenState: () => state.remoteOpen.state,
}));

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

describe("useFileContextMenu", () => {
  it.each<[string, RemoteOpenResolution]>([
    [
      "remote-links",
      {
        state: { mode: "remote-links", host: { kind: "ssh-alias", host: "box" } },
        isResolved: true,
      },
    ],
    ["remote-unavailable", { state: { mode: "remote-unavailable" }, isResolved: true }],
    ["unresolved", { state: { mode: "local-exec" }, isResolved: false }],
  ])("offers no host shell actions when remote open is %s", (_mode, resolution) => {
    state.remoteOpen = resolution;
    const menu = useFileContextMenu(BASE_TARGET.environmentId);

    expect(menu.buildItems(BASE_TARGET)).toEqual([]);
  });
});
