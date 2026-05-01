import { scopeThreadRef } from "@forma/client-runtime";
import { QueryClient } from "@tanstack/react-query";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
} from "@forma/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let serviceModule: Awaited<typeof import("./service")>;

const mockSubscribeThread = vi.fn();
const mockThreadUnsubscribe = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();
const mockProcessThreadAttentionShellUpsert = vi.fn();
const mockReconcileThreadAttentionShellSnapshot = vi.fn();
const mockClearThreadAttentionTrackingForThread = vi.fn();
const mockClearThreadAttentionTrackingForEnvironment = vi.fn();

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

vi.mock("~/threadAttentionNotifications", () => ({
  processThreadAttentionShellUpsert: mockProcessThreadAttentionShellUpsert,
  reconcileThreadAttentionShellSnapshot: mockReconcileThreadAttentionShellSnapshot,
  clearThreadAttentionTrackingForThread: mockClearThreadAttentionTrackingForThread,
  clearThreadAttentionTrackingForEnvironment: mockClearThreadAttentionTrackingForEnvironment,
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
          provider: "codex",
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
        queuedTurnCount: 0,
        turnQueueStatus: "idle",
      },
    ],
  };
}

function makeEmptyShellSnapshot(): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-04-13T00:00:00.000Z",
    threads: [],
  };
}

describe("retainThreadDetailSubscription", () => {
  beforeEach(async () => {
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
    serviceModule = await import("./service");
  }, 30_000);

  afterEach(async () => {
    await serviceModule.resetEnvironmentServiceForTests();
    vi.useRealTimers();
  }, 30_000);

  it("keeps thread detail subscriptions warm across releases until idle eviction", async () => {
    const stop = serviceModule.startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");

    const releaseFirst = serviceModule.retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    const releaseSecond = serviceModule.retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(28 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
  });

  it("keeps non-idle thread detail subscriptions attached until the thread becomes idle", async () => {
    const stop = serviceModule.startEnvironmentConnectionService(new QueryClient());
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

    const release = serviceModule.retainThreadDetailSubscription(environmentId, threadId);
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
  });

  it("allows a larger idle cache before capacity eviction starts", async () => {
    const stop = serviceModule.startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");

    for (let index = 0; index < 12; index += 1) {
      const release = serviceModule.retainThreadDetailSubscription(
        environmentId,
        ThreadId.make(`thread-${index + 1}`),
      );
      release();
    }

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    stop();
  });

  it("disposes cached thread detail subscriptions when the environment service resets", async () => {
    const stop = serviceModule.startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-2");

    const release = serviceModule.retainThreadDetailSubscription(environmentId, threadId);
    release();

    await serviceModule.resetEnvironmentServiceForTests();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
  });

  it("routes thread shell upserts into the thread-attention notification policy", async () => {
    const stop = serviceModule.startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-needs-approval");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          hasPendingApprovals: true,
        }).threads[0]!,
      },
      environmentId,
    );

    expect(mockProcessThreadAttentionShellUpsert).toHaveBeenCalledTimes(1);
    expect(mockProcessThreadAttentionShellUpsert).toHaveBeenCalledWith(
      {
        environmentId,
        threadId,
        threadTitle: "Thread",
        hasPendingApprovals: true,
        hasPendingUserInput: false,
      },
      expect.objectContaining({
        desktopNotifyOnApprovalRequests: false,
        desktopNotifyOnUserInputRequests: false,
      }),
    );

    stop();
  });

  it("preserves optimistic fork shells across shell snapshot refreshes", async () => {
    const stop = serviceModule.startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-fork");
    const threadRef = scopeThreadRef(environmentId, threadId);
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    serviceModule.stageOptimisticThreadShell(
      makeThreadShellSnapshot({
        threadId,
      }).threads[0]!,
      environmentId,
    );

    const storeModule = await import("~/store");
    expect(storeModule.selectThreadExistsByRef(storeModule.useStore.getState(), threadRef)).toBe(
      true,
    );

    connectionInput.syncShellSnapshot(makeEmptyShellSnapshot(), environmentId);

    expect(storeModule.selectThreadExistsByRef(storeModule.useStore.getState(), threadRef)).toBe(
      true,
    );

    stop();
  });
});
