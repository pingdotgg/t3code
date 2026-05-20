import { QueryClient } from "@tanstack/react-query";
import {
  CommandId,
  EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadDetailPageInfo,
  type OrchestrationThreadDetailSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSubscribeThread = vi.fn();
const mockThreadUnsubscribe = vi.fn();
const mockProbeSync = vi.fn();
const mockReplayEvents = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn();
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();
const mockGetPrimaryKnownEnvironment = vi.hoisted(() => vi.fn());
const mockFetchRemoteSessionState = vi.fn();
const mockConnectionReconnects: Array<ReturnType<typeof vi.fn>> = [];
let savedEnvironmentRegistryListener: (() => void) | null = null;

function MockWsTransport() {
  return undefined;
}

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: mockGetPrimaryKnownEnvironment,
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: vi.fn(),
  fetchRemoteEnvironmentDescriptor: vi.fn(),
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError: vi.fn(() => false),
  resolveRemoteWebSocketConnectionUrl: vi.fn(async () => "ws://remote.example.test/ws"),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: mockGetSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: vi.fn(),
  readSavedEnvironmentBearerToken: mockReadSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    subscribe: mockSavedEnvironmentRegistrySubscribe,
    getState: () => ({
      upsert: vi.fn(),
      remove: vi.fn(),
      markConnected: vi.fn(),
      rename: vi.fn(),
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
      },
    ],
  };
}

function makeStuckRunningThreadShellSnapshot(params: {
  readonly snapshotSequence: number;
  readonly threadId: ThreadId;
}): OrchestrationShellSnapshot {
  // Simulates the iOS PWA gap state: the server's `thread.turn-diff-completed`
  // event reached the client (so latestTurn has a completedAt for T1) but the
  // matching `thread.session-set` that clears activeTurnId did not. The
  // session still claims it owns the same completed turn — the exact state
  // the safety net in hasActiveSessionWork is designed to mask. Recovery
  // (re-fetching the thread detail) is what removes the underlying staleness.
  const turnId = TurnId.make("turn-1");
  const snapshot = makeThreadShellSnapshot({
    threadId: params.threadId,
    sessionStatus: "running",
  });
  const thread = snapshot.threads[0];
  if (!thread) {
    throw new Error("Expected test shell snapshot to include one thread.");
  }
  return {
    ...snapshot,
    snapshotSequence: params.snapshotSequence,
    threads: [
      {
        ...thread,
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-04-13T00:00:00.000Z",
          startedAt: "2026-04-13T00:00:01.000Z",
          completedAt: "2026-04-13T00:00:02.000Z",
          assistantMessageId: null,
        },
        updatedAt: "2026-04-13T00:00:02.000Z",
        session: thread.session
          ? {
              ...thread.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: "2026-04-13T00:00:00.000Z",
            }
          : null,
      },
    ],
  };
}

function makeCompletedThreadShellSnapshot(params: {
  readonly snapshotSequence: number;
  readonly threadId: ThreadId;
  readonly sessionStatus?: "idle" | "ready" | "stopped";
}): OrchestrationShellSnapshot {
  const turnId = TurnId.make("turn-1");
  const snapshot = makeThreadShellSnapshot({
    threadId: params.threadId,
    sessionStatus: params.sessionStatus ?? "ready",
  });
  const thread = snapshot.threads[0];

  if (!thread) {
    throw new Error("Expected test shell snapshot to include one thread.");
  }

  return {
    ...snapshot,
    snapshotSequence: params.snapshotSequence,
    threads: [
      {
        ...thread,
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-04-13T00:00:00.000Z",
          startedAt: "2026-04-13T00:00:01.000Z",
          completedAt: "2026-04-13T00:00:02.000Z",
          assistantMessageId: null,
        },
        updatedAt: "2026-04-13T00:00:02.000Z",
        session: thread.session
          ? {
              ...thread.session,
              status: params.sessionStatus ?? "ready",
              activeTurnId: null,
              updatedAt: "2026-04-13T00:00:02.000Z",
            }
          : null,
      },
    ],
  };
}

function makeThreadDetailSnapshot(params: {
  readonly snapshotSequence: number;
  readonly threadId: ThreadId;
  readonly updatedAt?: string;
  readonly messages?: OrchestrationThread["messages"];
  readonly pageInfo?: OrchestrationThreadDetailPageInfo;
  readonly sessionStatus?:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error";
}): OrchestrationThreadDetailSnapshot {
  const shellThread = makeThreadShellSnapshot({
    threadId: params.threadId,
    ...(params.sessionStatus !== undefined ? { sessionStatus: params.sessionStatus } : {}),
  }).threads[0];

  if (!shellThread) {
    throw new Error("Expected test shell snapshot to include one thread.");
  }

  return {
    snapshotSequence: params.snapshotSequence,
    thread: {
      ...shellThread,
      updatedAt: params.updatedAt ?? shellThread.updatedAt,
      deletedAt: null,
      messages: params.messages ?? [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session:
        params.updatedAt && shellThread.session
          ? {
              ...shellThread.session,
              updatedAt: params.updatedAt,
            }
          : shellThread.session,
    },
    pageInfo: params.pageInfo ?? EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
  };
}

function makeThreadSessionSetEvent(params: {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly status: "idle" | "ready" | "running";
  readonly occurredAt?: string;
}): Extract<OrchestrationEvent, { type: "thread.session-set" }> {
  const occurredAt = params.occurredAt ?? `2026-04-13T00:00:0${params.sequence}.000Z`;
  const turnId = TurnId.make("turn-1");

  return {
    sequence: params.sequence,
    eventId: EventId.make(`event-session-set-${params.sequence}`),
    aggregateKind: "thread",
    aggregateId: params.threadId,
    occurredAt,
    commandId: CommandId.make(`command-session-set-${params.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.session-set",
    payload: {
      threadId: params.threadId,
      session: {
        threadId: params.threadId,
        status: params.status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: params.status === "running" ? turnId : null,
        lastError: null,
        updatedAt: occurredAt,
      },
    },
  };
}

function makeThreadDeletedEvent(params: {
  readonly sequence: number;
  readonly threadId: ThreadId;
}): Extract<OrchestrationEvent, { type: "thread.deleted" }> {
  const occurredAt = `2026-04-13T00:00:0${params.sequence}.000Z`;

  return {
    sequence: params.sequence,
    eventId: EventId.make(`event-thread-deleted-${params.sequence}`),
    aggregateKind: "thread",
    aggregateId: params.threadId,
    occurredAt,
    commandId: CommandId.make(`command-thread-deleted-${params.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.deleted",
    payload: {
      threadId: params.threadId,
      deletedAt: occurredAt,
    },
  };
}

function makeThreadArchivedEvent(params: {
  readonly sequence: number;
  readonly threadId: ThreadId;
}): Extract<OrchestrationEvent, { type: "thread.archived" }> {
  const occurredAt = `2026-04-13T00:00:0${params.sequence}.000Z`;

  return {
    sequence: params.sequence,
    eventId: EventId.make(`event-thread-archived-${params.sequence}`),
    aggregateKind: "thread",
    aggregateId: params.threadId,
    occurredAt,
    commandId: CommandId.make(`command-thread-archived-${params.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.archived",
    payload: {
      threadId: params.threadId,
      archivedAt: occurredAt,
      updatedAt: occurredAt,
    },
  };
}

describe("retainThreadDetailSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mockSubscribeThread.mockReset();
    mockThreadUnsubscribe.mockReset();
    mockProbeSync.mockReset();
    mockReplayEvents.mockReset();
    mockCreateEnvironmentConnection.mockReset();
    mockCreateWsRpcClient.mockReset();
    mockWaitForSavedEnvironmentRegistryHydration.mockReset();
    mockListSavedEnvironmentRecords.mockReset();
    mockGetSavedEnvironmentRecord.mockReset();
    mockReadSavedEnvironmentBearerToken.mockReset();
    mockSavedEnvironmentRegistrySubscribe.mockReset();
    mockGetPrimaryKnownEnvironment.mockReset();
    mockFetchRemoteSessionState.mockReset();
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
      },
      environmentId: EnvironmentId.make("env-1"),
    });

    mockThreadUnsubscribe.mockImplementation(() => undefined);
    mockSubscribeThread.mockImplementation(() => mockThreadUnsubscribe);
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => true),
      orchestration: {
        subscribeThread: mockSubscribeThread,
        probeSync: mockProbeSync,
        replayEvents: mockReplayEvents,
      },
    });
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      const reconnect = vi.fn(async () => undefined);
      mockConnectionReconnects.push(reconnect);
      return {
        kind: input.kind,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: vi.fn(async () => undefined),
        reconnect,
        dispose: vi.fn(async () => undefined),
      };
    });
    savedEnvironmentRegistryListener = null;
    mockSavedEnvironmentRegistrySubscribe.mockImplementation((listener: () => void) => {
      savedEnvironmentRegistryListener = listener;
      return () => {
        if (savedEnvironmentRegistryListener === listener) {
          savedEnvironmentRegistryListener = null;
        }
      };
    });
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockListSavedEnvironmentRecords.mockReturnValue([]);
    mockGetSavedEnvironmentRecord.mockReturnValue(null);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockFetchRemoteSessionState.mockResolvedValue({
      authenticated: true,
      role: "client",
    });
    mockConnectionReconnects.length = 0;
    mockProbeSync.mockResolvedValue({
      clientSequence: 1,
      serverSequence: 1,
      behind: false,
    });
    mockReplayEvents.mockResolvedValue([]);
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    vi.unstubAllGlobals();
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

  it("does not start the primary connection until the known environment has an id", async () => {
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
      },
    });
    const {
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());

    expect(mockCreateEnvironmentConnection).not.toHaveBeenCalled();
    expect(listEnvironmentConnections()).toEqual([]);

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

  it("recovers shell sequence gaps through orchestration replay", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-gap-recovery");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    mockReplayEvents.mockResolvedValueOnce([
      makeThreadSessionSetEvent({ sequence: 2, threadId, status: "idle" }),
      makeThreadDeletedEvent({ sequence: 3, threadId }),
    ]);

    connectionInput.applyShellEvent(
      {
        kind: "thread-removed",
        sequence: 3,
        threadId,
      },
      environmentId,
    );

    await vi.waitFor(() => {
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
      expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes retained thread detail when a shell event advances beyond the detail snapshot", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stale-detail");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const detailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((item: {
          readonly kind: "snapshot";
          readonly snapshot: ReturnType<typeof makeThreadDetailSnapshot>;
        }) => void)
      | undefined;
    expect(detailListener).toBeDefined();
    detailListener?.({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "ready",
      }),
    });

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

    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => {
      expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
      expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not let stale thread detail events regress newer shell state", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stale-detail-event");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeCompletedThreadShellSnapshot({
        snapshotSequence: 2,
        threadId,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const detailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((item: {
          readonly kind: "event";
          readonly event: Extract<OrchestrationEvent, { type: "thread.session-set" }>;
        }) => void)
      | undefined;
    expect(detailListener).toBeDefined();
    detailListener?.({
      kind: "event",
      event: makeThreadSessionSetEvent({
        sequence: 1,
        threadId,
        status: "running",
        occurredAt: "2026-04-13T00:00:03.000Z",
      }),
    });

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));

    expect(thread?.session?.status).toBe("ready");
    expect(thread?.latestTurn?.state).toBe("completed");

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not let stale thread detail snapshots regress newer shell state", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stale-detail-snapshot");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeCompletedThreadShellSnapshot({
        snapshotSequence: 2,
        threadId,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const detailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((item: {
          readonly kind: "snapshot";
          readonly snapshot: ReturnType<typeof makeThreadDetailSnapshot>;
        }) => void)
      | undefined;
    expect(detailListener).toBeDefined();
    detailListener?.({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
        updatedAt: "2026-04-13T00:00:03.000Z",
        messages: [
          {
            id: MessageId.make("assistant-message-1"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-13T00:00:02.000Z",
            updatedAt: "2026-04-13T00:00:03.000Z",
          },
        ],
      }),
    });

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));

    expect(thread?.session?.status).toBe("ready");
    expect(thread?.latestTurn?.state).toBe("completed");
    expect(thread?.messages.map((message) => message.text)).toEqual(["done"]);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("accepts thread detail shell fields when the snapshot is at the current projection sequence", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-current-detail-snapshot");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const completedThread = makeCompletedThreadShellSnapshot({
      snapshotSequence: 1,
      threadId,
    }).threads[0];
    expect(completedThread).toBeDefined();

    const detailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((item: {
          readonly kind: "snapshot";
          readonly snapshot: ReturnType<typeof makeThreadDetailSnapshot>;
        }) => void)
      | undefined;
    expect(detailListener).toBeDefined();
    detailListener?.({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: {
          ...completedThread!,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
        },
        pageInfo: EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
      },
    });

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));

    expect(thread?.session?.status).toBe("ready");
    expect(thread?.latestTurn?.state).toBe("completed");

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("stores thread detail pagination cursors from subscription snapshots", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectEnvironmentState, selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-page-info");
    const pageInfo: OrchestrationThreadDetailPageInfo = {
      ...EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
      messages: {
        hasMoreBefore: true,
        startCursor: {
          id: "message-10",
          createdAt: "2026-04-13T00:00:10.000Z",
        },
      },
    };

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const detailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((item: {
          readonly kind: "snapshot";
          readonly snapshot: ReturnType<typeof makeThreadDetailSnapshot>;
        }) => void)
      | undefined;
    expect(detailListener).toBeDefined();
    detailListener?.({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        pageInfo,
      }),
    });

    const state = useStore.getState();
    const thread = selectThreadByRef(state, scopeThreadRef(environmentId, threadId));
    const environmentState = selectEnvironmentState(state, environmentId);

    expect(thread?.detailPageInfo).toEqual(pageInfo);
    expect(environmentState.threadDetailPageInfoByThreadId[threadId]).toEqual(pageInfo);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes a warm idle detail subscription when active re-entry finds it behind shell", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-warm-reentry");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );

    const releaseWarm = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    const detailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((item: {
          readonly kind: "snapshot";
          readonly snapshot: ReturnType<typeof makeThreadDetailSnapshot>;
        }) => void)
      | undefined;
    expect(detailListener).toBeDefined();
    detailListener?.({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "ready",
      }),
    });
    releaseWarm();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeCompletedThreadShellSnapshot({
          snapshotSequence: 2,
          threadId,
          sessionStatus: "idle",
        }).threads[0]!,
      },
      environmentId,
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const releaseActive = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => {
      expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
      expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    });

    releaseActive();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps a warm detail subscription attached on active re-entry when it is caught up", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-warm-current-reentry");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "idle",
      }),
      environmentId,
    );

    const releaseWarm = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    const detailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((item: {
          readonly kind: "snapshot";
          readonly snapshot: ReturnType<typeof makeThreadDetailSnapshot>;
        }) => void)
      | undefined;
    expect(detailListener).toBeDefined();
    detailListener?.({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "idle",
      }),
    });
    releaseWarm();

    const releaseActive = retainThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseActive();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes retained thread detail when browser resume replay advances the thread", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const {
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-resume-detail");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    mockProbeSync.mockResolvedValueOnce({
      clientSequence: 1,
      serverSequence: 2,
      behind: true,
    });
    mockReplayEvents.mockResolvedValueOnce([makeThreadArchivedEvent({ sequence: 2, threadId })]);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
    });
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => {
      expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
      expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("periodically reconciles a retained active thread that missed completion events", async () => {
    const {
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-reconcile");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    mockProbeSync.mockResolvedValueOnce({
      clientSequence: 1,
      serverSequence: 2,
      behind: true,
    });
    mockReplayEvents.mockResolvedValueOnce([
      makeThreadSessionSetEvent({
        sequence: 2,
        threadId,
        status: "ready",
      }),
    ]);

    await vi.advanceTimersByTimeAsync(5_000);

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
    });

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.session?.status).toBe("ready");
    expect(thread?.session?.activeTurnId).toBeUndefined();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes a retained active thread detail subscription when the initial snapshot stalls", async () => {
    const {
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-initial-snapshot-stalled");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);

    await vi.waitFor(() => {
      expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
      expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reattaches retained thread detail subscriptions after a saved environment reconnect replaces the client", async () => {
    const environmentId = EnvironmentId.make("env-remote");
    const threadId = ThreadId.make("thread-reconnect");
    const record = {
      environmentId,
      label: "Remote env",
      httpBaseUrl: "http://remote.example.test",
      wsBaseUrl: "ws://remote.example.test",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastConnectedAt: "2026-05-01T00:00:00.000Z",
    };
    mockListSavedEnvironmentRecords.mockReturnValue([record]);
    mockGetSavedEnvironmentRecord.mockReturnValue(record);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");

    const {
      disconnectSavedEnvironment,
      listEnvironmentConnections,
      reconnectSavedEnvironment,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    savedEnvironmentRegistryListener?.();
    await vi.waitFor(() => {
      expect(mockCreateEnvironmentConnection).toHaveBeenCalledTimes(2);
      expect(
        listEnvironmentConnections().some(
          (connection) => connection.environmentId === environmentId,
        ),
      ).toBe(true);
    });

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await disconnectSavedEnvironment(environmentId);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(
      listEnvironmentConnections().some((connection) => connection.environmentId === environmentId),
    ).toBe(false);

    const reconnectPromise = reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(200);
    await reconnectPromise;
    await vi.waitFor(() => {
      expect(mockCreateEnvironmentConnection).toHaveBeenCalledTimes(3);
      expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconciles the primary environment cursor when the browser resumes", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-primary-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
    });
    expect(mockReplayEvents).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("probes the backend cursor on browser resume and skips replay when current", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-current-probe-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
    });
    expect(mockReplayEvents).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("force-refreshes a retained thread detail when browser resume finds it stuck in a completed-but-running turn", async () => {
    // Regression guard for the iOS PWA "Working for …" indicator that
    // refused to clear after foregrounding. Backgrounding silently drops
    // the `thread.session-set` event that closes a turn while still
    // delivering `thread.turn-diff-completed`, leaving the projection
    // with activeTurnId pointing at the same turnId latestTurn already
    // marks completedAt for. Even when the post-resume probe says "not
    // behind", the runtime must re-fetch the thread detail so the stuck
    // session reconciles to the server's real state.
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const {
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stuck-running-resume");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    // Push the projection into the gap state: latestTurn shows turn-1
    // completedAt, but the session still claims activeTurnId = turn-1
    // with orchestrationStatus running.
    connectionInput.syncShellSnapshot(
      makeStuckRunningThreadShellSnapshot({
        snapshotSequence: 2,
        threadId,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    // Probe says we're caught up (the gap is invisible at the sequence
    // level). The runtime must still observe the stuck-running shape and
    // force a re-subscription so the new snapshot can converge state.
    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 2 });
    });
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => {
      expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
      expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    });
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("replays from the current cursor when the browser resume probe reports the backend is ahead", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockProbeSync.mockResolvedValueOnce({
      clientSequence: 1,
      serverSequence: 2,
      behind: true,
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-behind-probe-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );
    mockReplayEvents.mockResolvedValueOnce([
      makeThreadSessionSetEvent({
        sequence: 2,
        threadId,
        status: "ready",
      }),
    ]);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
    });
    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.session?.status).toBe("ready");
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not reconcile on foreground focus without a prior background signal", async () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      visibilityState: "visible",
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-primary-focus-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    windowTarget.dispatchEvent(new Event("focus"));

    await vi.advanceTimersByTimeAsync(0);
    expect(mockProbeSync).not.toHaveBeenCalled();
    expect(mockReplayEvents).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconciles a retained thread on foreground focus without a prior background signal", async () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      visibilityState: "visible",
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const {
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-primary-focus-visible-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );
    const release = retainThreadDetailSubscription(environmentId, threadId);
    mockProbeSync.mockResolvedValueOnce({
      clientSequence: 1,
      serverSequence: 2,
      behind: true,
    });
    mockReplayEvents.mockResolvedValueOnce([
      makeThreadSessionSetEvent({
        sequence: 2,
        threadId,
        status: "ready",
      }),
    ]);

    windowTarget.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
    });
    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.session?.status).toBe("ready");
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not reconnect a retained thread on foreground focus when the backend cursor is current", async () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      visibilityState: "visible",
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const {
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-primary-focus-current");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );
    const release = retainThreadDetailSubscription(environmentId, threadId);

    windowTarget.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
    });
    expect(mockReplayEvents).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not reconcile on normal pageshow without a prior background signal", async () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      visibilityState: "visible",
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-primary-pageshow-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    windowTarget.dispatchEvent(new Event("pageshow"));

    await vi.advanceTimersByTimeAsync(0);
    expect(mockProbeSync).not.toHaveBeenCalled();
    expect(mockReplayEvents).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconciles a retained thread on normal pageshow without a prior background signal", async () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      visibilityState: "visible",
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const {
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-primary-pageshow-visible-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );
    const release = retainThreadDetailSubscription(environmentId, threadId);
    mockProbeSync.mockResolvedValueOnce({
      clientSequence: 1,
      serverSequence: 2,
      behind: true,
    });
    mockReplayEvents.mockResolvedValueOnce([
      makeThreadSessionSetEvent({
        sequence: 2,
        threadId,
        status: "ready",
      }),
    ]);

    windowTarget.dispatchEvent(new Event("pageshow"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
    });
    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.session?.status).toBe("ready");
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconciles the primary environment cursor after bfcache pageshow", async () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      visibilityState: "visible",
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-primary-bfcache-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const pageshow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageshow, "persisted", { value: true });
    windowTarget.dispatchEvent(pageshow);

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
    });
    expect(mockReplayEvents).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconciles the primary environment cursor after pagehide and pageshow", async () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      visibilityState: "visible",
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-primary-pagehide-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    windowTarget.dispatchEvent(new Event("pagehide"));
    windowTarget.dispatchEvent(new Event("pageshow"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
    });
    expect(mockReplayEvents).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconciles saved environment cursors when the browser resumes", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const environmentId = EnvironmentId.make("env-remote");
    const record = {
      environmentId,
      label: "Remote env",
      httpBaseUrl: "http://remote.example.test",
      wsBaseUrl: "ws://remote.example.test",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastConnectedAt: "2026-05-01T00:00:00.000Z",
    };
    mockListSavedEnvironmentRecords.mockReturnValue([record]);
    mockGetSavedEnvironmentRecord.mockReturnValue(record);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");

    const {
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    savedEnvironmentRegistryListener?.();
    await vi.waitFor(() => {
      expect(mockCreateEnvironmentConnection).toHaveBeenCalledTimes(2);
      expect(
        listEnvironmentConnections().some(
          (connection) => connection.environmentId === environmentId,
        ),
      ).toBe(true);
    });
    const primaryConnectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    const savedConnectionInput = mockCreateEnvironmentConnection.mock.calls[1]?.[0];
    expect(primaryConnectionInput).toBeDefined();
    expect(savedConnectionInput).toBeDefined();
    primaryConnectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId: ThreadId.make("thread-primary-saved-resume"),
        sessionStatus: "ready",
      }),
      EnvironmentId.make("env-1"),
    );
    savedConnectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId: ThreadId.make("thread-saved-resume"),
        sessionStatus: "ready",
      }),
      environmentId,
    );

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[1]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledTimes(2);
    });
    expect(mockProbeSync).toHaveBeenNthCalledWith(1, { clientSequence: 1 });
    expect(mockProbeSync).toHaveBeenNthCalledWith(2, { clientSequence: 1 });
    expect(mockReplayEvents).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[1]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconnects when browser resume reconciliation fails", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => true),
      orchestration: {
        subscribeThread: mockSubscribeThread,
        probeSync: mockProbeSync,
        replayEvents: mockReplayEvents,
      },
    });
    mockProbeSync.mockResolvedValueOnce({
      clientSequence: 1,
      serverSequence: 2,
      behind: true,
    });
    mockReplayEvents.mockRejectedValueOnce(new Error("stale stream"));

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stale-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconnects when the browser resume sync probe fails", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockProbeSync.mockRejectedValueOnce(new Error("stale socket"));

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stale-probe-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    expect(mockReplayEvents).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconnects immediately on browser resume when the heartbeat is stale", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => false),
      orchestration: {
        subscribeThread: mockSubscribeThread,
        probeSync: mockProbeSync,
        replayEvents: mockReplayEvents,
      },
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stale-heartbeat-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    expect(mockProbeSync).not.toHaveBeenCalled();
    expect(mockReplayEvents).not.toHaveBeenCalled();

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

    for (let index = 0; index < 12; index += 1) {
      const release = retainThreadDetailSubscription(
        environmentId,
        ThreadId.make(`thread-${index + 1}`),
      );
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

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-2");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    release();

    await resetEnvironmentServiceForTests();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
  });
});
