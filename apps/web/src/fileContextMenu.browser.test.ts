import { m } from "./i18n/messages";
import { EnvironmentId } from "@t3tools/contracts";
import { createElement, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { render, stubGlobal } from "../test/render";

import {
  buildFileContextMenuItems,
  resolveFileContextMenuAbsolutePath,
  useFileContextMenu,
  type FileContextMenuTarget,
} from "./fileContextMenu";

const boundaries = vi.hoisted(() => ({ openInEditor: vi.fn(), toast: vi.fn() }));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => undefined,
}));
vi.mock("./state/use-atom-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/use-atom-command")>()),
  useAtomCommand: () => boundaries.openInEditor,
}));
vi.mock("./components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./components/ui/toast")>()),
  toastManager: { add: boundaries.toast },
}));

const BASE_TARGET: FileContextMenuTarget = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};
const EMPTY_CAPABILITIES = { revealLabel: undefined, canOpenDefault: false, editorIds: [] };

describe("resolveFileContextMenuAbsolutePath", () => {
  it("joins workspace-relative diff paths onto the workspace root", () => {
    expect(resolveFileContextMenuAbsolutePath(BASE_TARGET)).toBe("/workspace/project/src/index.ts");
  });

  it("uses the active worktree rather than the main checkout", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/worktrees/feature",
        repositoryRoot: "/workspace/project",
      }),
    ).toBe("/worktrees/feature/src/index.ts");
  });

  it("resolves paths on a Windows host", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "C:\\repo\\packages\\app",
        repositoryRoot: "C:\\repo",
        filePath: "packages/app/src/index.ts",
      }),
    ).toBe("C:\\repo\\packages\\app\\src\\index.ts");
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
  it("offers open, reveal, and an open-with submenu when all are available", () => {
    const items = buildFileContextMenuItems({
      resolve: m,
      target: BASE_TARGET,
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
      "copy-relative-path",
      "copy-absolute-path",
    ]);
    expect(items[0]).toMatchObject({ label: "Open" });
    expect(items[1]).toMatchObject({ label: "Reveal in Finder" });
    const openWith = items[2];
    if (!openWith) throw new Error("Missing open-with menu item");
    expect(openWith.children?.map((child) => child.id)).toEqual(["editor:vscode", "editor:cursor"]);
  });

  it("keeps copy actions available alongside reveal without editors", () => {
    const items = buildFileContextMenuItems({
      resolve: m,
      target: BASE_TARGET,
      capabilities: {
        revealLabel: "Reveal in File Explorer",
        canOpenDefault: false,
        editorIds: [],
      },
    });

    expect(items.map((item) => item.id)).toEqual([
      "reveal-in-folder",
      "copy-relative-path",
      "copy-absolute-path",
    ]);
    expect(items[0]).toMatchObject({ label: "Reveal in File Explorer" });
  });

  it("offers both copy actions without host file capabilities", () => {
    expect(
      buildFileContextMenuItems({
        resolve: m,
        target: BASE_TARGET,
        capabilities: EMPTY_CAPABILITIES,
      }),
    ).toEqual([
      {
        id: "copy-relative-path",
        label: "Copy relative path",
        icon: "copy",
        separatorBefore: false,
      },
      { id: "copy-absolute-path", label: "Copy absolute path", icon: "copy" },
    ]);
  });

  it("still offers relative-path copying when the absolute path cannot be resolved", () => {
    expect(
      buildFileContextMenuItems({
        resolve: m,
        target: { ...BASE_TARGET, workspaceRoot: undefined },
        capabilities: {
          revealLabel: "Reveal in Finder",
          canOpenDefault: true,
          editorIds: ["vscode"],
        },
      }),
    ).toEqual([
      {
        id: "copy-relative-path",
        label: "Copy relative path",
        icon: "copy",
        separatorBefore: false,
      },
    ]);
  });

  it("offers path copying for a sibling project without enabling host file actions", () => {
    const items = buildFileContextMenuItems({
      resolve: m,
      target: {
        ...BASE_TARGET,
        workspaceRoot: "/repo/frontend",
        repositoryRoot: "/repo",
        filePath: "backend/server.ts",
      },
      capabilities: {
        revealLabel: "Reveal in Finder",
        canOpenDefault: true,
        editorIds: ["vscode"],
      },
    });

    expect(items.map((item) => item.id)).toEqual(["copy-relative-path", "copy-absolute-path"]);
  });
});

describe("file context menu copying", () => {
  let menu: ReturnType<typeof useFileContextMenu> | undefined;
  const writeText = vi.fn<(text: string) => Promise<void>>();

  function MenuProbe(): null {
    const contextMenu = useFileContextMenu(null);
    useEffect(() => {
      menu = contextMenu;
    }, [contextMenu]);
    return null;
  }

  function setup(): Disposable {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    menu = undefined;
    return stubGlobal("navigator", { clipboard: { writeText } });
  }

  it("copies the displayed relative path without a connection or server config", async () => {
    using _clipboard = setup();
    await using _screen = await render(createElement(MenuProbe), { router: false });
    if (!menu) throw new Error("Menu not mounted");
    const filePath = "src/a file.ts";
    await menu.activate("copy-relative-path", { ...BASE_TARGET, filePath });

    expect(writeText).toHaveBeenCalledWith(filePath);
    expect(boundaries.openInEditor).not.toHaveBeenCalled();
    expect(boundaries.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Relative path copied",
      description: filePath,
    });
  });

  it("copies the absolute path on the connected environment's filesystem", async () => {
    using _clipboard = setup();
    await using _screen = await render(createElement(MenuProbe), { router: false });
    if (!menu) throw new Error("Menu not mounted");
    await menu.activate("copy-absolute-path", {
      ...BASE_TARGET,
      workspaceRoot: "/home/remote/repo/packages/app",
      repositoryRoot: "/home/remote/repo",
      filePath: "packages/app/src/index.ts",
    });

    expect(writeText).toHaveBeenCalledWith("/home/remote/repo/packages/app/src/index.ts");
    expect(boundaries.openInEditor).not.toHaveBeenCalled();
  });

  it("does not copy a relative path as if it were absolute when the root is unavailable", async () => {
    using _clipboard = setup();
    await using _screen = await render(createElement(MenuProbe), { router: false });
    if (!menu) throw new Error("Menu not mounted");
    await menu.activate("copy-absolute-path", { ...BASE_TARGET, workspaceRoot: undefined });

    expect(writeText).not.toHaveBeenCalled();
    expect(boundaries.toast).not.toHaveBeenCalled();
  });

  it("copies repository-relative paths outside a nested project", async () => {
    using _clipboard = setup();
    await using _screen = await render(createElement(MenuProbe), { router: false });
    if (!menu) throw new Error("Menu not mounted");
    await menu.activate("copy-absolute-path", {
      ...BASE_TARGET,
      workspaceRoot: "/repo/frontend",
      repositoryRoot: "/repo",
      filePath: "backend/server.ts",
    });

    expect(writeText).toHaveBeenCalledWith("/repo/backend/server.ts");
    expect(boundaries.openInEditor).not.toHaveBeenCalled();
  });

  it("reports clipboard failures without claiming the path was copied", async () => {
    using _clipboard = setup();
    await using _screen = await render(createElement(MenuProbe), { router: false });
    if (!menu) throw new Error("Menu not mounted");
    writeText.mockRejectedValue(new Error("Clipboard denied"));
    await menu.activate("copy-relative-path", BASE_TARGET);

    expect(boundaries.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Failed to copy file path",
      description: "Failed to copy file path to the clipboard.",
    });
  });
});
