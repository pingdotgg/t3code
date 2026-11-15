import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { openDiffFilePrimaryAction, resolveDiffPathForWorkspace } from "./diffFileActions";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("openDiffFilePrimaryAction", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
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

  // regression: #12902 a repository below a plain project folder keeps its intermediate folders
  it("opens repository-relative diff files from a repository below the workspace", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "lms-platform/web/backoffice/values.yaml.gotmpl",
      activeCwd: "E:\\Work\\FinBeat",
      repositoryRoot: "E:\\Work\\FinBeat\\Kubernetes\\kubernetes-pak-cl-dev",
      openInEditor,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId:
        "file:Kubernetes/kubernetes-pak-cl-dev/lms-platform/web/backoffice/values.yaml.gotmpl",
    });
    expect(openInEditor).not.toHaveBeenCalled();
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

  it.each([
    {
      filePath: "Frontend/src\\index.ts",
      workspaceRoot: "C:\\repo\\frontend",
      repositoryRoot: "C:\\repo",
      expected: "src/index.ts",
    },
    {
      filePath: "Frontend\\src\\index.ts",
      workspaceRoot: "C:\\repo\\frontend",
      repositoryRoot: "C:\\repo",
      expected: "src/index.ts",
    },
    {
      filePath: "frontend/back\\slash.txt",
      workspaceRoot: "/repo/frontend",
      repositoryRoot: "/repo",
      expected: "back\\slash.txt",
    },
    {
      filePath: "back/slash/a.ts",
      workspaceRoot: "/repo/back\\slash",
      repositoryRoot: "/repo",
      expected: null,
    },
    {
      filePath: "lms-platform/web/backoffice/values.yaml.gotmpl",
      workspaceRoot: "E:\\Work\\FinBeat",
      repositoryRoot: "E:\\Work\\FinBeat\\Kubernetes\\kubernetes-pak-cl-dev",
      expected: "Kubernetes/kubernetes-pak-cl-dev/lms-platform/web/backoffice/values.yaml.gotmpl",
    },
    {
      filePath: "lms-platform\\web\\backoffice\\values.yaml.gotmpl",
      workspaceRoot: "E:\\Work\\FinBeat",
      repositoryRoot: "E:\\Work\\FinBeat\\Kubernetes\\kubernetes-pak-cl-dev",
      expected: "Kubernetes/kubernetes-pak-cl-dev/lms-platform/web/backoffice/values.yaml.gotmpl",
    },
    {
      filePath: "src/index.ts",
      workspaceRoot: "/work/mono",
      repositoryRoot: "/work/mono/repos/app",
      expected: "repos/app/src/index.ts",
    },
    {
      // The repository folder keeps its own case; only the Windows comparison ignores case.
      filePath: "src/index.ts",
      workspaceRoot: "C:\\Work\\FinBeat",
      repositoryRoot: "c:\\work\\finbeat\\Kubernetes\\App",
      expected: "Kubernetes/App/src/index.ts",
    },
  ])(
    "resolves $filePath in $workspaceRoot",
    ({ filePath, workspaceRoot, repositoryRoot, expected }) => {
      expect(resolveDiffPathForWorkspace({ filePath, workspaceRoot, repositoryRoot })).toBe(
        expected,
      );
    },
  );

  // regression: #6174 opening diff files broke for repositories at a filesystem root
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

  it.each([
    {
      filePath: "/repo/frontend/src/index.ts",
      workspaceRoot: "/repo/frontend",
      expected: "src/index.ts",
    },
    { filePath: "c:\\Repo\\src\\index.ts", workspaceRoot: "C:\\repo", expected: "src/index.ts" },
  ])(
    "opens absolute diff paths inside the workspace: $filePath",
    ({ filePath, workspaceRoot, expected }) => {
      expect(
        resolveDiffPathForWorkspace({ filePath, workspaceRoot, repositoryRoot: workspaceRoot }),
      ).toBe(expected);
    },
  );

  it.each([
    "backend/server.ts",
    "frontend2/app.ts",
    "frontend/../secret.ts",
    "frontend/..\\secret.ts",
    "C:secret.ts",
    "/repo/backend/server.ts",
    "/repo/frontend/../backend/server.ts",
    "/repo/frontend",
    "/etc/passwd",
  ])("does not open an out-of-project diff path: %s", (filePath) => {
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
  });
});
