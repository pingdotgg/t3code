import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  openDiffFileInEditor,
  openDiffFilePrimaryAction,
  resolveDiffEditorLaunch,
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
      repositoryRoot: "/repo",
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

  it("can explicitly open a repository-relative diff file in the editor", () => {
    const openInEditor = vi.fn();

    openDiffFileInEditor({
      filePath: "frontend/Dockerfile",
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith("/repo/frontend/Dockerfile");
  });

  it("preserves repository-relative paths in a separate worktree", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/Dockerfile",
        workspaceRoot: "/worktrees/feature",
        repositoryRoot: "/repo",
      }),
    ).toBe("frontend/Dockerfile");
  });

  it("handles Windows roots and mixed diff separators", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "Frontend/src\\index.ts",
        workspaceRoot: "C:\\repo\\frontend",
        repositoryRoot: "C:\\repo",
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
        repositoryRoot,
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
        repositoryRoot: "/repo",
        openInEditor,
      });

      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
      ).toMatchObject({ isOpen: false });
      expect(openInEditor).not.toHaveBeenCalled();
    },
  );
});

describe("resolveDiffEditorLaunch", () => {
  it("execs the preferred editor when the client shares the environment machine", () => {
    expect(
      resolveDiffEditorLaunch({
        remoteOpen: { mode: "local-exec" },
        editor: "cursor",
        targetPath: "/repo/file.ts",
        revealInFileManager: true,
      }),
    ).toEqual({ kind: "local-exec", editor: "cursor", reveal: false });
  });

  it("reveals instead of opening when the preferred editor is the file manager", () => {
    expect(
      resolveDiffEditorLaunch({
        remoteOpen: { mode: "local-exec" },
        editor: "file-manager",
        targetPath: "/repo/file.ts",
        revealInFileManager: true,
      }),
    ).toEqual({ kind: "local-exec", editor: "file-manager", reveal: true });
  });

  it("hands off-machine clients an SSH deep link", () => {
    const launch = resolveDiffEditorLaunch({
      remoteOpen: { mode: "remote-links", host: { kind: "ssh-alias", host: "devbox" } },
      editor: "vscode",
      targetPath: "/repo/file.ts",
      revealInFileManager: false,
    });
    expect(launch.kind).toBe("remote-url");
    if (launch.kind === "remote-url") {
      expect(launch.url).toContain("devbox");
      expect(launch.url).toContain("/repo/file.ts");
    }
  });

  it("never falls back to a server-side exec without an SSH route", () => {
    expect(
      resolveDiffEditorLaunch({
        remoteOpen: { mode: "remote-unavailable" },
        editor: "vscode",
        targetPath: "/repo/file.ts",
        revealInFileManager: false,
      }),
    ).toEqual({ kind: "unavailable" });
  });
});
