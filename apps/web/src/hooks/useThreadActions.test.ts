import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  archiveMutation: vi.fn(),
  clearComposerDraftForThread: vi.fn(),
  clearProjectDraftThreadById: vi.fn(),
  clearTerminalUiState: vi.fn(),
  handleNewThread: vi.fn(),
  markThreadVisited: vi.fn(),
  readThreadShell: vi.fn(),
  refreshArchivedThreads: vi.fn(),
  releaseComposerDraftUploads: vi.fn(),
}));
import { navigateAfterThreadDeletion } from "./useThreadActions";
import { toastManager } from "../components/ui/toast";

describe("navigateAfterThreadDeletion", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });

  it("does not report an error after successful navigation", async () => {
    const addToast = vi.spyOn(toastManager, "add");

    await navigateAfterThreadDeletion(() => Promise.resolve());

    expect(addToast).not.toHaveBeenCalled();
  });
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: vi.fn(),
    state: { matches: [{ params: {} }] },
  }),
}));

vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: vi.fn(() => null),
  pinOrderKeyBetween: vi.fn(() => null),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: <T>(
    selector: (state: {
      clearDraftThread: typeof mocks.clearComposerDraftForThread;
      clearProjectDraftThreadById: typeof mocks.clearProjectDraftThreadById;
    }) => T,
  ) =>
    selector({
      clearDraftThread: mocks.clearComposerDraftForThread,
      clearProjectDraftThreadById: mocks.clearProjectDraftThreadById,
    }),
}));

vi.mock("../state/terminal", () => ({ terminalEnvironment: { close: {} } }));
vi.mock("../state/threads", () => ({
  threadEnvironment: {
    archive: {},
    delete: {},
    pin: {},
    reorderPin: {},
    settle: {},
    snooze: {},
    stopSession: {},
    unarchive: {},
    unpin: {},
    unsettle: {},
    unsnooze: {},
  },
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { refreshStatus: {}, removeWorktree: {} },
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => mocks.handleNewThread,
}));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: mocks.refreshArchivedThreads,
}));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseComposerDraftUploads: mocks.releaseComposerDraftUploads,
}));
vi.mock("../localApi", () => ({ readLocalApi: vi.fn(() => null) }));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsPinning: vi.fn(() => false),
  readEnvironmentSupportsPinReorder: vi.fn(() => false),
  readEnvironmentSupportsSettlement: vi.fn(() => false),
  readEnvironmentSupportsSnooze: vi.fn(() => false),
  readEnvironmentThreadRefs: vi.fn(() => []),
  readProject: vi.fn(() => null),
  readThreadShell: mocks.readThreadShell,
  readThreadShells: vi.fn(() => []),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: <T>(
    selector: (state: { clearTerminalUiState: typeof mocks.clearTerminalUiState }) => T,
  ) => selector({ clearTerminalUiState: mocks.clearTerminalUiState }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: <T>(
    selector: (state: { markThreadVisited: typeof mocks.markThreadVisited }) => T,
  ) => selector({ markThreadVisited: mocks.markThreadVisited }),
}));
vi.mock("../worktreeCleanup", () => ({
  formatWorktreePathForDisplay: vi.fn((path: string) => path),
  getOrphanedWorktreePathForThread: vi.fn(() => null),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: vi.fn((input: unknown) => input),
  toastManager: { add: vi.fn() },
}));
vi.mock("./useSettings", () => ({
  useClientSettings: <T>(
    selector: (settings: {
      confirmThreadDelete: boolean;
      sidebarThreadSortOrder: "updated_at";
    }) => T,
  ) => selector({ confirmThreadDelete: false, sidebarThreadSortOrder: "updated_at" }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: vi.fn(() => mocks.archiveMutation),
}));
vi.mock("@t3tools/client-runtime/state/thread-settled", () => ({
  canSettle: vi.fn(() => true),
  canSnooze: vi.fn(() => true),
  threadWokeAt: vi.fn(() => null),
}));

import {
  requestThreadUnpinConfirmation,
  ThreadArchiveBlockedError,
  useThreadActions,
} from "./useThreadActions";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

function renderThreadActions(): ReturnType<typeof useThreadActions> {
  let actions: ReturnType<typeof useThreadActions> | undefined;

  function Probe() {
    actions = useThreadActions();
    return null;
  }

  renderToStaticMarkup(createElement(Probe));
  if (actions === undefined) {
    throw new Error("Thread actions did not render.");
  }
  return actions;
}
describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(error.message).toBe("Cannot archive a running thread.");
  });
});

describe("archive draft uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readThreadShell.mockReturnValue({
      environmentId: threadRef.environmentId,
      id: threadRef.threadId,
      projectId: ProjectId.make("project-1"),
      session: null,
    });
  });

  it("releases pending draft uploads after archive succeeds", async () => {
    mocks.archiveMutation.mockResolvedValue({ _tag: "Success", value: undefined });

    const result = await renderThreadActions().archiveThread(threadRef);

    expect(result._tag).toBe("Success");
    expect(mocks.releaseComposerDraftUploads).toHaveBeenCalledOnce();
    expect(mocks.releaseComposerDraftUploads).toHaveBeenCalledWith(threadRef);
  });

  it("keeps pending draft uploads when archive fails", async () => {
    mocks.archiveMutation.mockResolvedValue({ _tag: "Failure", cause: new Error("offline") });

    const result = await renderThreadActions().archiveThread(threadRef);

    expect(result._tag).toBe("Failure");
    expect(mocks.releaseComposerDraftUploads).not.toHaveBeenCalled();
  });
});

describe("requestThreadUnpinConfirmation", () => {
  it("skips the dialog when confirmation is disabled", async () => {
    let callCount = 0;
    const result = await requestThreadUnpinConfirmation({
      enabled: false,
      title: "Pinned thread",
      confirm: async () => {
        callCount += 1;
        return false;
      },
    });

    expect(result).toMatchObject({ _tag: "Success", value: true });
    expect(callCount).toBe(0);
  });

  it("degrades gracefully when dialogs are unavailable", async () => {
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: "Pinned thread",
      confirm: null,
    });

    expect(result).toMatchObject({ _tag: "Success", value: true });
  });

  it("uses the thread title and returns the user's decision", async () => {
    let message = "";
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: "Release prep",
      confirm: async (nextMessage) => {
        message = nextMessage;
        return false;
      },
    });

    expect(message).toBe(
      'Unpin thread "Release prep"?\nThis will move the thread out of your pinned section.',
    );
    expect(result).toMatchObject({ _tag: "Success", value: false });
  });

  it("keeps dialog failures observable", async () => {
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: "Pinned thread",
      confirm: () => Promise.reject(new Error("dialog unavailable")),
    });

    expect(result._tag).toBe("Failure");
  });
});
