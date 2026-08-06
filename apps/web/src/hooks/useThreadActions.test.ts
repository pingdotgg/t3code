import type { ScopedThreadRef } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadShell } from "../types";

const testState = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  archivedThreadDeletionContext: vi.fn(),
  clearComposerDraftForThread: vi.fn(),
  clearProjectDraftThreadById: vi.fn(),
  clearTerminalUiState: vi.fn(),
  closeTerminal: vi.fn(),
  confirm: vi.fn(),
  deleteThread: vi.fn(),
  navigate: vi.fn(),
  noopCommand: vi.fn(),
  refreshArchivedThreads: vi.fn(),
  refreshVcsStatus: vi.fn(),
  removeWorktree: vi.fn(),
  stopThreadSession: vi.fn(),
  toast: vi.fn(),
  unarchiveThread: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T>(callback: T): T => callback,
    useMemo: <T>(factory: () => T): T => factory(),
    useRef: <T>(value: T): { current: T } => ({ current: value }),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { matches: [] }, navigate: testState.navigate }),
}));

vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: () => null,
}));

vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: testState.toast },
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (state: unknown) => unknown) =>
    select({
      clearDraftThread: testState.clearComposerDraftForThread,
      clearProjectDraftThreadById: testState.clearProjectDraftThreadById,
    }),
}));

vi.mock("../lib/archivedThreadsState", () => ({
  readArchivedThreadDeletionContext: testState.archivedThreadDeletionContext,
  refreshArchivedThreadsForEnvironment: testState.refreshArchivedThreads,
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: testState.confirm } }),
}));

vi.mock("../state/entities", () => ({
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentThreadRefs: () => [],
  readProject: () => null,
  readThreadShell: () => null,
}));

vi.mock("../state/terminal", () => ({
  terminalEnvironment: { close: "closeTerminal" },
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: {
    archive: "archiveThread",
    delete: "deleteThread",
    pin: "pinThread",
    settle: "settleThread",
    snooze: "snoozeThread",
    unarchive: "unarchiveThread",
    unpin: "unpinThread",
    unsettle: "unsettleThread",
    unsnooze: "unsnoozeThread",
  },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => {
    switch (command) {
      case "archiveThread":
        return testState.archiveThread;
      case "closeTerminal":
        return testState.closeTerminal;
      case "deleteThread":
        return testState.deleteThread;
      case "removeWorktree":
        return testState.removeWorktree;
      case "refreshVcsStatus":
        return testState.refreshVcsStatus;
      case "stopThreadSession":
        return testState.stopThreadSession;
      case "unarchiveThread":
        return testState.unarchiveThread;
      default:
        return testState.noopCommand;
    }
  },
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    refreshStatus: "refreshVcsStatus",
    removeWorktree: "removeWorktree",
  },
}));

vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (select: (state: unknown) => unknown) =>
    select({ clearTerminalUiState: testState.clearTerminalUiState }),
}));

vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => vi.fn(),
}));

vi.mock("./useSettings", () => ({
  useClientSettings: (
    select: (settings: {
      confirmThreadDelete: boolean;
      sidebarThreadSortOrder: "updated_at";
    }) => unknown,
  ) => select({ confirmThreadDelete: false, sidebarThreadSortOrder: "updated_at" }),
}));

import { ThreadArchiveBlockedError, useThreadActions } from "./useThreadActions";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const threadRef: ScopedThreadRef = { environmentId, threadId };

function makeArchivedThread(): ThreadShell {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Archived worktree thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "t3/archived-worktree",
    worktreePath: "/repo/.t3/worktrees/archived-worktree",
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    archivedAt: "2026-08-03T00:00:00.000Z",
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({ environmentId, threadId });

    expect(error).toMatchObject({ environmentId, threadId });
    expect(error.message).toBe("Cannot archive a running thread.");
  });
});

describe("useThreadActions", () => {
  beforeEach(() => {
    for (const mock of Object.values(testState)) {
      mock.mockReset();
    }
    testState.confirm.mockResolvedValue(true);
    testState.deleteThread.mockResolvedValue(AsyncResult.success(undefined));
    testState.refreshVcsStatus.mockResolvedValue(AsyncResult.success(undefined));
    testState.removeWorktree.mockResolvedValue(AsyncResult.success(undefined));
  });

  it("removes an orphaned worktree when deleting an archived thread", async () => {
    const thread = makeArchivedThread();
    testState.archivedThreadDeletionContext.mockReturnValue({
      thread,
      threads: [thread],
      projectCwd: "/repo",
    });
    const actions = useThreadActions();

    await actions.confirmAndDeleteThread(threadRef);

    expect(testState.deleteThread).toHaveBeenCalledWith({
      environmentId,
      input: { threadId },
    });
    expect(testState.removeWorktree).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo",
        path: "/repo/.t3/worktrees/archived-worktree",
        force: true,
      },
    });
  });

  it("keeps an archived worktree that is still shared by another thread", async () => {
    const thread = makeArchivedThread();
    const sibling = { ...makeArchivedThread(), id: ThreadId.make("thread-2") };
    testState.archivedThreadDeletionContext.mockReturnValue({
      thread,
      threads: [thread, sibling],
      projectCwd: "/repo",
    });
    const actions = useThreadActions();

    await actions.confirmAndDeleteThread(threadRef);

    expect(testState.deleteThread).toHaveBeenCalledOnce();
    expect(testState.confirm).not.toHaveBeenCalled();
    expect(testState.removeWorktree).not.toHaveBeenCalled();
  });
});
