import { QueryClient } from "@tanstack/react-query";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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

    const releaseFirst = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    const releaseSecond = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 - 1);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

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
