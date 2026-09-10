import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  openDiffFilePrimaryAction,
  resolveConfiguredRepositoryRoot,
  resolveDiffPathForWorkspace,
} from "./diffFileActions";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("openDiffFilePrimaryAction", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {} });
  });

  it("opens diff files in the thread file viewer", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openInEditor,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:apps/web/src/components/DiffPanel.tsx",
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("falls back to the editor without thread context", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith(
      "/repo/project/apps/web/src/components/DiffPanel.tsx",
    );
  });

  it("opens repository-relative diff files from a nested project", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "frontend/Dockerfile",
      activeCwd: "/repo/frontend",
      repositoryRoot: { path: "/repo", kind: "detected" },
      openInEditor,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:Dockerfile",
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("preserves repository-relative paths in a separate worktree", () => {
    // A worktree is its own repository root, so the diff paths already are
    // workspace-relative and no root has to be reconciled.
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/Dockerfile",
        workspaceRoot: "/worktrees/feature",
        repositoryRoot: undefined,
      }),
    ).toBe("frontend/Dockerfile");
  });

  it.each([
    { workspaceRoot: "/ws", repositoryRoot: "/elsewhere/repo" },
    { workspaceRoot: "C:\\ws", repositoryRoot: "D:\\elsewhere\\repo" },
  ])(
    "does not open a diff file from an unrelated configured repository root: $repositoryRoot",
    ({ workspaceRoot, repositoryRoot }) => {
      const openInEditor = vi.fn();

      openDiffFilePrimaryAction({
        threadRef: THREAD_REF,
        filePath: "src/foo.ts",
        activeCwd: workspaceRoot,
        repositoryRoot: { path: repositoryRoot, kind: "configured" },
        openInEditor,
      });

      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
      ).toMatchObject({ isOpen: false });
      expect(openInEditor).not.toHaveBeenCalled();
    },
  );

  it.each([
    { workspaceRoot: "/ws", repositoryRoot: "/data/code/ws" },
    { workspaceRoot: "C:\\ws", repositoryRoot: "D:\\data\\code\\ws" },
  ])(
    "still opens a diff file when a detected repository root does not nest: $repositoryRoot",
    ({ workspaceRoot, repositoryRoot }) => {
      // Detected roots come from `git rev-parse --show-toplevel`, which resolves
      // symlinks, while the workspace root does not. Behind a symlinked project
      // folder (`~/code -> /data/code`, or macOS `/tmp` -> `/private/tmp`) the two
      // describe the same tree without nesting, and the diff path is still
      // workspace-relative. Configured roots must keep refusing this case.
      const openInEditor = vi.fn();

      openDiffFilePrimaryAction({
        threadRef: null,
        filePath: "src/foo.ts",
        activeCwd: workspaceRoot,
        repositoryRoot: { path: repositoryRoot, kind: "detected" },
        openInEditor,
      });

      expect(openInEditor).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the relative path intact below a Windows root that changes length when lowercased", () => {
    // `İ` (U+0130) lowercases to two code units, so the prefix length measured on
    // the lowercased comparison form does not apply to the original path.
    expect(
      resolveDiffPathForWorkspace({
        filePath: "ws/src/foo.ts",
        workspaceRoot: "C:\\Projekte\\İstanbul\\ws",
        repositoryRoot: { path: "C:\\Projekte\\İstanbul", kind: "detected" },
      }),
    ).toBe("src/foo.ts");
  });

  it("handles Windows roots and mixed diff separators", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "Frontend/src\\index.ts",
        workspaceRoot: "C:\\repo\\frontend",
        repositoryRoot: { path: "C:\\repo", kind: "detected" },
      }),
    ).toBe("src/index.ts");
  });

  it.each([
    { workspaceRoot: "/frontend", repositoryRoot: "/" },
    { workspaceRoot: "C:\\frontend", repositoryRoot: "C:\\" },
  ])("handles filesystem roots: $repositoryRoot", ({ workspaceRoot, repositoryRoot }) => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/index.ts",
        workspaceRoot,
        repositoryRoot: { path: repositoryRoot, kind: "detected" },
      }),
    ).toBe("index.ts");
  });

  it.each(["backend/server.ts", "frontend2/app.ts", "frontend/../secret.ts", "C:secret.ts"])(
    "does not open an out-of-project diff path: %s",
    (filePath) => {
      const openInEditor = vi.fn();

      openDiffFilePrimaryAction({
        threadRef: THREAD_REF,
        filePath,
        activeCwd: "/repo/frontend",
        repositoryRoot: { path: "/repo", kind: "detected" },
        openInEditor,
      });

      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
      ).toMatchObject({ isOpen: false });
      expect(openInEditor).not.toHaveBeenCalled();
    },
  );
  it("opens files of a repository nested inside the workspace", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: "src/foo.ts",
      activeCwd: "/ws",
      repositoryRoot: { path: "/ws/frontend", kind: "configured" },
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith("/ws/frontend/src/foo.ts");
  });

  it("keeps nested repository files workspace-relative for the file viewer", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "src/foo.ts",
      activeCwd: "/ws",
      repositoryRoot: { path: "/ws/frontend", kind: "configured" },
      openInEditor,
    });

    // The file viewer resolves its path against the workspace root, so the
    // nested repository offset has to stay in the path.
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:frontend/src/foo.ts",
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("opens files of a Windows repository nested inside the workspace", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "src\\foo.ts",
        workspaceRoot: "C:\\ws",
        repositoryRoot: { path: "C:\\ws\\Frontend", kind: "configured" },
      }),
    ).toBe("Frontend/src/foo.ts");
  });

  it("resolves workspace-root diff files without a repository selection", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: "src/foo.ts",
      activeCwd: "/ws",
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith("/ws/src/foo.ts");
  });

  it("resolves worktree diff files against the worktree root", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: "src/foo.ts",
      activeCwd: "/worktrees/feature",
      repositoryRoot: undefined,
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith("/worktrees/feature/src/foo.ts");
  });

  it("strips the workspace prefix when the workspace sits inside the repository", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: "frontend/src/foo.ts",
      activeCwd: "/repo/frontend",
      repositoryRoot: { path: "/repo", kind: "detected" },
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith("/repo/frontend/src/foo.ts");
  });

  it("matches workspace prefixes case-insensitively on Windows", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "Frontend/src/index.ts",
        workspaceRoot: "C:\\repo\\Frontend",
        repositoryRoot: { path: "C:\\repo", kind: "detected" },
      }),
    ).toBe("src/index.ts");
  });
});

describe("resolveConfiguredRepositoryRoot", () => {
  it.each([
    { repositoryPath: ".", workspaceRoot: "/ws", expected: "/ws" },
    { repositoryPath: "frontend", workspaceRoot: "/ws", expected: "/ws/frontend" },
    { repositoryPath: "services/api", workspaceRoot: "/ws", expected: "/ws/services/api" },
    { repositoryPath: "./services/api", workspaceRoot: "/ws", expected: "/ws/services/api" },
    { repositoryPath: "frontend", workspaceRoot: "/ws/", expected: "/ws/frontend" },
    { repositoryPath: "frontend", workspaceRoot: "/", expected: "/frontend" },
    { repositoryPath: "services/api", workspaceRoot: "C:\\ws", expected: "C:\\ws\\services\\api" },
    { repositoryPath: "services\\api", workspaceRoot: "C:\\ws", expected: "C:\\ws\\services\\api" },
    { repositoryPath: ".", workspaceRoot: "C:\\ws", expected: "C:\\ws" },
  ])(
    "resolves $repositoryPath below $workspaceRoot",
    ({ repositoryPath, workspaceRoot, expected }) => {
      expect(resolveConfiguredRepositoryRoot(repositoryPath, workspaceRoot)).toBe(expected);
    },
  );

  it.each([
    "",
    "/absolute/repo",
    "\\\\server\\share",
    "\\drive-relative",
    "C:/repo",
    "C:\\repo",
    "C:repo",
    "..",
    "../sibling",
    "frontend/../../escape",
    "~",
    "~/client",
    "~user/client",
    "nested/~/client",
    "weird:path",
    "nested/weird:path",
  ])("rejects the configured path: %s", (repositoryPath) => {
    expect(resolveConfiguredRepositoryRoot(repositoryPath, "/ws")).toBeNull();
    expect(resolveConfiguredRepositoryRoot(repositoryPath, "C:\\ws")).toBeNull();
  });
});
