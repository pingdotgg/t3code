import { EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  navigateAfterThreadDeletion,
  requestThreadUnpinConfirmation,
  ThreadArchiveBlockedError,
  useThreadActions,
} from "./useThreadActions";
import { toastManager } from "../components/ui/toast";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "../previewStateStore";
import { previewEnvironment } from "../state/preview";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";

const commands = vi.hoisted(() => ({
  closeTerminal: vi.fn(),
  closePreviews: vi.fn(),
  deleteThread: vi.fn(),
}));
const threadShell = vi.hoisted(() => ({
  id: "preview-thread",
  title: "Preview thread",
  projectId: "preview-project",
  environmentId: "preview-env",
  worktreePath: null,
  runtime: null,
}));
const readThreadShellMock = vi.hoisted(() => vi.fn());
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { matches: [{ params: {} }] } }),
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readThreadShell: readThreadShellMock,
  readEnvironmentThreadRefs: () => [],
  readProject: () => null,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case terminalEnvironment.close:
        return commands.closeTerminal;
      case previewEnvironment.close:
        return commands.closePreviews;
      case threadEnvironment.delete:
        return commands.deleteThread;
      default:
        return vi.fn();
    }
  },
}));

describe("navigateAfterThreadDeletion", () => {
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
    expect(error.message).toBe("Cannot archive while the provider is active.");
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

describe("deleteThread preview cleanup", () => {
  const target = {
    environmentId: EnvironmentId.make("preview-env"),
    threadId: ThreadId.make("preview-thread"),
  };
  const other = { ...target, threadId: ThreadId.make("other-thread") };
  const snapshot: PreviewSessionSnapshot = {
    threadId: target.threadId,
    tabId: "tab-a",
    navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Preview" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    resetPreviewStateForTests();
    readThreadShellMock.mockReset().mockReturnValue(threadShell);
    for (const command of Object.values(commands)) {
      command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    }
    applyPreviewServerSnapshot(target, snapshot);
    applyPreviewServerSnapshot(target, { ...snapshot, tabId: "tab-b" });
    applyPreviewServerSnapshot(other, { ...snapshot, threadId: other.threadId });
  });
  afterEach(() => {
    resetPreviewStateForTests();
    vi.restoreAllMocks();
  });

  it("closes every preview after terminals and forgets only the deleted thread's state", async () => {
    const otherState = readThreadPreviewState(other);
    const result = await useThreadActions().deleteThread(target);

    expect(result._tag).toBe("Success");
    expect(commands.closePreviews).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(commands.closeTerminal.mock.invocationCallOrder[0]).toBeLessThan(
      commands.closePreviews.mock.invocationCallOrder[0]!,
    );
    expect(commands.closePreviews.mock.invocationCallOrder[0]).toBeLessThan(
      commands.deleteThread.mock.invocationCallOrder[0]!,
    );
    expect(readThreadPreviewState(target).sessions).toEqual({});
    expect(readThreadPreviewState(other)).toBe(otherState);
  });

  it("keeps preview state when deleting the thread fails", async () => {
    const state = readThreadPreviewState(target);
    commands.deleteThread.mockResolvedValue({ _tag: "Failure", cause: new Error("delete failed") });

    const result = await useThreadActions().deleteThread(target);

    expect(result._tag).toBe("Failure");
    expect(readThreadPreviewState(target)).toBe(state);
    expect(Object.keys(readThreadPreviewState(target).sessions)).toEqual(["tab-a", "tab-b"]);
  });

  it("still deletes and clears state when closing previews fails", async () => {
    commands.closePreviews.mockResolvedValue({
      _tag: "Failure",
      cause: new Error("preview close failed"),
    });
    const addToast = vi.spyOn(toastManager, "add");

    const result = await useThreadActions().deleteThread(target);

    expect(result._tag).toBe("Success");
    expect(commands.deleteThread).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(readThreadPreviewState(target).sessions).toEqual({});
    expect(addToast).not.toHaveBeenCalled();
  });

  it.each(["Success", "Failure"] as const)(
    "retains archived-thread previews unless deletion returns Success (%s)",
    async (resultTag) => {
      readThreadShellMock.mockReturnValue(null);
      const state = readThreadPreviewState(target);
      commands.deleteThread.mockResolvedValue({ _tag: resultTag });

      const result = await useThreadActions().deleteThread(target);

      expect(result._tag).toBe(resultTag);
      expect(readThreadPreviewState(target).sessions).toEqual(
        resultTag === "Success" ? {} : state.sessions,
      );
    },
  );
});
