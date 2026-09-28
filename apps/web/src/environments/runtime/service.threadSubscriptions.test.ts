import { QueryClient } from "@tanstack/react-query";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSubscribeThread = vi.fn();
const mockThreadUnsubscribe = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();

function MockWsTransport() {
  return undefined;
}

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: vi.fn(() => ({
    id: "env-1",
    label: "Primary environment",
    source: "window-origin",
    target: {
      httpBaseUrl: "http://127.0.0.1:3000/",
      wsBaseUrl: "ws://127.0.0.1:3000/",
    },
    environmentId: EnvironmentId.make("env-1"),
  })),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: vi.fn(),
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: vi.fn(),
  readSavedEnvironmentBearerToken: vi.fn(),
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    subscribe: mockSavedEnvironmentRegistrySubscribe,
    getState: () => ({
      upsert: vi.fn(),
      remove: vi.fn(),
      markConnected: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: mockWaitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken: vi.fn(),
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: mockCreateWsRpcClient,
}));

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: MockWsTransport,
}));

function makeThreadShellSnapshot(params: {
  readonly threadId: ThreadId;
  readonly sessionStatus?:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error";
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
  readonly hasPendingQueuedTurn?: boolean;
}): OrchestrationShellSnapshot {
  const projectId = ProjectId.make("project-1");
  const turnId = TurnId.make("turn-1");

  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-04-13T00:00:00.000Z",
    threads: [
      {
        id: params.threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        pendingRuntimeMode: null,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn:
          params.sessionStatus === "running"
            ? {
                turnId,
                state: "running",
                requestedAt: "2026-04-13T00:00:00.000Z",
                startedAt: "2026-04-13T00:00:01.000Z",
                completedAt: null,
                assistantMessageId: null,
              }
            : null,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
        archivedAt: null,
        session: params.sessionStatus
          ? {
              threadId: params.threadId,
              status: params.sessionStatus,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: params.sessionStatus === "running" ? turnId : null,
              lastError: null,
              updatedAt: "2026-04-13T00:00:00.000Z",
            }
          : null,
        latestUserMessageAt: null,
        hasPendingApprovals: params.hasPendingApprovals ?? false,
        hasPendingUserInput: params.hasPendingUserInput ?? false,
        hasActionableProposedPlan: params.hasActionableProposedPlan ?? false,
        hasPendingQueuedTurn: params.hasPendingQueuedTurn ?? false,
      },
    ],
  };
}

function makeShellSnapshotForThreads(
  threadIds: ReadonlyArray<ThreadId>,
  snapshotSequence = 1,
): OrchestrationShellSnapshot {
  return {
    ...makeThreadShellSnapshot({ threadId: ThreadId.make("placeholder") }),
    snapshotSequence,
    threads: threadIds.flatMap((threadId) => makeThreadShellSnapshot({ threadId }).threads),
  };
}

function makeOrchestrationThread(threadId: ThreadId, title: string): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function metaUpdatedEvent(threadId: ThreadId, sequence: number, title: string): OrchestrationEvent {
  return {
    eventId: EventId.make(`event-${sequence}`),
    sequence,
    occurredAt: "2026-04-13T00:01:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.meta-updated",
    payload: {
      threadId,
      title,
      updatedAt: "2026-04-13T00:01:00.000Z",
    },
  };
}

describe("retainThreadDetailSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();

    mockThreadUnsubscribe.mockImplementation(() => undefined);
    mockSubscribeThread.mockImplementation(() => mockThreadUnsubscribe);
    mockCreateWsRpcClient.mockReturnValue({
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });
    mockCreateEnvironmentConnection.mockImplementation((input) => ({
      kind: input.kind,
      environmentId: input.knownEnvironment.environmentId,
      knownEnvironment: input.knownEnvironment,
      client: input.client,
      ensureBootstrapped: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    }));
    mockSavedEnvironmentRegistrySubscribe.mockReturnValue(() => undefined);
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockListSavedEnvironmentRecords.mockReturnValue([]);
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    vi.useRealTimers();
  });

  it("keeps thread detail subscriptions warm across releases until idle eviction", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);

    const releaseFirst = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    const releaseSecond = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(28 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("waits for the shell projection before opening a thread detail subscription", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-unprojected");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    // Subscribing before the thread is projected makes the server reject the
    // stream, which parks it permanently and leaves the chat frozen.
    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps retained thread detail subscriptions when a shell snapshot omits the thread", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-live");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);
    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([], 2), environmentId);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reports active thread work only while a retained thread is non-idle", async () => {
    const {
      hasActiveThreadDetailWork,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-work");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );
    expect(hasActiveThreadDetailWork()).toBe(false);

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(hasActiveThreadDetailWork()).toBe(true);

    release();
    expect(hasActiveThreadDetailWork()).toBe(false);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("resubscribes retained non-idle threads on stall repair", async () => {
    const {
      repairActiveThreadDetailSubscriptionsAfterStall,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const activeThreadId = ThreadId.make("thread-stall-active");
    const idleThreadId = ThreadId.make("thread-stall-idle");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId: idleThreadId, sessionStatus: "idle" }),
      environmentId,
    );
    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId: activeThreadId,
          sessionStatus: "running",
        }).threads[0]!,
      },
      environmentId,
    );

    const releaseActive = retainThreadDetailSubscription(environmentId, activeThreadId);
    const releaseIdle = retainThreadDetailSubscription(environmentId, idleThreadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(2);

    // A successful unary probe must still repair the zombie stream: the active
    // subscription is torn down and re-attached, while the idle one is untouched.
    const repair = repairActiveThreadDetailSubscriptionsAfterStall(environmentId);
    expect(repair).toEqual({ retained: 1, resubscribed: 1 });
    expect(mockSubscribeThread).toHaveBeenCalledTimes(3);

    releaseActive();
    releaseIdle();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("repairs retained-but-unattached subscriptions on reconnect without dropping them", async () => {
    const {
      retainThreadDetailSubscription,
      repairRetainedThreadDetailSubscriptionsAfterReconnect,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-repair");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    const repair = repairRetainedThreadDetailSubscriptionsAfterReconnect(environmentId);
    expect(repair.retained).toBe(1);
    expect(repair.reattached).toBe(0);

    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps non-idle thread detail subscriptions attached until the thread becomes idle", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
        hasPendingApprovals: true,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "idle",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("clears pending send status from shell turn acknowledgement", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");
    const { usePendingTurnStore } = await import("~/pendingTurnStore");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-pending-shell");
    const threadRef = { environmentId, threadId };
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "idle",
      }),
      environmentId,
    );
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }).threads[0]!,
      },
      environmentId,
    );

    expect(usePendingTurnStore.getState().pendingByThreadKey).toEqual({});

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("clears shared pending state for threads removed by shell snapshot sync", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");
    const { usePendingTurnStore } = await import("~/pendingTurnStore");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-removed-by-snapshot");
    const threadRef = { environmentId, threadId };
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    const initialSnapshot = makeThreadShellSnapshot({ threadId, sessionStatus: "idle" });
    connectionInput.syncShellSnapshot(initialSnapshot, environmentId);
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    usePendingTurnStore.getState().addOptimisticMessage(threadRef, {
      id: MessageId.make("message-1"),
      role: "user",
      text: "Ship it",
      createdAt: "2026-04-13T00:00:00.000Z",
      streaming: false,
    });

    connectionInput.syncShellSnapshot(
      {
        ...initialSnapshot,
        snapshotSequence: 2,
        threads: [],
      },
      environmentId,
    );

    expect(usePendingTurnStore.getState().pendingByThreadKey).toEqual({});
    expect(usePendingTurnStore.getState().optimisticMessagesByThreadKey).toEqual({});

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("clears shared pending state when a shell event removes the thread", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");
    const { usePendingTurnStore } = await import("~/pendingTurnStore");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-removed-by-event");
    const threadRef = { environmentId, threadId };
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "idle" }),
      environmentId,
    );
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    usePendingTurnStore.getState().addOptimisticMessage(threadRef, {
      id: MessageId.make("message-1"),
      role: "user",
      text: "Ship it",
      createdAt: "2026-04-13T00:00:00.000Z",
      streaming: false,
    });

    connectionInput.applyShellEvent(
      {
        kind: "thread-removed",
        sequence: 2,
        threadId,
      },
      environmentId,
    );

    expect(usePendingTurnStore.getState().pendingByThreadKey).toEqual({});
    expect(usePendingTurnStore.getState().optimisticMessagesByThreadKey).toEqual({});

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("allows a larger idle cache before capacity eviction starts", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadIds = Array.from({ length: 12 }, (_, index) =>
      ThreadId.make(`thread-${index + 1}`),
    );
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads(threadIds), environmentId);

    for (const threadId of threadIds) {
      const release = retainThreadDetailSubscription(environmentId, threadId);
      release();
    }

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("disposes cached thread detail subscriptions when the environment service resets", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectEnvironmentState, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-2");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);

    const release = retainThreadDetailSubscription(environmentId, threadId);
    release();

    const listener = mockSubscribeThread.mock.calls.at(-1)?.[1] as
      | ((item: OrchestrationThreadStreamItem) => void)
      | undefined;
    if (listener === undefined) {
      throw new Error("subscribeThread listener was not captured");
    }
    listener({
      kind: "snapshot",
      snapshot: { snapshotSequence: 10, thread: makeOrchestrationThread(threadId, "Hydrated") },
    });
    expect(
      selectEnvironmentState(useStore.getState(), environmentId).threadDetailHydratedById?.[
        threadId
      ],
    ).toBe(true);

    await resetEnvironmentServiceForTests();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(
      selectEnvironmentState(useStore.getState(), environmentId).threadDetailHydratedById?.[
        threadId
      ],
    ).toBeUndefined();

    stop();
  });

  it("applies streamed thread events immediately, then buffered bursts once", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stream");
    const threadRef = { environmentId, threadId };
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);

    retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    const listener = mockSubscribeThread.mock.calls.at(-1)?.[1] as
      | ((item: OrchestrationThreadStreamItem) => void)
      | undefined;
    if (listener === undefined) {
      throw new Error("subscribeThread listener was not captured");
    }

    listener({
      kind: "snapshot",
      snapshot: { snapshotSequence: 10, thread: makeOrchestrationThread(threadId, "Base title") },
    });
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("Base title");

    // The first event of a burst applies synchronously.
    listener({ kind: "event", event: metaUpdatedEvent(threadId, 11, "First title") });
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("First title");

    // Trailing burst events are held for the coalescing window.
    listener({ kind: "event", event: metaUpdatedEvent(threadId, 12, "Second title") });
    listener({ kind: "event", event: metaUpdatedEvent(threadId, 13, "Third title") });
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("First title");

    await vi.advanceTimersByTimeAsync(32);
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("Third title");

    // A snapshot flushes buffered events before replacing state.
    listener({ kind: "event", event: metaUpdatedEvent(threadId, 14, "Buffered title") });
    listener({
      kind: "snapshot",
      snapshot: { snapshotSequence: 15, thread: makeOrchestrationThread(threadId, "Snapshotted") },
    });
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("Snapshotted");

    stop();
    await resetEnvironmentServiceForTests();
  });
});
