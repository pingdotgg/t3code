import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const run = vi.hoisted(() => vi.fn());
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => ({ availableEditors: ["idea", "ghostty", "file-manager"] }),
}));
vi.mock("./state/server", () => ({
  serverEnvironment: { configValueAtom: () => undefined },
}));
vi.mock("./state/shell", () => ({ shellEnvironment: { openInEditor: undefined } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => run }));

import { resolveFileContextMenuAbsolutePath, useFileContextMenu } from "./fileContextMenu";

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

it("excludes project-only apps from file actions", async () => {
  run.mockReset();
  const menu = useFileContextMenu(BASE_TARGET.environmentId);
  expect(menu.buildItems(BASE_TARGET).find((item) => item.id === "open-with")?.children).toEqual([
    { id: "editor:idea", label: "IntelliJ IDEA" },
  ]);
  await menu.activate("editor:ghostty", BASE_TARGET);
  expect(run).not.toHaveBeenCalled();
});
