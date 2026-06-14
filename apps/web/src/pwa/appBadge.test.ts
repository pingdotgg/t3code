import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore, type AppState, type EnvironmentState } from "../store";
import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import {
  __resetPwaAppBadgeSyncForTests,
  canUseAppBadge,
  installPwaAppBadgeSync,
  resyncAppBadge,
  writeAppBadgeCount,
} from "./appBadge";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-local");

function makeEnvironmentState(threads: readonly SidebarThreadSummary[]): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: threads.map((thread) => thread.id),
    threadIdsByProjectId: {},
    threadShellById: {},
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
    sidebarThreadSummaryById: Object.fromEntries(threads.map((thread) => [thread.id, thread])),
    bootstrapComplete: true,
  };
}

function makeCompletedThread(id: string, completedAt: string): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title: id,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: completedAt,
    archivedAt: null,
    latestTurn: { completedAt } as SidebarThreadSummary["latestTurn"],
    branch: null,
    worktreePath: null,
    latestUserMessageAt: completedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function setBadgeStoreState(
  threads: readonly SidebarThreadSummary[],
  threadLastVisitedAtById: Record<string, string> = {},
): void {
  useStore.setState({
    activeEnvironmentId: environmentId,
    environmentStateById: {
      [environmentId]: makeEnvironmentState(threads),
    },
    accountRateLimitsByInstanceId: {},
  } satisfies AppState);
  useUiStateStore.setState({
    threadLastVisitedAtById,
  });
}

function resetBadgeStoreState(): void {
  useStore.setState({
    activeEnvironmentId: null,
    environmentStateById: {},
    accountRateLimitsByInstanceId: {},
  } satisfies AppState);
  useUiStateStore.setState({
    threadLastVisitedAtById: {},
  });
}

function createDocumentStub(visibilityState: DocumentVisibilityState) {
  const target = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
  Object.defineProperty(target, "visibilityState", {
    configurable: true,
    value: visibilityState,
  });
  return target;
}

function setDocumentVisibility(
  documentStub: EventTarget & { visibilityState: DocumentVisibilityState },
  visibilityState: DocumentVisibilityState,
): void {
  Object.defineProperty(documentStub, "visibilityState", {
    configurable: true,
    value: visibilityState,
  });
}

function createPushWindowStub(): EventTarget & {
  isSecureContext: boolean;
  PushManager: unknown;
  Notification: unknown;
} {
  const target = new EventTarget() as EventTarget & {
    isSecureContext: boolean;
    PushManager: unknown;
    Notification: unknown;
  };
  target.isSecureContext = true;
  target.PushManager = function PushManager() {};
  target.Notification = function Notification() {};
  return target;
}

function makeDisplayedNotification(tag: string): Pick<Notification, "tag"> {
  return { tag };
}

function installBadgeGlobals(
  input: {
    readonly displayedNotifications?: readonly Pick<Notification, "tag">[];
    readonly getRegistration?: () => Promise<unknown>;
    readonly visibilityState?: DocumentVisibilityState;
  } = {},
) {
  let displayedNotifications = input.displayedNotifications ?? [];
  const getRegistration = vi.fn(
    input.getRegistration ??
      (async () => ({
        getNotifications: async () => displayedNotifications,
      })),
  );
  const navigatorLike = {
    setAppBadge: vi.fn(async () => {}),
    clearAppBadge: vi.fn(async () => {}),
    serviceWorker: { getRegistration },
  };
  const windowStub = createPushWindowStub();
  const documentStub = createDocumentStub(input.visibilityState ?? "visible");
  vi.stubGlobal("navigator", navigatorLike);
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", documentStub);
  return {
    navigatorLike,
    windowStub,
    documentStub,
    getRegistration,
    setDisplayedNotifications: (next: readonly Pick<Notification, "tag">[]) => {
      displayedNotifications = next;
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flushBadgeSync(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  __resetPwaAppBadgeSyncForTests();
  resetBadgeStoreState();
});

afterEach(() => {
  __resetPwaAppBadgeSyncForTests();
  resetBadgeStoreState();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("canUseAppBadge", () => {
  it("requires setAppBadge support", () => {
    expect(canUseAppBadge({ setAppBadge: vi.fn() })).toBe(true);
    expect(canUseAppBadge({ clearAppBadge: vi.fn() })).toBe(false);
    expect(canUseAppBadge(null)).toBe(false);
  });
});

describe("writeAppBadgeCount", () => {
  it("sets a positive badge count", async () => {
    const navigatorLike = {
      setAppBadge: vi.fn(async () => {}),
      clearAppBadge: vi.fn(async () => {}),
    };

    await expect(writeAppBadgeCount(3, navigatorLike)).resolves.toBe(true);

    expect(navigatorLike.setAppBadge).toHaveBeenCalledWith(3);
    expect(navigatorLike.clearAppBadge).not.toHaveBeenCalled();
  });

  it("clears the badge when count is zero", async () => {
    const navigatorLike = {
      setAppBadge: vi.fn(async () => {}),
      clearAppBadge: vi.fn(async () => {}),
    };

    await expect(writeAppBadgeCount(0, navigatorLike)).resolves.toBe(true);

    expect(navigatorLike.clearAppBadge).toHaveBeenCalledTimes(1);
    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
  });

  it("falls back to setAppBadge(0) when clearAppBadge is unavailable", async () => {
    const navigatorLike = {
      setAppBadge: vi.fn(async () => {}),
    };

    await expect(writeAppBadgeCount(0, navigatorLike)).resolves.toBe(true);

    expect(navigatorLike.setAppBadge).toHaveBeenCalledWith(0);
  });

  it("normalizes invalid and fractional counts", async () => {
    const navigatorLike = {
      setAppBadge: vi.fn(async () => {}),
      clearAppBadge: vi.fn(async () => {}),
    };

    await expect(writeAppBadgeCount(2.8, navigatorLike)).resolves.toBe(true);
    await expect(writeAppBadgeCount(Number.NaN, navigatorLike)).resolves.toBe(true);

    expect(navigatorLike.setAppBadge).toHaveBeenCalledWith(2);
    expect(navigatorLike.clearAppBadge).toHaveBeenCalledTimes(1);
  });
});

describe("installPwaAppBadgeSync", () => {
  it("clears completed-turn alerts on startup instead of restoring stale unseen thread state", async () => {
    const thread1 = makeCompletedThread("thread-1", "2026-06-12T12:00:00.000Z");
    const thread2 = makeCompletedThread("thread-2", "2026-06-12T12:01:00.000Z");
    setBadgeStoreState([thread1, thread2]);
    const { navigatorLike } = installBadgeGlobals({
      displayedNotifications: [makeDisplayedNotification("thread:thread-1:turn:turn-1")],
    });

    installPwaAppBadgeSync();
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(navigatorLike.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("clears the badge when displayed notifications are unavailable", async () => {
    const thread1 = makeCompletedThread("thread-1", "2026-06-12T12:00:00.000Z");
    const thread2 = makeCompletedThread("thread-2", "2026-06-12T12:01:00.000Z");
    setBadgeStoreState([thread1, thread2]);
    const { navigatorLike } = installBadgeGlobals({
      getRegistration: async () => null,
    });

    installPwaAppBadgeSync();
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(navigatorLike.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("re-syncs when displayed completed-turn notifications change", async () => {
    const thread1 = makeCompletedThread("thread-1", "2026-06-12T12:00:00.000Z");
    const thread2 = makeCompletedThread("thread-2", "2026-06-12T12:01:00.000Z");
    setBadgeStoreState([thread1, thread2]);
    const { navigatorLike, setDisplayedNotifications } = installBadgeGlobals({
      displayedNotifications: [makeDisplayedNotification("thread:thread-1:turn:turn-1")],
    });

    installPwaAppBadgeSync();
    await flushBadgeSync();
    navigatorLike.setAppBadge.mockClear();

    setDisplayedNotifications([
      makeDisplayedNotification("thread:thread-1:turn:turn-1"),
      makeDisplayedNotification("thread:thread-2:turn:turn-1"),
    ]);
    resyncAppBadge();
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).toHaveBeenCalledWith(2);
  });

  it("does not let stale async notification reads overwrite newer badge syncs", async () => {
    const thread1 = makeCompletedThread("thread-1", "2026-06-12T12:00:00.000Z");
    const thread2 = makeCompletedThread("thread-2", "2026-06-12T12:01:00.000Z");
    setBadgeStoreState([thread1, thread2]);
    const firstRegistration = createDeferred<unknown>();
    const secondRegistration = createDeferred<unknown>();
    const { navigatorLike, getRegistration } = installBadgeGlobals({
      getRegistration: vi
        .fn()
        .mockResolvedValueOnce({ getNotifications: async () => [] })
        .mockResolvedValueOnce({})
        .mockImplementationOnce(() => firstRegistration.promise)
        .mockImplementationOnce(() => secondRegistration.promise),
    });

    installPwaAppBadgeSync();
    await flushBadgeSync();
    expect(getRegistration).toHaveBeenCalledTimes(2);
    navigatorLike.clearAppBadge.mockClear();

    resyncAppBadge();
    await Promise.resolve();
    expect(getRegistration).toHaveBeenCalledTimes(3);

    resyncAppBadge();
    await Promise.resolve();
    expect(getRegistration).toHaveBeenCalledTimes(4);

    secondRegistration.resolve({
      getNotifications: async () => [makeDisplayedNotification("thread:thread-1:turn:turn-1")],
    });
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).toHaveBeenCalledWith(1);
    navigatorLike.setAppBadge.mockClear();

    firstRegistration.resolve({
      getNotifications: async () => [
        makeDisplayedNotification("thread:thread-1:turn:turn-1"),
        makeDisplayedNotification("thread:thread-2:turn:turn-1"),
      ],
    });
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(navigatorLike.clearAppBadge).not.toHaveBeenCalled();
  });

  it("clears completed-turn alerts on window focus", async () => {
    const thread = makeCompletedThread("thread-1", "2026-06-12T12:00:00.000Z");
    setBadgeStoreState([thread]);
    const { navigatorLike, windowStub } = installBadgeGlobals({
      displayedNotifications: [makeDisplayedNotification("thread:thread-1:turn:turn-1")],
    });

    installPwaAppBadgeSync();
    await flushBadgeSync();

    expect(navigatorLike.clearAppBadge).toHaveBeenCalledTimes(1);
    navigatorLike.clearAppBadge.mockClear();

    windowStub.dispatchEvent(new Event("focus"));
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(navigatorLike.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("clears completed-turn alerts when the document becomes visible", async () => {
    const thread = makeCompletedThread("thread-1", "2026-06-12T12:00:00.000Z");
    const threadKey = scopedThreadKey(scopeThreadRef(environmentId, thread.id));
    setBadgeStoreState([thread], {
      [threadKey]: "2026-06-12T11:59:00.000Z",
    });
    const { navigatorLike, documentStub } = installBadgeGlobals({
      displayedNotifications: [makeDisplayedNotification("thread:thread-1:turn:turn-1")],
      visibilityState: "hidden",
    });

    installPwaAppBadgeSync();
    await flushBadgeSync();
    navigatorLike.clearAppBadge.mockClear();

    documentStub.dispatchEvent(new Event("visibilitychange"));
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(navigatorLike.clearAppBadge).not.toHaveBeenCalled();

    setDocumentVisibility(documentStub, "visible");
    documentStub.dispatchEvent(new Event("visibilitychange"));
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(navigatorLike.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("allows callers to force a cache-bypassing re-sync", async () => {
    const thread = makeCompletedThread("thread-1", "2026-06-12T12:00:00.000Z");
    setBadgeStoreState([thread]);
    const { navigatorLike } = installBadgeGlobals({
      displayedNotifications: [makeDisplayedNotification("thread:thread-1:turn:turn-1")],
    });

    installPwaAppBadgeSync();
    await flushBadgeSync();
    navigatorLike.setAppBadge.mockClear();

    resyncAppBadge();
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).toHaveBeenCalledWith(1);
  });
});
