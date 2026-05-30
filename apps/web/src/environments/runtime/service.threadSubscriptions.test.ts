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
const mockReconcileThreadDetail = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn();
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();
const mockGetPrimaryKnownEnvironment = vi.hoisted(() => vi.fn());
const MockEnvironmentShellBootstrapTimeoutError = vi.hoisted(
  () =>
    class EnvironmentShellBootstrapTimeoutError extends Error {
      readonly environmentId: EnvironmentId;
      readonly timeoutMs: number;

      constructor(environmentId: EnvironmentId, timeoutMs: number) {
        super(
          `Environment ${environmentId} shell bootstrap timed out after ${timeoutMs.toString()}ms.`,
        );
        this.name = "EnvironmentShellBootstrapTimeoutError";
        this.environmentId = environmentId;
        this.timeoutMs = timeoutMs;
      }
    },
);
const mockIsEnvironmentShellBootstrapTimeoutError = vi.hoisted(() =>
  vi.fn((error: unknown) => error instanceof MockEnvironmentShellBootstrapTimeoutError),
);
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
  EnvironmentShellBootstrapTimeoutError: MockEnvironmentShellBootstrapTimeoutError,
  isEnvironmentShellBootstrapTimeoutError: mockIsEnvironmentShellBootstrapTimeoutError,
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
      queuedTurns: [],
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

type ThreadDetailSubscriptionTestItem =
  | {
      readonly kind: "snapshot";
      readonly snapshot: OrchestrationThreadDetailSnapshot;
    }
  | {
      readonly kind: "event";
      readonly event: OrchestrationEvent;
    };

function readThreadDetailSubscriptionListener(
  callIndex: number,
): (item: ThreadDetailSubscriptionTestItem) => void {
  const listener = mockSubscribeThread.mock.calls[callIndex]?.[1] as
    | ((item: ThreadDetailSubscriptionTestItem) => void)
    | undefined;
  expect(listener).toBeDefined();
  return listener!;
}

async function expectThreadDetailReconcileCallCount(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(mockReconcileThreadDetail).toHaveBeenCalledTimes(count);
  });
  expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function stubBrowserVisibility(
  initialState: DocumentVisibilityState = "visible",
  options: { readonly localStorage?: Storage } = {},
) {
  let visibilityState = initialState;
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
    ...(options.localStorage ? { localStorage: options.localStorage } : {}),
  });

  return {
    documentTarget,
    windowTarget,
    setVisibilityState(nextState: DocumentVisibilityState) {
      visibilityState = nextState;
    },
  };
}

function makeThreadDetailReconcileSnapshotResult(
  snapshot: OrchestrationThreadDetailSnapshot,
  reason:
    | "missing-client-verification"
    | "unverified-client-cursor"
    | "fingerprint-mismatch"
    | "too-many-events" = "fingerprint-mismatch",
) {
  return {
    kind: "snapshot" as const,
    reason,
    serverSequence: snapshot.snapshotSequence,
    serverFingerprint: { version: 1 as const, value: `fingerprint-${snapshot.snapshotSequence}` },
    snapshot,
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

function makeThreadCreatedEvent(params: {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
}): Extract<OrchestrationEvent, { type: "thread.created" }> {
  const occurredAt = `2026-04-13T00:00:0${params.sequence}.000Z`;
  const projectId = params.projectId ?? ProjectId.make("project-1");

  return {
    sequence: params.sequence,
    eventId: EventId.make(`event-thread-created-${params.sequence}`),
    aggregateKind: "thread",
    aggregateId: params.threadId,
    occurredAt,
    commandId: CommandId.make(`command-thread-created-${params.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.created",
    payload: {
      threadId: params.threadId,
      projectId,
      title: "Recovered Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
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

async function exhaustNotificationReconnectTimeout(input: {
  readonly browser: ReturnType<typeof stubBrowserVisibility>;
  readonly reconcileAfterNotificationClick: (target: {
    readonly kind: "thread";
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): Promise<void> {
  mockConnectionReconnects[0]
    ?.mockRejectedValueOnce(
      new MockEnvironmentShellBootstrapTimeoutError(input.environmentId, 12_000),
    )
    .mockRejectedValueOnce(
      new MockEnvironmentShellBootstrapTimeoutError(input.environmentId, 12_000),
    );

  input.browser.setVisibilityState("hidden");
  input.browser.documentTarget.dispatchEvent(new Event("visibilitychange"));
  vi.setSystemTime(Date.now() + 6_000);
  input.reconcileAfterNotificationClick({
    kind: "thread",
    environmentId: input.environmentId,
    threadId: input.threadId,
  });

  await vi.waitFor(() => {
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(500);
  await vi.waitFor(() => {
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(2);
  });
  await vi.advanceTimersByTimeAsync(0);
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
    mockReconcileThreadDetail.mockReset();
    mockCreateEnvironmentConnection.mockReset();
    mockCreateWsRpcClient.mockReset();
    mockWaitForSavedEnvironmentRegistryHydration.mockReset();
    mockListSavedEnvironmentRecords.mockReset();
    mockGetSavedEnvironmentRecord.mockReset();
    mockReadSavedEnvironmentBearerToken.mockReset();
    mockSavedEnvironmentRegistrySubscribe.mockReset();
    mockGetPrimaryKnownEnvironment.mockReset();
    mockIsEnvironmentShellBootstrapTimeoutError.mockClear();
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
    mockReconcileThreadDetail.mockImplementation(async (input) => ({
      kind: "current",
      serverSequence: input.clientSequence ?? 0,
      serverFingerprint: input.verifiedFingerprint ?? { version: 1, value: "test-fingerprint" },
    }));
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
        reconcileThreadDetail: mockReconcileThreadDetail,
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
  }, 15_000);

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

  it("populates sidebar summaries for recovered new-thread domain events", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectSidebarThreadsAcrossEnvironments, selectThreadByRef, useStore } =
      await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-recovered-new-chat");
    const projectId = ProjectId.make("project-1");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      {
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: "2026-04-13T00:00:01.000Z",
      },
      environmentId,
    );

    mockReplayEvents.mockResolvedValueOnce([
      makeThreadCreatedEvent({ sequence: 2, threadId, projectId }),
      makeThreadSessionSetEvent({ sequence: 3, threadId, status: "running" }),
    ]);

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 3,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.waitFor(() => {
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
      const thread = selectThreadByRef(
        useStore.getState(),
        scopeThreadRef(environmentId, threadId),
      );
      expect(thread?.session?.status).toBe("running");
    });

    const sidebarThread = selectSidebarThreadsAcrossEnvironments(useStore.getState()).find(
      (thread) => thread.id === threadId,
    );
    expect(sidebarThread).toBeDefined();
    expect(sidebarThread?.session?.orchestrationStatus).toBe("running");
    expect(sidebarThread?.latestTurn?.state).toBe("running");

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("populates a sidebar summary from a live thread detail event", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectSidebarThreadSummaryByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-live-detail-sidebar");
    const projectId = ProjectId.make("project-1");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      {
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: "2026-04-13T00:00:01.000Z",
      },
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    readThreadDetailSubscriptionListener(0)({
      kind: "event",
      event: makeThreadCreatedEvent({ sequence: 2, threadId, projectId }),
    });

    const sidebarThread = selectSidebarThreadSummaryByRef(
      useStore.getState(),
      scopeThreadRef(environmentId, threadId),
    );
    expect(sidebarThread?.id).toBe(threadId);
    expect(sidebarThread?.projectId).toBe(projectId);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("resyncs known threads that were not touched by a completed gap replay", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectEnvironmentState, selectSidebarThreadSummaryByRef, useStore } =
      await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const knownThreadId = ThreadId.make("thread-known-missing-sidebar");
    const replayedThreadId = ThreadId.make("thread-replayed-sidebar");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId: knownThreadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );
    useStore.setState((state) => {
      const environmentState = selectEnvironmentState(state, environmentId);
      const { [knownThreadId]: _removed, ...sidebarThreadSummaryById } =
        environmentState.sidebarThreadSummaryById;
      return {
        ...state,
        environmentStateById: {
          ...state.environmentStateById,
          [environmentId]: {
            ...environmentState,
            sidebarThreadSummaryById,
          },
        },
      };
    });
    expect(
      selectSidebarThreadSummaryByRef(
        useStore.getState(),
        scopeThreadRef(environmentId, knownThreadId),
      ),
    ).toBeUndefined();

    mockReplayEvents.mockResolvedValueOnce([
      makeThreadCreatedEvent({ sequence: 2, threadId: replayedThreadId }),
      makeThreadSessionSetEvent({
        sequence: 3,
        threadId: replayedThreadId,
        status: "running",
      }),
    ]);

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 3,
        thread: makeThreadShellSnapshot({
          threadId: replayedThreadId,
          sessionStatus: "running",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.waitFor(() => {
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
      expect(
        selectSidebarThreadSummaryByRef(
          useStore.getState(),
          scopeThreadRef(environmentId, knownThreadId),
        )?.id,
      ).toBe(knownThreadId);
    });

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
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

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
          queuedTurns: [],
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

  it("does not let subscription snapshots drop older rows loaded through page requests", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-tail-snapshot-preserves-older");
    const recentPageInfo: OrchestrationThreadDetailPageInfo = {
      ...EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
      messages: {
        hasMoreBefore: true,
        startCursor: {
          id: "message-3",
          createdAt: "2026-04-13T00:00:03.000Z",
        },
      },
    };
    const olderPageInfo: OrchestrationThreadDetailPageInfo = {
      ...EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
      messages: {
        hasMoreBefore: false,
        startCursor: {
          id: "message-1",
          createdAt: "2026-04-13T00:00:01.000Z",
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
    const detailListener = readThreadDetailSubscriptionListener(0);
    detailListener({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        pageInfo: recentPageInfo,
        messages: [
          {
            id: MessageId.make("message-3"),
            role: "user",
            text: "recent three",
            turnId: TurnId.make("turn-3"),
            streaming: false,
            createdAt: "2026-04-13T00:00:03.000Z",
            updatedAt: "2026-04-13T00:00:03.000Z",
          },
          {
            id: MessageId.make("message-4"),
            role: "assistant",
            text: "recent four",
            turnId: TurnId.make("turn-4"),
            streaming: false,
            createdAt: "2026-04-13T00:00:04.000Z",
            updatedAt: "2026-04-13T00:00:04.000Z",
          },
        ],
      }),
    });

    useStore.getState().mergeServerThreadDetailPage(
      makeThreadDetailSnapshot({
        snapshotSequence: 2,
        threadId,
        pageInfo: olderPageInfo,
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "user",
            text: "older one",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-13T00:00:01.000Z",
            updatedAt: "2026-04-13T00:00:01.000Z",
          },
          {
            id: MessageId.make("message-2"),
            role: "assistant",
            text: "older two",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-13T00:00:02.000Z",
            updatedAt: "2026-04-13T00:00:02.000Z",
          },
        ],
      }),
      environmentId,
      { requestedBefore: { messages: recentPageInfo.messages.startCursor! } },
    );

    detailListener({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 3,
        threadId,
        pageInfo: {
          ...EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
          messages: {
            hasMoreBefore: true,
            startCursor: {
              id: "message-4",
              createdAt: "2026-04-13T00:00:04.000Z",
            },
          },
        },
        messages: [
          {
            id: MessageId.make("message-4"),
            role: "assistant",
            text: "recent four repaired",
            turnId: TurnId.make("turn-4"),
            streaming: false,
            createdAt: "2026-04-13T00:00:04.000Z",
            updatedAt: "2026-04-13T00:00:05.000Z",
          },
          {
            id: MessageId.make("message-5"),
            role: "user",
            text: "recent five",
            turnId: TurnId.make("turn-5"),
            streaming: false,
            createdAt: "2026-04-13T00:00:05.000Z",
            updatedAt: "2026-04-13T00:00:05.000Z",
          },
        ],
      }),
    });

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));

    expect(thread?.messages.map((message) => message.id)).toEqual([
      MessageId.make("message-1"),
      MessageId.make("message-2"),
      MessageId.make("message-3"),
      MessageId.make("message-4"),
      MessageId.make("message-5"),
    ]);
    expect(
      thread?.messages.find((message) => message.id === MessageId.make("message-4"))?.text,
    ).toBe("recent four repaired");
    expect(thread?.detailPageInfo?.messages).toEqual(olderPageInfo.messages);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes a warm idle detail subscription when active re-entry finds it behind shell", async () => {
    const {
      retainActiveThreadDetailSubscription,
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

    const releaseActive = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseActive();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps a warm detail subscription attached on warm re-entry when it is caught up", async () => {
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

  it("force-refreshes prewarmed detail when it opens as active", async () => {
    const {
      retainActiveThreadDetailSubscription,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-prewarm-active-open");
    const messageId = MessageId.make("assistant-notification-open-final");
    const turnId = TurnId.make("turn-1");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }),
        snapshotSequence: 5,
      },
      environmentId,
    );

    const releaseWarm = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const warmDetailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((item: {
          readonly kind: "snapshot";
          readonly snapshot: ReturnType<typeof makeThreadDetailSnapshot>;
        }) => void)
      | undefined;
    expect(warmDetailListener).toBeDefined();
    warmDetailListener?.({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 6,
        threadId,
        sessionStatus: "running",
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: "Still working",
            turnId,
            streaming: true,
            createdAt: "2026-04-13T00:00:05.000Z",
            updatedAt: "2026-04-13T00:00:06.000Z",
          },
        ],
      }),
    });

    const refreshedSnapshot = makeThreadDetailSnapshot({
      snapshotSequence: 5,
      threadId,
      sessionStatus: "ready",
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Final response",
          turnId,
          streaming: false,
          createdAt: "2026-04-13T00:00:05.000Z",
          updatedAt: "2026-04-13T00:00:07.000Z",
        },
      ],
    });
    mockReconcileThreadDetail.mockResolvedValueOnce(
      makeThreadDetailReconcileSnapshotResult(refreshedSnapshot),
    );

    const releaseActive = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.messages.map((message) => message.text)).toEqual(["Final response"]);
    expect(thread?.messages[0]?.streaming).toBe(false);
    expect(thread?.session?.status).toBe("ready");

    releaseActive();
    releaseWarm();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not immediately force-refresh prewarmed detail on browser resume", async () => {
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
      clientSequence: 2,
      serverSequence: 2,
      behind: false,
    });

    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-prewarm-resume-no-immediate-refresh");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }),
        snapshotSequence: 2,
      },
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
        snapshotSequence: 2,
        threadId,
        sessionStatus: "running",
      }),
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 2 });
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    releaseWarm();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("defers prewarmed completion refresh until the thread becomes active", async () => {
    const {
      retainActiveThreadDetailSubscription,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-prewarm-completion-active-later");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }),
        snapshotSequence: 2,
      },
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
        snapshotSequence: 3,
        threadId,
        sessionStatus: "running",
      }),
    });

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 3,
        thread: makeCompletedThreadShellSnapshot({
          snapshotSequence: 3,
          threadId,
          sessionStatus: "ready",
        }).threads[0]!,
      },
      environmentId,
    );
    await vi.advanceTimersByTimeAsync(300);

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const releaseActive = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    releaseActive();
    releaseWarm();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not double-refresh a brand-new active thread detail subscription", async () => {
    const {
      retainActiveThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-new-active-no-double-refresh");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
      }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
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
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("periodically reconciles sidebar projection for an active thread without reconnecting", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectSidebarThreadSummaryByRef, selectThreadByRef, useStore } =
      await import("~/store");

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

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
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
    const sidebarThread = selectSidebarThreadSummaryByRef(
      useStore.getState(),
      scopeThreadRef(environmentId, threadId),
    );
    expect(sidebarThread?.session?.orchestrationStatus).toBe("ready");
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes a retained active thread detail subscription when the initial snapshot stalls", async () => {
    const {
      retainActiveThreadDetailSubscription,
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

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(300);

    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("force-refreshes active detail after a wake-drift timer tick when the backend cursor is current", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-wake-drift-current");
    const messageId = MessageId.make("assistant-wake-drift-current");
    const turnId = TurnId.make("turn-1");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }),
        snapshotSequence: 5,
      },
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 5,
        threadId,
        sessionStatus: "running",
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: "Still working",
            turnId,
            streaming: true,
            createdAt: "2026-04-13T00:00:05.000Z",
            updatedAt: "2026-04-13T00:00:06.000Z",
          },
        ],
      }),
    });
    const threadRef = scopeThreadRef(environmentId, threadId);
    const firstThread = selectThreadByRef(useStore.getState(), threadRef);
    expect(firstThread).toBeDefined();

    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);

    expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 5 });
    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    const secondThread = selectThreadByRef(useStore.getState(), threadRef);
    expect(secondThread).toBe(firstThread);
    expect(secondThread?.messages).toBe(firstThread?.messages);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("repairs missing final assistant text after a wake-drift detail refresh", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-wake-drift-final-text");
    const messageId = MessageId.make("assistant-wake-drift-final");
    const turnId = TurnId.make("turn-1");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }),
        snapshotSequence: 7,
      },
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 9,
        threadId,
        sessionStatus: "running",
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: "Still working",
            turnId,
            streaming: true,
            createdAt: "2026-04-13T00:00:05.000Z",
            updatedAt: "2026-04-13T00:00:06.000Z",
          },
        ],
      }),
    });

    const refreshedSnapshot = makeThreadDetailSnapshot({
      snapshotSequence: 8,
      threadId,
      sessionStatus: "ready",
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Final answer",
          turnId,
          streaming: false,
          createdAt: "2026-04-13T00:00:05.000Z",
          updatedAt: "2026-04-13T00:00:07.000Z",
        },
      ],
    });
    mockReconcileThreadDetail.mockResolvedValueOnce(
      makeThreadDetailReconcileSnapshotResult(refreshedSnapshot),
    );

    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);

    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.messages.map((message) => message.text)).toEqual(["Final answer"]);
    expect(thread?.messages[0]?.streaming).toBe(false);
    expect(thread?.session?.status).toBe("ready");
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not force-refresh active detail on a normal current timer tick", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-normal-tick-current");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);

    expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
    await expectThreadDetailReconcileCallCount(0);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("rate-limits connection health recovery from the active timer when the heartbeat is stale", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const client = mockCreateWsRpcClient.mock.results[0]?.value as
      | { readonly isHeartbeatFresh: ReturnType<typeof vi.fn> }
      | undefined;
    expect(client).toBeDefined();
    client?.isHeartbeatFresh.mockReturnValue(false);

    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-stale-heartbeat-health-recovery");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);

    expect(mockProbeSync).not.toHaveBeenCalled();
    await expectThreadDetailReconcileCallCount(0);
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);

    await expectThreadDetailReconcileCallCount(0);
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(2);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not enqueue active stale-heartbeat health recovery during full browser resume", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const client = mockCreateWsRpcClient.mock.results[0]?.value as
      | { readonly isHeartbeatFresh: ReturnType<typeof vi.fn> }
      | undefined;
    expect(client).toBeDefined();
    client?.isHeartbeatFresh.mockReturnValue(false);
    mockConnectionReconnects[0]?.mockImplementation(() => new Promise(() => undefined));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-stale-heartbeat-during-browser-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);

    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("clears timed-out connection health recovery and allows a later retry", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const client = mockCreateWsRpcClient.mock.results[0]?.value as
      | { readonly isHeartbeatFresh: ReturnType<typeof vi.fn> }
      | undefined;
    expect(client).toBeDefined();
    client?.isHeartbeatFresh.mockReturnValue(false);
    mockConnectionReconnects[0]?.mockImplementation(() => new Promise(() => undefined));

    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-health-recovery-timeout");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25_000);
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(2);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not recover the connection when active projection probing fails generically", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-probe-failure-health-recovery");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );
    mockProbeSync.mockRejectedValue(new Error("probe failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
    });
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "Active thread projection reconciliation failed without reconnecting",
      expect.objectContaining({
        environmentId,
        reason: "active-thread-detail",
        error: "probe failed",
      }),
    );

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not recover the connection when active projection probing times out", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-probe-timeout-no-health-recovery");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );
    mockProbeSync.mockImplementation(() => new Promise(() => undefined));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_500);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "Active thread projection reconciliation failed without reconnecting",
        expect.objectContaining({
          environmentId,
          reason: "active-thread-detail",
          error: "Browser resume reconciliation timed out.",
        }),
      );
    });
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("queues controlled connection health recovery when active projection probing fails from transport", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-transport-probe-health-recovery");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );
    mockProbeSync.mockRejectedValue(new Error("SocketCloseError: 1006"));

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not let an active projection probe block foreground resume recovery", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockProbeSync
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({
        clientSequence: 1,
        serverSequence: 2,
        behind: true,
      });
    mockReplayEvents.mockResolvedValueOnce([
      makeThreadSessionSetEvent({
        sequence: 2,
        threadId: ThreadId.make("thread-active-projection-foreground"),
        status: "ready",
      }),
    ]);

    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-projection-foreground");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledTimes(1);
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledTimes(2);
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
    });
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps active projection timeout low priority before foreground resume reconnects", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    mockProbeSync
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockRejectedValueOnce(new Error("stale socket"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-timeout-before-foreground");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "Active thread projection reconciliation failed without reconnecting",
        expect.objectContaining({
          environmentId,
          reason: "active-thread-detail",
          error: "Browser resume reconciliation timed out.",
        }),
      );
    });
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledTimes(2);
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });

    warnSpy.mockRestore();
    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not wake-refresh warm prewarmed thread detail", async () => {
    const {
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-warm-wake-drift-no-refresh");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const releaseWarm = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });

    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    releaseWarm();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("limits wake-drift detail refreshes with a cooldown and stops after active release", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-wake-drift-cooldown");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "idle",
      }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "idle",
      }),
    });

    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 20_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).toHaveBeenCalledTimes(1);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 31_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(2);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).toHaveBeenCalledTimes(2);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

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

  it("force-refreshes active thread detail on foreground resume when backend cursor is current", async () => {
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
      clientSequence: 2,
      serverSequence: 2,
      behind: false,
    });

    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-current-probe-stale-detail-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({
          threadId,
          sessionStatus: "ready",
        }),
        snapshotSequence: 2,
      },
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
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

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 2 });
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReplayEvents).not.toHaveBeenCalled();
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("force-refreshes active running thread detail on current foreground resume", async () => {
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
      clientSequence: 2,
      serverSequence: 2,
      behind: false,
    });

    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-current-running-detail-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }),
        snapshotSequence: 2,
      },
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
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
        snapshotSequence: 2,
        threadId,
        sessionStatus: "running",
        messages: [
          {
            id: MessageId.make("assistant-current-running"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-13T00:00:02.000Z",
            updatedAt: "2026-04-13T00:00:02.000Z",
          },
        ],
      }),
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 2 });
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReplayEvents).not.toHaveBeenCalled();
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not clobber streaming assistant text during foreground resume refresh", async () => {
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
      clientSequence: 2,
      serverSequence: 2,
      behind: false,
    });

    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-current-running-detail-content-resume");
    const messageId = MessageId.make("assistant-current-running-content");
    const turnId = TurnId.make("turn-1");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }),
        snapshotSequence: 2,
      },
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const initialDetailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((item: {
          readonly kind: "snapshot";
          readonly snapshot: ReturnType<typeof makeThreadDetailSnapshot>;
        }) => void)
      | undefined;
    expect(initialDetailListener).toBeDefined();
    initialDetailListener?.({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 2,
        threadId,
        sessionStatus: "running",
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: "Hello",
            turnId,
            streaming: true,
            createdAt: "2026-04-13T00:00:02.000Z",
            updatedAt: "2026-04-13T00:00:02.000Z",
          },
        ],
      }),
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 2 });
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReplayEvents).not.toHaveBeenCalled();
    // The forced refresh on foreground resume reconciles the active thread,
    // but the server reports it is current so streaming text is preserved.
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.messages.map((message) => message.text)).toEqual(["Hello"]);
    expect(thread?.messages[0]?.streaming).toBe(true);
    expect(thread?.latestTurn?.state).toBe("running");
    expect(thread?.session?.status).toBe("running");

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("force-refreshes active detail when a detail completion event settles running work", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-detail-completion-refresh");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const detailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((
          item:
            | {
                readonly kind: "snapshot";
                readonly snapshot: ReturnType<typeof makeThreadDetailSnapshot>;
              }
            | {
                readonly kind: "event";
                readonly event: Extract<OrchestrationEvent, { type: "thread.session-set" }>;
              },
        ) => void)
      | undefined;
    expect(detailListener).toBeDefined();
    detailListener?.({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });
    const completedThread = makeCompletedThreadShellSnapshot({
      snapshotSequence: 2,
      threadId,
    }).threads[0];
    expect(completedThread).toBeDefined();
    mockReconcileThreadDetail.mockResolvedValueOnce(
      makeThreadDetailReconcileSnapshotResult({
        snapshotSequence: 2,
        thread: {
          ...completedThread!,
          deletedAt: null,
          messages: [],
          queuedTurns: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
        },
        pageInfo: EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
      }),
    );
    detailListener?.({
      kind: "event",
      event: makeThreadSessionSetEvent({
        sequence: 2,
        threadId,
        status: "ready",
      }),
    });

    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.session?.status).toBe("ready");
    expect(thread?.latestTurn?.state).toBe("completed");

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("applies missing final message events after a completion-triggered forced snapshot reset", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-completion-refresh-final-text");
    const messageId = MessageId.make("assistant-completion-refresh-final-text");
    const turnId = TurnId.make("turn-1");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const initialDetailListener = mockSubscribeThread.mock.calls[0]?.[1] as
      | ((
          item:
            | {
                readonly kind: "snapshot";
                readonly snapshot: ReturnType<typeof makeThreadDetailSnapshot>;
              }
            | {
                readonly kind: "event";
                readonly event: Extract<OrchestrationEvent, { type: "thread.session-set" }>;
              },
        ) => void)
      | undefined;
    expect(initialDetailListener).toBeDefined();
    initialDetailListener?.({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 10,
        threadId,
        sessionStatus: "running",
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: "Hello",
            turnId,
            streaming: true,
            createdAt: "2026-04-13T00:00:10.000Z",
            updatedAt: "2026-04-13T00:00:10.000Z",
          },
        ],
      }),
    });
    mockReconcileThreadDetail.mockResolvedValueOnce(
      makeThreadDetailReconcileSnapshotResult(
        makeThreadDetailSnapshot({
          snapshotSequence: 12,
          threadId,
          sessionStatus: "ready",
          messages: [
            {
              id: messageId,
              role: "assistant",
              text: "Hello world",
              turnId,
              streaming: false,
              createdAt: "2026-04-13T00:00:10.000Z",
              updatedAt: "2026-04-13T00:00:11.000Z",
            },
          ],
        }),
        "unverified-client-cursor",
      ),
    );
    initialDetailListener?.({
      kind: "event",
      event: makeThreadSessionSetEvent({
        sequence: 12,
        threadId,
        status: "ready",
        occurredAt: "2026-04-13T00:00:12.000Z",
      }),
    });

    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.messages.map((message) => message.text)).toEqual(["Hello world"]);
    expect(thread?.messages[0]?.streaming).toBe(false);
    expect(thread?.session?.status).toBe("ready");
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("force-refreshes active detail when shell completion arrives at the current detail sequence", async () => {
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-shell-completion-refresh");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }),
        snapshotSequence: 2,
      },
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
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
        snapshotSequence: 3,
        threadId,
        sessionStatus: "running",
      }),
    });

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 3,
        thread: makeCompletedThreadShellSnapshot({
          snapshotSequence: 3,
          threadId,
          sessionStatus: "ready",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("defers shell-completion refresh for a released warm detail subscription until active re-entry", async () => {
    const {
      retainActiveThreadDetailSubscription,
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { scopeThreadRef } = await import("@t3tools/client-runtime");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-warm-shell-completion-no-refresh");
    const messageId = MessageId.make("assistant-warm-shell-completion-final");
    const turnId = TurnId.make("turn-1");
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
        snapshotSequence: 2,
        threadId,
        sessionStatus: "running",
      }),
    });
    release();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeCompletedThreadShellSnapshot({
          snapshotSequence: 2,
          threadId,
          sessionStatus: "ready",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(300);

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    const refreshedSnapshot = makeThreadDetailSnapshot({
      snapshotSequence: 1,
      threadId,
      sessionStatus: "ready",
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Final response",
          turnId,
          streaming: false,
          createdAt: "2026-04-13T00:00:02.000Z",
          updatedAt: "2026-04-13T00:00:03.000Z",
        },
      ],
    });
    mockReconcileThreadDetail.mockResolvedValueOnce(
      makeThreadDetailReconcileSnapshotResult(refreshedSnapshot),
    );

    const releaseActive = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    const thread = selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));
    expect(thread?.messages.map((message) => message.text)).toEqual(["Final response"]);
    expect(thread?.session?.status).toBe("ready");

    releaseActive();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("force-refreshes active empty thread detail on current foreground resume", async () => {
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
      clientSequence: 2,
      serverSequence: 2,
      behind: false,
    });

    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-known-content-empty-detail-resume");
    const shellSnapshot = makeThreadShellSnapshot({
      threadId,
      sessionStatus: "ready",
    });
    const shellThread = shellSnapshot.threads[0];
    expect(shellThread).toBeDefined();
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...shellSnapshot,
        snapshotSequence: 2,
        threads: [
          {
            ...shellThread!,
            latestUserMessageAt: "2026-04-13T00:00:02.000Z",
            updatedAt: "2026-04-13T00:00:02.000Z",
          },
        ],
      },
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
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
        snapshotSequence: 2,
        threadId,
        sessionStatus: "ready",
        messages: [],
      }),
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 2 });
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReplayEvents).not.toHaveBeenCalled();
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("defers browser-resume refresh for a released warm detail subscription until active re-entry", async () => {
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
      clientSequence: 2,
      serverSequence: 2,
      behind: false,
    });

    const {
      retainActiveThreadDetailSubscription,
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-warm-current-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }),
        snapshotSequence: 2,
      },
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
        snapshotSequence: 2,
        threadId,
        sessionStatus: "running",
      }),
    });
    release();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 2 });
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    const releaseActive = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    releaseActive();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconciles environment connections and forces thread detail refresh after notification click", async () => {
    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const client = mockCreateWsRpcClient.mock.results[0]?.value as
      | { readonly isHeartbeatFresh: ReturnType<typeof vi.fn> }
      | undefined;
    expect(client).toBeDefined();
    client?.isHeartbeatFresh.mockReturnValue(false);

    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-click");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );
    mockProbeSync.mockResolvedValue({
      clientSequence: 1,
      serverSequence: 1,
      behind: false,
    });

    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId,
    });

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    client?.isHeartbeatFresh.mockReturnValue(true);

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("force-refreshes completed-but-running active thread detail on current foreground resume", async () => {
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
      retainActiveThreadDetailSubscription,
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

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 2 });
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReplayEvents).not.toHaveBeenCalled();
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
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
        reconcileThreadDetail: mockReconcileThreadDetail,
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
        reconcileThreadDetail: mockReconcileThreadDetail,
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

  it("forces reconnect after a long hidden gap even when the heartbeat reads fresh", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-long-background-force-reconnect");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );
    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 6_000);
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    expect(mockProbeSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => {
      expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reuses recent browser resume duration for notification clicks after focus", async () => {
    const browser = stubBrowserVisibility();

    const {
      reconcileAfterNotificationClick,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-recent-focus");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );

    browser.setVisibilityState("hidden");
    browser.documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 6_000);
    browser.setVisibilityState("visible");
    browser.windowTarget.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockProbeSync).not.toHaveBeenCalled();

    reconcileAfterNotificationClick(
      {
        kind: "thread",
        environmentId,
        threadId,
      },
      { openedAt: Date.now() },
    );

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(2);
    });
    expect(mockProbeSync).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps notification click hidden duration null without a current or recent resume signal", async () => {
    const {
      reconcileAfterNotificationClick,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-no-resume-context");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );

    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId,
    });

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
    });
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("expires the recent browser resume context after 30 seconds", async () => {
    const browser = stubBrowserVisibility();

    const {
      reconcileAfterNotificationClick,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-expired-resume");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );

    browser.setVisibilityState("hidden");
    browser.documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 6_000);
    browser.setVisibilityState("visible");
    browser.windowTarget.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockProbeSync).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 30_001);
    reconcileAfterNotificationClick(
      {
        kind: "thread",
        environmentId,
        threadId,
      },
      { openedAt: Date.now() },
    );

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
    });
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("queues a forced notification-click reconnect behind a weaker in-flight reconcile", async () => {
    const browser = stubBrowserVisibility();
    const resolveProbeRef: {
      current:
        | ((value: {
            readonly clientSequence: number;
            readonly serverSequence: number;
            readonly behind: boolean;
          }) => void)
        | null;
    } = { current: null };
    mockProbeSync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbeRef.current = resolve;
        }),
    );

    const {
      reconcileAfterNotificationClick,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-forced-follow-up");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledTimes(1);
    });

    browser.setVisibilityState("hidden");
    browser.documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 6_000);
    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId,
    });

    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();
    expect(resolveProbeRef.current).toBeDefined();
    resolveProbeRef.current?.({
      clientSequence: 1,
      serverSequence: 1,
      behind: false,
    });

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes notification thread target after slow long-background reconnect completes", async () => {
    const browser = stubBrowserVisibility();

    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const resolveReconnectRef: { current: (() => void) | null } = { current: null };
    mockConnectionReconnects[0]?.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveReconnectRef.current = resolve;
        }),
    );

    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-post-reconnect");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );

    browser.setVisibilityState("hidden");
    browser.documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 6_000);
    browser.setVisibilityState("visible");
    browser.windowTarget.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });

    reconcileAfterNotificationClick(
      {
        kind: "thread",
        environmentId,
        threadId,
      },
      { openedAt: Date.now() },
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();

    expect(resolveReconnectRef.current).toBeDefined();
    resolveReconnectRef.current?.();
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps notification target pending after shell bootstrap timeout", async () => {
    const browser = stubBrowserVisibility();

    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-bootstrap-timeout");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );
    mockConnectionReconnects[0]?.mockRejectedValueOnce(
      new MockEnvironmentShellBootstrapTimeoutError(environmentId, 12_000),
    );

    browser.setVisibilityState("hidden");
    browser.documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 6_000);
    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId,
    });

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(0);

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(2);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes notification target after timeout retry reconnect completes", async () => {
    const browser = stubBrowserVisibility();

    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-timeout-retry-refresh");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );
    mockConnectionReconnects[0]
      ?.mockRejectedValueOnce(new MockEnvironmentShellBootstrapTimeoutError(environmentId, 12_000))
      .mockResolvedValueOnce(undefined);

    browser.setVisibilityState("hidden");
    browser.documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 6_000);
    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId,
    });

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps notification target pending when timeout retry also times out", async () => {
    const browser = stubBrowserVisibility();

    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-timeout-retry-exhausted");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );
    mockConnectionReconnects[0]
      ?.mockRejectedValueOnce(new MockEnvironmentShellBootstrapTimeoutError(environmentId, 12_000))
      .mockRejectedValueOnce(new MockEnvironmentShellBootstrapTimeoutError(environmentId, 12_000));

    browser.setVisibilityState("hidden");
    browser.documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 6_000);
    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId,
    });

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(0);

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  }, 15_000);

  it("refreshes pending notification target when heartbeat probe proves current after timeout retry exhaustion", async () => {
    const browser = stubBrowserVisibility();
    const resumeDiagnostics = await import("./resumeDiagnostics");
    const recordSpy = vi.spyOn(resumeDiagnostics, "recordResumeDiagnostic");

    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-timeout-probe-current");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "idle" }),
      environmentId,
    );

    await exhaustNotificationReconnectTimeout({
      browser,
      reconcileAfterNotificationClick,
      environmentId,
      threadId,
    });

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();

    browser.setVisibilityState("visible");
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledWith({ clientSequence: 1 });
    });
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));

    expect(
      recordSpy.mock.calls.some(
        ([kind, payload]) =>
          kind === "browser-resume-shell-bootstrap-timeout-cleared" &&
          payload?.env === environmentId &&
          payload.reason === "heartbeat-probe-current",
      ),
    ).toBe(true);
    expect(
      recordSpy.mock.calls.some(
        ([kind, payload]) =>
          kind === "notification-thread-reconcile-post-reconnect-entry" &&
          payload?.env === environmentId &&
          payload.reason === "notification-click:post-healthy-probe" &&
          payload.data?.threadId === threadId &&
          payload.data?.reconciled === true,
      ),
    ).toBe(true);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  }, 15_000);

  it("refreshes pending notification target when heartbeat replay recovers after timeout retry exhaustion", async () => {
    const browser = stubBrowserVisibility();
    const resumeDiagnostics = await import("./resumeDiagnostics");
    const recordSpy = vi.spyOn(resumeDiagnostics, "recordResumeDiagnostic");
    const replayedThreadId = ThreadId.make("thread-notification-timeout-replay-other");
    mockProbeSync.mockResolvedValueOnce({
      clientSequence: 1,
      serverSequence: 2,
      behind: true,
    });
    mockReplayEvents.mockResolvedValueOnce([
      makeThreadSessionSetEvent({
        sequence: 2,
        threadId: replayedThreadId,
        status: "ready",
      }),
    ]);

    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-timeout-replay-recovered");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "idle" }),
      environmentId,
    );

    await exhaustNotificationReconnectTimeout({
      browser,
      reconcileAfterNotificationClick,
      environmentId,
      threadId,
    });

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();

    browser.setVisibilityState("visible");
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => {
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
    });
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));

    expect(
      recordSpy.mock.calls.some(
        ([kind, payload]) =>
          kind === "browser-resume-shell-bootstrap-timeout-cleared" &&
          payload?.env === environmentId &&
          payload.reason === "heartbeat-replay-recovered",
      ),
    ).toBe(true);
    expect(
      recordSpy.mock.calls.some(
        ([kind, payload]) =>
          kind === "notification-thread-reconcile-post-reconnect-entry" &&
          payload?.env === environmentId &&
          payload.reason === "notification-click:post-healthy-replay" &&
          payload.data?.threadId === threadId &&
          payload.data?.reconciled === true,
      ),
    ).toBe(true);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  }, 15_000);

  it("keeps pending notification target blocked when heartbeat replay and fallback reconnect fail", async () => {
    const browser = stubBrowserVisibility();
    const resumeDiagnostics = await import("./resumeDiagnostics");
    const recordSpy = vi.spyOn(resumeDiagnostics, "recordResumeDiagnostic");
    mockProbeSync.mockResolvedValueOnce({
      clientSequence: 1,
      serverSequence: 2,
      behind: true,
    });
    mockReplayEvents.mockRejectedValueOnce(new Error("replay failed"));

    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-timeout-replay-failed");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "idle" }),
      environmentId,
    );

    await exhaustNotificationReconnectTimeout({
      browser,
      reconcileAfterNotificationClick,
      environmentId,
      threadId,
    });
    mockConnectionReconnects[0]?.mockRejectedValueOnce(
      new MockEnvironmentShellBootstrapTimeoutError(environmentId, 12_000),
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();

    browser.setVisibilityState("visible");
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => {
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(3);
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();

    expect(
      recordSpy.mock.calls.some(
        ([kind, payload]) =>
          kind === "browser-resume-shell-bootstrap-timeout-cleared" &&
          payload?.env === environmentId,
      ),
    ).toBe(false);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  }, 15_000);

  it("refreshes pending notification target when thread detail reconcile succeeds after timeout retry exhaustion", async () => {
    const browser = stubBrowserVisibility();
    const resumeDiagnostics = await import("./resumeDiagnostics");
    const recordSpy = vi.spyOn(resumeDiagnostics, "recordResumeDiagnostic");

    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-timeout-detail-reconcile");
    const otherThreadId = ThreadId.make("thread-notification-timeout-detail-other");

    await exhaustNotificationReconnectTimeout({
      browser,
      reconcileAfterNotificationClick,
      environmentId,
      threadId,
    });

    const notificationRelease = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();

    const passiveOtherRelease = retainThreadDetailSubscription(environmentId, otherThreadId);
    readThreadDetailSubscriptionListener(1)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId: otherThreadId,
      }),
    });
    passiveOtherRelease();

    const activeOtherRelease = retainActiveThreadDetailSubscription(environmentId, otherThreadId);
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: otherThreadId }),
    );

    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(2);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockReconcileThreadDetail).toHaveBeenCalledTimes(2);
    expect(
      recordSpy.mock.calls.filter(
        ([kind, payload]) =>
          kind === "browser-resume-shell-bootstrap-timeout-cleared" &&
          payload?.env === environmentId &&
          payload.reason === "thread-detail-reconcile",
      ),
    ).toHaveLength(1);
    expect(
      recordSpy.mock.calls.some(
        ([kind, payload]) =>
          kind === "notification-thread-reconcile-post-reconnect-entry" &&
          payload?.env === environmentId &&
          payload.reason === "notification-click:post-thread-detail-reconcile" &&
          payload.data?.threadId === threadId &&
          payload.data?.reconciled === true,
      ),
    ).toBe(true);

    activeOtherRelease();
    notificationRelease();
    stop();
    await resetEnvironmentServiceForTests();
  }, 15_000);

  it("hydrates a pending notification target after service restart within TTL", async () => {
    const localStorage = createMemoryStorage();
    stubBrowserVisibility("visible", { localStorage });

    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const firstStop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-persisted-restart");

    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId,
    });

    firstStop();
    await resetEnvironmentServiceForTests();

    const secondStop = startEnvironmentConnectionService(new QueryClient());
    const connectionInput = mockCreateEnvironmentConnection.mock.calls.at(-1)?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    await expectThreadDetailReconcileCallCount(1);
    expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));

    release();
    secondStop();
    await resetEnvironmentServiceForTests();
  });

  it("expires persisted pending notification targets after TTL", async () => {
    const localStorage = createMemoryStorage();
    stubBrowserVisibility("visible", { localStorage });

    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const firstStop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-persisted-expired");

    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId,
    });

    firstStop();
    await resetEnvironmentServiceForTests();

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    const secondStop = startEnvironmentConnectionService(new QueryClient());
    const connectionInput = mockCreateEnvironmentConnection.mock.calls.at(-1)?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockReconcileThreadDetail).not.toHaveBeenCalled();

    release();
    secondStop();
    await resetEnvironmentServiceForTests();
  });

  it("forces reconnect on notification click after a long hidden gap", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const {
      reconcileAfterNotificationClick,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-long-background");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 6_000);
    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId,
    });

    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    expect(mockProbeSync).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps repeated notification thread targets pending until each active thread mounts", async () => {
    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const firstThreadId = ThreadId.make("thread-notification-pending-one");
    const secondThreadId = ThreadId.make("thread-notification-pending-two");

    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId: firstThreadId,
    });
    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId: secondThreadId,
    });

    const releaseFirst = retainActiveThreadDetailSubscription(environmentId, firstThreadId);
    const releaseSecond = retainActiveThreadDetailSubscription(environmentId, secondThreadId);

    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => {
      expect(mockReconcileThreadDetail).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: firstThreadId }),
      );
      expect(mockReconcileThreadDetail).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: secondThreadId }),
      );
    });

    releaseFirst();
    releaseSecond();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("skips consume diagnostics when no pending notification target exists", async () => {
    const resumeDiagnostics = await import("./resumeDiagnostics");
    const recordSpy = vi.spyOn(resumeDiagnostics, "recordResumeDiagnostic");
    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-no-pending-diagnostics");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );

    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(300);

    expect(
      recordSpy.mock.calls.filter(([kind]) => kind === "notification-thread-reconcile-consume"),
    ).toHaveLength(0);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("throttles blocked pending notification consume diagnostics", async () => {
    const resumeDiagnostics = await import("./resumeDiagnostics");
    const recordSpy = vi.spyOn(resumeDiagnostics, "recordResumeDiagnostic");
    const {
      reconcileAfterNotificationClick,
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const client = mockCreateWsRpcClient.mock.results[0]?.value as
      | { readonly isHeartbeatFresh: ReturnType<typeof vi.fn> }
      | undefined;
    expect(client).toBeDefined();
    client?.isHeartbeatFresh.mockReturnValue(false);

    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-notification-blocked-diagnostics");
    reconcileAfterNotificationClick({
      kind: "thread",
      environmentId,
      threadId,
    });
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });

    const firstRelease = retainActiveThreadDetailSubscription(environmentId, threadId);
    const secondRelease = retainActiveThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(4_999);
    const thirdRelease = retainActiveThreadDetailSubscription(environmentId, threadId);

    const consumeCallsBeforeInterval = recordSpy.mock.calls.filter(
      ([kind, payload]) =>
        kind === "notification-thread-reconcile-consume" &&
        payload?.env === environmentId &&
        payload.data?.threadId === threadId,
    );
    expect(consumeCallsBeforeInterval).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const fourthRelease = retainActiveThreadDetailSubscription(environmentId, threadId);
    const consumeCallsAfterInterval = recordSpy.mock.calls.filter(
      ([kind, payload]) =>
        kind === "notification-thread-reconcile-consume" &&
        payload?.env === environmentId &&
        payload.data?.threadId === threadId,
    );
    expect(consumeCallsAfterInterval).toHaveLength(2);

    fourthRelease();
    thirdRelease();
    secondRelease();
    firstRelease();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes active thread detail when browser resume probe is up to date", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-resume-up-to-date-refresh");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );
    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockProbeSync).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => {
      expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes active thread detail after replay even when no events touch the active thread", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    mockProbeSync.mockResolvedValueOnce({
      clientSequence: 1,
      serverSequence: 2,
      behind: true,
    });
    mockReplayEvents.mockResolvedValueOnce([
      makeThreadSessionSetEvent({
        sequence: 2,
        threadId: ThreadId.make("thread-other-untouched"),
        status: "ready",
      }),
    ]);

    const {
      retainActiveThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-resume-replay-refresh");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );
    const release = retainActiveThreadDetailSubscription(environmentId, threadId);
    readThreadDetailSubscriptionListener(0)({
      kind: "snapshot",
      snapshot: makeThreadDetailSnapshot({
        snapshotSequence: 1,
        threadId,
        sessionStatus: "running",
      }),
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(mockReplayEvents).toHaveBeenCalledWith({ fromSequenceExclusive: 1 });
    });
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => {
      expect(mockReconcileThreadDetail).toHaveBeenCalledWith(expect.objectContaining({ threadId }));
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconnects on the visibility heartbeat tick when the connection silently dies", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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
        reconcileThreadDetail: mockReconcileThreadDetail,
      },
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => {
      expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);
    });
    expect(mockProbeSync).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("suppresses the visibility heartbeat tick while document is hidden", async () => {
    let visibilityState: DocumentVisibilityState = "hidden";
    const documentTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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
        reconcileThreadDetail: mockReconcileThreadDetail,
      },
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();
    expect(mockProbeSync).not.toHaveBeenCalled();

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
