import "../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { ThreadId, type GitRunStackedActionResult, type VcsStatusResult } from "@t3tools/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const SHARED_THREAD_ID = ThreadId.make("thread-shared");
const ENVIRONMENT_A = "environment-local" as never;
const ENVIRONMENT_B = "environment-remote" as never;
const GIT_CWD = "/repo/project";
const BRANCH_NAME = "feature/toast-scope";

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

const {
  activeRunStackedActionDeferredRef,
  currentGitStatusRef,
  generateCommitMessageMutateAsyncSpy,
  hasServerThreadRef,
  navigateSpy,
  refreshGitStatusSpy,
  runStackedActionMutateAsyncSpy,
  setThreadBranchSpy,
  stageFilesMutateAsyncSpy,
  toastAddSpy,
  toastCloseSpy,
  toastPromiseSpy,
  toastUpdateSpy,
  unstageFilesMutateAsyncSpy,
} = vi.hoisted(() => ({
  activeRunStackedActionDeferredRef: { current: createDeferredPromise<never>() },
  currentGitStatusRef: {
    current: {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/toast-scope",
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
        staged: { files: [], insertions: 0, deletions: 0 },
        unstaged: { files: [], insertions: 0, deletions: 0 },
      },
      hasUpstream: true,
      aheadCount: 1,
      behindCount: 0,
      pr: null,
    } as VcsStatusResult,
  },
  generateCommitMessageMutateAsyncSpy: vi.fn(() =>
    Promise.resolve({ commitMessage: "Update staged files" }),
  ),
  hasServerThreadRef: { current: true },
  navigateSpy: vi.fn(),
  refreshGitStatusSpy: vi.fn(() => Promise.resolve(null)),
  runStackedActionMutateAsyncSpy: vi.fn((input: unknown) => {
    void input;
    return activeRunStackedActionDeferredRef.current.promise;
  }),
  setThreadBranchSpy: vi.fn(),
  stageFilesMutateAsyncSpy: vi.fn(() => Promise.resolve(null)),
  toastAddSpy: vi.fn(() => "toast-1"),
  toastCloseSpy: vi.fn(),
  toastPromiseSpy: vi.fn(),
  toastUpdateSpy: vi.fn(),
  unstageFilesMutateAsyncSpy: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: vi.fn(() => navigateSpy),
  useParams: vi.fn((input?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = { environmentId: ENVIRONMENT_A, threadId: SHARED_THREAD_ID };
    return input?.select ? input.select(params) : params;
  }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useIsMutating: vi.fn(() => 0),
    useMutation: vi.fn((options: { __kind?: string }) => {
      if (options.__kind === "generate-commit-message") {
        return {
          mutateAsync: generateCommitMessageMutateAsyncSpy,
          isPending: false,
        };
      }

      if (options.__kind === "run-stacked-action") {
        return {
          mutateAsync: runStackedActionMutateAsyncSpy,
          isPending: false,
        };
      }

      if (options.__kind === "stage-files") {
        return {
          mutateAsync: stageFilesMutateAsyncSpy,
          isPending: false,
        };
      }

      if (options.__kind === "unstage-files") {
        return {
          mutateAsync: unstageFilesMutateAsyncSpy,
          isPending: false,
        };
      }

      if (options.__kind === "pull") {
        return {
          mutateAsync: vi.fn(),
          isPending: false,
        };
      }

      return {
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        isPending: false,
      };
    }),
    useQuery: vi.fn(() => ({ data: null, error: null })),
    useQueryClient: vi.fn(() => ({})),
  };
});

vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: toastAddSpy,
    close: toastCloseSpy,
    promise: toastPromiseSpy,
    update: toastUpdateSpy,
  },
  stackedThreadToast: vi.fn((options: unknown) => options),
}));

vi.mock("./SourceControlPublishDialog", () => ({
  SourceControlPublishDialog: () => null,
}));

vi.mock("~/lib/gitReactQuery", () => ({
  gitGenerateCommitMessageMutationOptions: vi.fn(() => ({ __kind: "generate-commit-message" })),
  gitInitMutationOptions: vi.fn(() => ({ __kind: "init" })),
  gitMutationKeys: {
    generateCommitMessage: vi.fn(() => ["generate-commit-message"]),
    publishRepository: vi.fn(() => ["publish-repository"]),
    pull: vi.fn(() => ["pull"]),
    runStackedAction: vi.fn(() => ["run-stacked-action"]),
  },
  gitPullMutationOptions: vi.fn(() => ({ __kind: "pull" })),
  gitRunStackedActionMutationOptions: vi.fn(() => ({ __kind: "run-stacked-action" })),
  vcsStageFilesMutationOptions: vi.fn(() => ({ __kind: "stage-files" })),
  vcsUnstageFilesMutationOptions: vi.fn(() => ({ __kind: "unstage-files" })),
}));

vi.mock("~/lib/gitStatusState", () => ({
  refreshGitStatus: refreshGitStatusSpy,
  resetGitStatusStateForTests: () => undefined,
  useGitStatus: vi.fn(() => ({
    data: currentGitStatusRef.current,
    error: null,
    isPending: false,
  })),
}));

vi.mock("~/localApi", () => ({
  readLocalApi: vi.fn(() => null),
}));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: vi.fn(() => null),
}));

vi.mock("~/composerDraftStore", async () => {
  const draftStoreState = {
    getDraftThreadByRef: () => null,
    getDraftSession: () => null,
    getDraftSessionByRef: () => null,
    setDraftThreadContext: vi.fn(),
  };

  return {
    DraftId: {
      makeUnsafe: (value: string) => value,
    },
    useComposerDraftStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector(draftStoreState),
      { getState: () => draftStoreState },
    ),
  };
});

vi.mock("~/store", () => {
  function createEnvironmentState() {
    const threadShellById = hasServerThreadRef.current
      ? {
          [SHARED_THREAD_ID]: {
            id: SHARED_THREAD_ID,
            environmentId: ENVIRONMENT_A,
            projectId: "project-source-control",
            branch: BRANCH_NAME,
            worktreePath: GIT_CWD,
          },
        }
      : {};

    return {
      projectIds: [],
      projectById: {},
      threadIds: hasServerThreadRef.current ? [SHARED_THREAD_ID] : [],
      threadIdsByProjectId: {},
      threadShellById,
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      queuedTurnIdsByThreadId: {},
      queuedTurnByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      threadDetailPageInfoByThreadId: {},
      sidebarThreadSummaryById: {},
      bootstrapComplete: true,
    };
  }

  function createStoreState() {
    const environmentStateById: Record<string, ReturnType<typeof createEnvironmentState>> = {
      [ENVIRONMENT_A]: createEnvironmentState(),
      [ENVIRONMENT_B]: createEnvironmentState(),
    };

    return {
      activeEnvironmentId: ENVIRONMENT_A,
      setThreadBranch: setThreadBranchSpy,
      environmentStateById,
    };
  }

  return {
    selectProjectByRef: () => ({ cwd: GIT_CWD }),
    selectEnvironmentState: (state: ReturnType<typeof createStoreState>, environmentId: string) =>
      state.environmentStateById[environmentId] ?? createEnvironmentState(),
    useStore: (selector: (state: ReturnType<typeof createStoreState>) => unknown) =>
      selector(createStoreState()),
  };
});

import { useGitActionRunner } from "./useGitActionRunner";
import SourceControlPanel from "./SourceControlPanel";
import { __resetSourceControlPanelStateForTests } from "../sourceControlPanelState";
import {
  __readWorkspaceFilePanelStateForTests,
  __resetWorkspaceFilePanelStateForTests,
} from "../workspaceFilePreview";

function Harness() {
  const [activeThreadRef, setActiveThreadRef] = useState(
    scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID),
  );
  const runner = useGitActionRunner({
    gitCwd: GIT_CWD,
    environmentId: activeThreadRef.environmentId,
    activeThreadRef,
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setActiveThreadRef(scopeThreadRef(ENVIRONMENT_B, SHARED_THREAD_ID))}
      >
        Switch environment
      </button>
      <button
        type="button"
        onClick={() => {
          void runner.runGitActionWithToast({ action: "create_pr" });
        }}
      >
        Run source control action
      </button>
    </>
  );
}

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

function findButtonByExactText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  ) ?? null) as HTMLButtonElement | null;
}

function createPanelStatus(input?: {
  stagedFiles?: VcsStatusResult["workingTree"]["files"];
  unstagedFiles?: VcsStatusResult["workingTree"]["files"];
}): VcsStatusResult {
  const stagedFiles = input?.stagedFiles ?? [];
  const unstagedFiles = input?.unstagedFiles ?? [];
  const files = [...stagedFiles, ...unstagedFiles].toSorted((a, b) => a.path.localeCompare(b.path));
  const insertions = files.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    isRepo: true,
    sourceControlProvider: {
      kind: "github",
      name: "GitHub",
      baseUrl: "https://github.com",
    },
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: BRANCH_NAME,
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files,
      insertions,
      deletions,
      staged: {
        files: stagedFiles,
        insertions: stagedFiles.reduce((sum, file) => sum + file.insertions, 0),
        deletions: stagedFiles.reduce((sum, file) => sum + file.deletions, 0),
      },
      unstaged: {
        files: unstagedFiles,
        insertions: unstagedFiles.reduce((sum, file) => sum + file.insertions, 0),
        deletions: unstagedFiles.reduce((sum, file) => sum + file.deletions, 0),
      },
    },
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 0,
    pr: null,
  };
}

function createPushedResult(
  cta: GitRunStackedActionResult["toast"]["cta"] = { kind: "none" },
): GitRunStackedActionResult {
  return {
    action: "push",
    branch: { status: "skipped_not_requested" },
    commit: { status: "skipped_not_requested" },
    push: {
      status: "pushed",
      branch: BRANCH_NAME,
      upstreamBranch: `origin/${BRANCH_NAME}`,
    },
    pr: { status: "skipped_not_requested" },
    toast: {
      title: `Pushed 89abcde to origin/${BRANCH_NAME}`,
      description: "feat: update source control push flow",
      cta,
    },
  };
}

async function renderPanel() {
  const host = document.createElement("div");
  host.style.height = "320px";
  host.style.width = "720px";
  document.body.append(host);
  const screen = await render(<SourceControlPanel onClose={() => undefined} />, {
    container: host,
  });
  return { host, screen };
}

function getSourceControlScrollViewport(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="source-control-scroll"] [data-slot="scroll-area-viewport"]',
  );
}

describe("SourceControlPanel git action runner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    activeRunStackedActionDeferredRef.current = createDeferredPromise<never>();
    currentGitStatusRef.current = createPanelStatus();
    hasServerThreadRef.current = true;
    __resetSourceControlPanelStateForTests();
    __resetWorkspaceFilePanelStateForTests();
    document.body.innerHTML = "";
  });

  it("renders staged and changes sections without checkboxes", async () => {
    currentGitStatusRef.current = createPanelStatus({
      stagedFiles: [{ path: "staged.ts", status: "modified", insertions: 1, deletions: 0 }],
      unstagedFiles: [{ path: "unstaged.ts", status: "untracked", insertions: 0, deletions: 0 }],
    });
    const { host, screen } = await renderPanel();

    try {
      expect(document.body.textContent).toContain("Staged Changes");
      expect(document.body.textContent).toContain("Changes");
      expect(document.body.textContent).not.toContain("Unstaged Changes");
      expect(document.querySelector('[role="checkbox"]')).toBeNull();
      expect(document.querySelectorAll('img[aria-hidden="true"]').length).toBeGreaterThanOrEqual(2);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("stages and unstages files from row and section actions", async () => {
    currentGitStatusRef.current = createPanelStatus({
      stagedFiles: [{ path: "staged.ts", status: "modified", insertions: 1, deletions: 0 }],
      unstagedFiles: [{ path: "src/app.ts", status: "modified", insertions: 2, deletions: 1 }],
    });
    const { host, screen } = await renderPanel();

    try {
      (
        document.querySelector('button[aria-label="Stage src/app.ts"]') as HTMLButtonElement
      ).click();
      (
        document.querySelector('button[aria-label="Unstage staged.ts"]') as HTMLButtonElement
      ).click();
      (document.querySelector('button[aria-label="Stage all"]') as HTMLButtonElement).click();
      (document.querySelector('button[aria-label="Unstage all"]') as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(stageFilesMutateAsyncSpy).toHaveBeenCalledWith({ filePaths: ["src/app.ts"] });
        expect(unstageFilesMutateAsyncSpy).toHaveBeenCalledWith({ filePaths: ["staged.ts"] });
      });
      expect(stageFilesMutateAsyncSpy).toHaveBeenCalledWith({ filePaths: ["src/app.ts"] });
      expect(unstageFilesMutateAsyncSpy).toHaveBeenCalledWith({ filePaths: ["staged.ts"] });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("opens staged and unstaged file rows in the file preview", async () => {
    currentGitStatusRef.current = createPanelStatus({
      stagedFiles: [{ path: "staged-only.ts", status: "modified", insertions: 1, deletions: 0 }],
      unstagedFiles: [
        { path: "unstaged-only.ts", status: "modified", insertions: 1, deletions: 0 },
      ],
    });
    const { host, screen } = await renderPanel();

    try {
      findButtonByText("staged-only.ts")?.click();
      let filePanel = __readWorkspaceFilePanelStateForTests();
      expect(filePanel.open).toBe(true);
      expect(filePanel.view).toBe("preview");
      expect(filePanel.target?.relativePath).toBe("staged-only.ts");
      expect(filePanel.returnTarget).toEqual({ kind: "source-control" });

      findButtonByText("unstaged-only.ts")?.click();
      filePanel = __readWorkspaceFilePanelStateForTests();
      expect(filePanel.target?.relativePath).toBe("unstaged-only.ts");
      expect(filePanel.returnTarget).toBeNull();
      expect(navigateSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("restores the source control scroll position after returning from a file preview", async () => {
    currentGitStatusRef.current = createPanelStatus({
      unstagedFiles: Array.from({ length: 40 }, (_, index) => ({
        path: `docs/file-${String(index).padStart(2, "0")}.ts`,
        status: "modified",
        insertions: 1,
        deletions: 0,
      })),
    });
    const firstRender = await renderPanel();

    try {
      await vi.waitFor(() => {
        expect(getSourceControlScrollViewport()).not.toBeNull();
      });
      const viewport = getSourceControlScrollViewport();
      expect(viewport).not.toBeNull();
      viewport!.scrollTop = 180;
      viewport!.dispatchEvent(new Event("scroll"));
      await vi.waitFor(() => {
        expect(viewport!.scrollTop).toBe(180);
      });

      findButtonByText("file-08.ts")?.click();
      expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
        open: true,
        view: "preview",
        returnTarget: { kind: "source-control" },
      });
    } finally {
      await firstRender.screen.unmount();
      firstRender.host.remove();
    }

    const secondRender = await renderPanel();
    try {
      await vi.waitFor(() => {
        expect(getSourceControlScrollViewport()?.scrollTop).toBe(180);
      });
    } finally {
      await secondRender.screen.unmount();
      secondRender.host.remove();
    }
  });

  it("defaults to the list view", async () => {
    currentGitStatusRef.current = createPanelStatus({
      unstagedFiles: [{ path: "src/app.ts", status: "modified", insertions: 1, deletions: 0 }],
    });
    const { host, screen } = await renderPanel();

    try {
      await vi.waitFor(() => {
        expect(findButtonByText("app.ts")).not.toBeNull();
      });
      // List view renders filenames and no collapsible folder rows, and offers
      // the toggle to switch to tree.
      expect(document.body.textContent).not.toContain("src/app.ts");
      expect(findButtonByExactText("src")).toBeNull();
      expect(document.querySelector('button[aria-label="View as tree"]')).not.toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("persists the chosen view mode and restores collapsed folders after a remount", async () => {
    currentGitStatusRef.current = createPanelStatus({
      unstagedFiles: [
        { path: "docs/keep.ts", status: "modified", insertions: 1, deletions: 0 },
        { path: "src/app.ts", status: "modified", insertions: 1, deletions: 0 },
      ],
    });
    const firstRender = await renderPanel();

    try {
      // Switch from the default list view into the tree view.
      document.querySelector<HTMLButtonElement>('button[aria-label="View as tree"]')?.click();
      await vi.waitFor(() => {
        expect(findButtonByExactText("src")).not.toBeNull();
      });
      findButtonByExactText("src")?.click();
      await vi.waitFor(() => {
        expect(findButtonByText("app.ts")).toBeNull();
      });

      findButtonByText("keep.ts")?.click();
      expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
        open: true,
        view: "preview",
        returnTarget: { kind: "source-control" },
      });
    } finally {
      await firstRender.screen.unmount();
      firstRender.host.remove();
    }

    const secondRender = await renderPanel();
    try {
      // The tree view (and the collapsed "src" folder) are restored.
      await vi.waitFor(() => {
        expect(findButtonByExactText("src")).not.toBeNull();
      });
      expect(document.querySelector('button[aria-label="View as list"]')).not.toBeNull();
      expect(findButtonByText("app.ts")).toBeNull();
    } finally {
      await secondRender.screen.unmount();
      secondRender.host.remove();
    }
  });

  it("commits without sending selected file paths", async () => {
    currentGitStatusRef.current = createPanelStatus({
      unstagedFiles: [{ path: "src/app.ts", status: "modified", insertions: 2, deletions: 1 }],
    });
    const { host, screen } = await renderPanel();

    try {
      findButtonByText("Commit")?.click();

      await vi.waitFor(() => {
        expect(runStackedActionMutateAsyncSpy).toHaveBeenCalled();
      });
      const input = runStackedActionMutateAsyncSpy.mock.calls.at(-1)?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(input).toMatchObject({ action: "commit" });
      expect(input).not.toHaveProperty("filePaths");
    } finally {
      activeRunStackedActionDeferredRef.current.reject(new Error("test cleanup"));
      await Promise.resolve();
      await screen.unmount();
      host.remove();
    }
  });

  it("shows a button spinner instead of a toast while committing", async () => {
    currentGitStatusRef.current = createPanelStatus({
      unstagedFiles: [{ path: "src/app.ts", status: "modified", insertions: 2, deletions: 1 }],
    });
    const { host, screen } = await renderPanel();

    try {
      findButtonByText("Commit")?.click();

      await vi.waitFor(() => {
        expect(runStackedActionMutateAsyncSpy).toHaveBeenCalled();
      });
      // The commit button should not raise a "Committing..." loading toast.
      expect(toastAddSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "loading" }));
      // The inline button shows a spinner while the commit is in flight.
      const commitButton = findButtonByText("Commit");
      expect(commitButton?.querySelector('[role="status"]')).not.toBeNull();
      expect(commitButton?.disabled).toBe(true);
    } finally {
      activeRunStackedActionDeferredRef.current.reject(new Error("test cleanup"));
      await Promise.resolve();
      await screen.unmount();
      host.remove();
    }
  });

  it("promotes Push to the primary button with ahead/behind counts when the tree is clean", async () => {
    currentGitStatusRef.current = {
      ...createPanelStatus(),
      aheadCount: 3,
      behindCount: 2,
    };
    const { host, screen } = await renderPanel();

    try {
      const pushButton = findButtonByText("Push");
      expect(pushButton).not.toBeNull();
      expect(pushButton?.textContent).toContain("3");
      expect(pushButton?.textContent).toContain("2");
      // Commit is no longer the primary button while there are commits to push.
      expect(findButtonByExactText("Commit")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows a button spinner instead of a loading toast while pushing, then adds the success toast", async () => {
    currentGitStatusRef.current = {
      ...createPanelStatus(),
      aheadCount: 2,
      behindCount: 0,
    };
    const { host, screen } = await renderPanel();
    const actionDeferred = createDeferredPromise<GitRunStackedActionResult>();
    runStackedActionMutateAsyncSpy.mockImplementationOnce(
      () => actionDeferred.promise as unknown as Promise<never>,
    );
    const refreshDeferred = createDeferredPromise<null>();
    refreshGitStatusSpy.mockImplementationOnce(() => refreshDeferred.promise);

    try {
      const pushButton = findButtonByText("Push");
      expect(pushButton).not.toBeNull();
      pushButton?.click();

      await vi.waitFor(() => {
        expect(runStackedActionMutateAsyncSpy).toHaveBeenCalledWith(
          expect.objectContaining({ action: "push" }),
        );
      });
      await vi.waitFor(() => {
        const loadingPushButton = findButtonByText("Push");
        expect(loadingPushButton?.querySelector('[role="status"]')).not.toBeNull();
        expect(loadingPushButton?.disabled).toBe(true);
        expect(loadingPushButton?.textContent).not.toContain("2");
      });
      expect(toastAddSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "loading" }));

      actionDeferred.resolve(
        createPushedResult({
          kind: "run_action",
          label: "Create PR",
          action: { kind: "create_pr" },
        }),
      );
      currentGitStatusRef.current = { ...createPanelStatus(), aheadCount: 0, behindCount: 0 };
      refreshDeferred.resolve(null);

      await vi.waitFor(() => {
        expect(toastAddSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            actionProps: expect.objectContaining({ children: "Create PR" }),
            title: `Pushed 89abcde to origin/${BRANCH_NAME}`,
            type: "success",
          }),
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps the primary button loading until the post-action status refresh resolves", async () => {
    currentGitStatusRef.current = { ...createPanelStatus(), aheadCount: 2, behindCount: 0 };

    const { host, screen } = await renderPanel();

    // Set the controllable mocks after mount so the panel's initial refresh
    // (which consumes a refresh call) doesn't swallow them.
    const actionDeferred = createDeferredPromise<unknown>();
    runStackedActionMutateAsyncSpy.mockImplementationOnce(
      () => actionDeferred.promise as unknown as Promise<never>,
    );
    const refreshDeferred = createDeferredPromise<null>();
    refreshGitStatusSpy.mockImplementationOnce(() => refreshDeferred.promise);

    try {
      const pushButton = findButtonByText("Push");
      expect(pushButton).not.toBeNull();
      expect(pushButton?.disabled).toBe(false);
      pushButton?.click();

      await vi.waitFor(() => {
        const loadingPushButton = findButtonByText("Push");
        expect(loadingPushButton?.querySelector('[role="status"]')).not.toBeNull();
        expect(loadingPushButton?.disabled).toBe(true);
      });
      expect(toastAddSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "loading" }));

      // The action resolves; the runner now awaits the forced status refresh.
      actionDeferred.resolve(createPushedResult());

      // While the refresh is in flight the Push button stays disabled rather
      // than flashing back to an actionable state.
      await vi.waitFor(() => {
        const loadingPushButton = findButtonByText("Push");
        expect(loadingPushButton?.disabled).toBe(true);
        expect(loadingPushButton?.querySelector('[role="status"]')).not.toBeNull();
      });

      // The push landed: the fresh status is clean/up-to-date, so once the
      // refresh resolves the button flips straight to Commit.
      currentGitStatusRef.current = { ...createPanelStatus(), aheadCount: 0, behindCount: 0 };
      refreshDeferred.resolve(null);

      await vi.waitFor(() => {
        expect(findButtonByText("Push")).toBeNull();
        expect(findButtonByExactText("Commit")).not.toBeNull();
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows a spinner on the staged row while unstaging", async () => {
    const unstageDeferred = createDeferredPromise<null>();
    unstageFilesMutateAsyncSpy.mockImplementationOnce(() => unstageDeferred.promise);
    currentGitStatusRef.current = createPanelStatus({
      stagedFiles: [{ path: "staged.ts", status: "modified", insertions: 1, deletions: 0 }],
    });
    const { host, screen } = await renderPanel();

    try {
      (
        document.querySelector('button[aria-label="Unstage staged.ts"]') as HTMLButtonElement
      ).click();

      await vi.waitFor(() => {
        const button = document.querySelector(
          'button[aria-label="Unstage staged.ts"]',
        ) as HTMLButtonElement | null;
        expect(button?.querySelector('[role="status"]')).not.toBeNull();
      });
    } finally {
      unstageDeferred.resolve(null);
      await Promise.resolve();
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps an in-flight git action toast pinned to the thread ref that started it", async () => {
    vi.useFakeTimers();

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<Harness />, { container: host });

    try {
      const runButton = findButtonByText("Run source control action");
      expect(
        runButton,
        'Unable to find button containing "Run source control action"',
      ).toBeTruthy();
      if (!(runButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Run source control action"');
      }
      runButton.click();

      expect(toastAddSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { threadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID) },
          title: "Pushing...",
          type: "loading",
        }),
      );

      await vi.advanceTimersByTimeAsync(1_000);

      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({
          data: { threadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID) },
          title: "Pushing...",
          type: "loading",
        }),
      );

      const switchEnvironmentButton = findButtonByText("Switch environment");
      expect(
        switchEnvironmentButton,
        'Unable to find button containing "Switch environment"',
      ).toBeTruthy();
      if (!(switchEnvironmentButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Switch environment"');
      }
      switchEnvironmentButton.click();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({
          data: { threadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID) },
          title: "Pushing...",
          type: "loading",
        }),
      );
    } finally {
      activeRunStackedActionDeferredRef.current.reject(new Error("test cleanup"));
      await Promise.resolve();
      vi.useRealTimers();
      await screen.unmount();
      host.remove();
    }
  });

  it("updates the action toast with the rejected git error", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<Harness />, { container: host });

    try {
      const runButton = findButtonByText("Run source control action");
      expect(
        runButton,
        'Unable to find button containing "Run source control action"',
      ).toBeTruthy();
      if (!(runButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Run source control action"');
      }

      runButton.click();
      activeRunStackedActionDeferredRef.current.reject(new Error("Permission denied (publickey)."));

      await vi.waitFor(() => {
        expect(toastUpdateSpy).toHaveBeenCalledWith(
          "toast-1",
          expect.objectContaining({
            data: { threadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID) },
            description: "Permission denied (publickey).",
            title: "Action failed",
            type: "error",
          }),
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("debounces focus-driven git status refreshes", async () => {
    vi.useFakeTimers();

    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibilityState: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<Harness />, { container: host });

    try {
      window.dispatchEvent(new Event("focus"));
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));

      expect(refreshGitStatusSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(249);
      expect(refreshGitStatusSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(refreshGitStatusSpy).toHaveBeenCalledTimes(1);
      expect(refreshGitStatusSpy).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_A,
        cwd: GIT_CWD,
      });
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, "visibilityState", originalVisibilityState);
      }
      vi.useRealTimers();
      await screen.unmount();
      host.remove();
    }
  });
});
