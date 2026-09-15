import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
  type VoiceObserveThreadOutput,
  type VoiceReadThreadOutput,
  type VoiceStartThreadOutput,
  type VoiceTimingMark,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createVoicePanelController, type VoiceMicController } from "./ui/voicePanelController";
import type {
  VoiceLiveClient,
  VoiceLiveClientEvent,
  VoiceLiveClientOptions,
  VoiceLiveMediaStreamTrack,
} from "./live-client";
import { type VoiceDeliveryRecord, type VoiceResearchBridgeEvent } from "./research";
import {
  createVoiceModule,
  type VoiceKeyValueStorage,
  createWebVoiceDeliveryStore,
  decodeVoiceWorkerProfilesConfig,
  readVoiceWorkerProfilesConfig,
  saveVoiceWorkerProfilesConfig,
  VOICE_DELIVERY_RECORDS_STORAGE_KEY,
  VOICE_WORKER_PROFILES_STORAGE_KEY,
} from "./index";
import {
  createVoiceToolExecutor,
  VoiceToolFailureError,
  type VoiceToolExecutor,
  type VoiceToolHost,
} from "./tools";

const envA = EnvironmentId.make("env-a");
const projectA = ProjectId.make("project-a");
const threadA = ThreadId.make("0aaaaaaa-0000-4000-8000-000000000001");
const threadB = ThreadId.make("0aaaaaaa-0000-4000-8000-000000000002");
const turn1 = TurnId.make("turn-1");

// ---------------------------------------------------------------------------
// Fixtures (host/executor/client/storage boundaries mocked; no network)
// ---------------------------------------------------------------------------

/** Synchronous in-memory storage matching the VoiceKeyValueStorage subset. */
const memoryStorage = (): VoiceKeyValueStorage => {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
  };
};

const providersFixture = () => [
  {
    instanceId: "inst-a",
    driver: "claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-11T10:00:00.000Z",
    models: [
      { slug: "model-a", name: "Model A", isCustom: false, capabilities: null },
      { slug: "model-b", name: "Model B", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  },
];

const startReceipt = (threadId: ThreadId, requestId: string): VoiceStartThreadOutput => ({
  requestId: requestId as VoiceStartThreadOutput["requestId"],
  environment: { environmentId: envA, status: "ok" },
  commandId: "0bbbbbbb-0000-4000-8000-000000000001" as VoiceStartThreadOutput["commandId"],
  threadId,
  messageId: "0ccccccc-0000-4000-8000-000000000001" as VoiceStartThreadOutput["messageId"],
  dispatchSequence: 42,
  session: { status: "running", lastError: null },
});

const finishedObservation = (threadId: ThreadId): VoiceObserveThreadOutput => ({
  environment: { environmentId: envA, status: "ok" },
  threadId,
  sequence: 50,
  session: { status: "ready", lastError: null },
  turnId: turn1,
  running: false,
});

const runningObservation = (threadId: ThreadId): VoiceObserveThreadOutput => ({
  environment: { environmentId: envA, status: "ok" },
  threadId,
  sequence: 45,
  session: { status: "running", lastError: null },
  running: true,
});

const readThreadOutput = (threadId: ThreadId): VoiceReadThreadOutput => ({
  environment: { environmentId: envA, status: "ok" },
  thread: {
    threadId,
    projectId: projectA,
    title: "Research thread",
    sessionStatus: "ready",
    turns: [
      {
        turnId: turn1,
        createdAt: "2026-09-11T10:00:00.000Z",
        userText: "Research this",
        assistantText: "The final research answer.",
      },
    ],
  },
});

/** Bounded manual scheduler, same pattern as research.test.ts. */
const makeScheduler = () => {
  const queue: Array<() => void> = [];
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    schedule: (fn: () => void, _delayMs: number) => {
      queue.push(fn);
      return () => {
        const index = queue.indexOf(fn);
        if (index >= 0) {
          queue.splice(index, 1);
        }
      };
    },
    pump: async (max = 50) => {
      for (let index = 0; index < max && queue.length > 0; index += 1) {
        queue.shift()!();
        await flush();
      }
      return queue.length;
    },
    get pending() {
      return queue.length;
    },
  };
};

const hostFixture = (): VoiceToolHost => {
  const access = {
    serverConfig: vi.fn(async () => ({ providers: providersFixture() })),
  };
  return {
    catalogEnvironments: () => [
      {
        environmentId: envA,
        label: "Env A",
        connectionState: "connected" as const,
        isPrimary: true,
        voiceLiveCapable: true,
        scopes: ["orchestration:read", "orchestration:operate"],
      },
    ],
    openEnvironment: () => access as never,
  };
};

const executorFixture = () => ({
  startThread: vi.fn(async (input: { requestId: string }) =>
    startReceipt(threadA, input.requestId),
  ),
  observeThread: vi.fn(async (): Promise<VoiceObserveThreadOutput> => finishedObservation(threadA)),
  readThread: vi.fn(async (): Promise<VoiceReadThreadOutput> => readThreadOutput(threadA)),
});

interface FakeClient {
  client: VoiceLiveClient;
  steer: ReturnType<typeof vi.fn>;
  emitMark: ReturnType<typeof vi.fn>;
  emit: (event: VoiceLiveClientEvent) => void;
}

const makeFakeClient = (): FakeClient => {
  const steer = vi.fn((_content: string) => true);
  const emitMark = vi.fn();
  const listeners = new Set<(event: VoiceLiveClientEvent) => void>();
  const client: VoiceLiveClient = {
    start: vi.fn(async () => ({ sessionId: "sess-1" as never })),
    close: vi.fn(async () => {}),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emitMark: (mark: VoiceTimingMark, detail?: string) => emitMark(mark, detail),
    steer: (content: string) => steer(content),
    getState: () => "idle",
    getSessionId: () => undefined,
  };
  return {
    client,
    steer,
    emitMark,
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
};

interface ModuleHarness {
  module: ReturnType<typeof createVoiceModule>;
  executor: ReturnType<typeof executorFixture>;
  storage: VoiceKeyValueStorage;
  scheduler: ReturnType<typeof makeScheduler>;
  newClient: () => FakeClient;
}

/** Minimal client options for the rebinding wrapper (the injected factory
    ignores them; the real client needs a broker and peer-connection
    factory). */
const fakeClientOptions = (): VoiceLiveClientOptions => ({
  broker: { mintSession: vi.fn(), closeSession: vi.fn() },
  createPeerConnection: () => ({}) as never,
});

function makeModule(executor = executorFixture()): ModuleHarness {
  const storage = memoryStorage();
  const scheduler = makeScheduler();
  const clients: FakeClient[] = [];
  const module = createVoiceModule({
    host: hostFixture(),
    executor: executor as unknown as VoiceToolExecutor,
    createClient: () => {
      const fake = makeFakeClient();
      clients.push(fake);
      return fake.client;
    },
    storage,
    schedule: scheduler.schedule,
  });
  return {
    module,
    executor,
    storage,
    scheduler,
    newClient: () => clients[clients.length - 1]!,
  };
}

const delegateInput = (requestId: string) => ({
  requestId: requestId as never,
  environmentId: envA,
  projectId: projectA,
  task: "Research the Oracle rollout.",
  model: { kind: "profile", profile: "routine" } as const,
});

// ---------------------------------------------------------------------------
// Profile configuration surface
// ---------------------------------------------------------------------------

describe("worker-profile configuration surface", () => {
  it("round-trips routine and deep profiles through the storage key", () => {
    const storage = memoryStorage();
    saveVoiceWorkerProfilesConfig(
      {
        routine: { instanceId: "inst-a", model: "model-a" },
        deep: { instanceId: "inst-a", model: "model-b" },
      },
      storage,
    );
    expect(storage.getItem(VOICE_WORKER_PROFILES_STORAGE_KEY)).not.toBeNull();
    expect(readVoiceWorkerProfilesConfig(storage)).toEqual({
      routine: { instanceId: "inst-a", model: "model-a" },
      deep: { instanceId: "inst-a", model: "model-b" },
    });
  });

  it("reads an empty configuration when nothing is stored or the payload is malformed", () => {
    const storage = memoryStorage();
    expect(readVoiceWorkerProfilesConfig(storage)).toEqual({});
    storage.setItem(VOICE_WORKER_PROFILES_STORAGE_KEY, "{not json");
    expect(readVoiceWorkerProfilesConfig(storage)).toEqual({});
    storage.setItem(VOICE_WORKER_PROFILES_STORAGE_KEY, JSON.stringify(["nope"]));
    expect(readVoiceWorkerProfilesConfig(storage)).toEqual({});
  });

  it("decodes the valid subset of a partially malformed configuration", () => {
    expect(
      decodeVoiceWorkerProfilesConfig({
        routine: { instanceId: "inst-a", model: "model-a" },
        deep: { instanceId: 7 },
      }),
    ).toEqual({ routine: { instanceId: "inst-a", model: "model-a" } });
    expect(decodeVoiceWorkerProfilesConfig(null)).toEqual({});
  });

  it("fails model_unavailable for an unconfigured profile through the wired loader", async () => {
    const harness = makeModule();
    await expect(
      harness.module.research.delegate(delegateInput("req-unconfigured")),
    ).rejects.toBeInstanceOf(VoiceToolFailureError);
    await expect(
      harness.module.research.delegate(delegateInput("req-unconfigured-2")),
    ).rejects.toMatchObject({ error: { code: "model_unavailable" } });
    expect(harness.executor.startThread).not.toHaveBeenCalled();
  });

  it("uses the saved configuration for the next delegation without recreating the module", async () => {
    const harness = makeModule();
    harness.module.profiles.save({ routine: { instanceId: "inst-a", model: "model-a" } });
    const receipt = await harness.module.research.delegate(delegateInput("req-configured"));
    expect(receipt.threadId).toBe(threadA);
    expect(harness.executor.startThread).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// T5 baseBranch refusal coherence (T7-r4 integration re-check)
// ---------------------------------------------------------------------------

describe("worktree baseBranch refusal coherence through the module wiring", () => {
  /** An environment access boundary that cannot list refs (the optional
      `listRefs` capability is absent), a project that prefers worktree
      threads, and a thread-existence probe that misses (a new thread). */
  const noListRefsHost = () => {
    const access = {
      shellSnapshot: vi.fn(async () => ({
        projects: [
          {
            id: projectA,
            title: "Project A",
            workspaceRoot: "/tmp/project-a",
            defaultThreadEnvMode: "worktree",
          },
        ],
      })),
      threadSnapshot: vi.fn(async () => {
        throw { _tag: "EnvironmentResourceNotFoundError", message: "thread not found" };
      }),
      serverConfig: vi.fn(async () => ({
        providers: providersFixture(),
        settings: { newWorktreesStartFromOrigin: true },
      })),
      dispatchCommand: vi.fn(async () => ({ sequence: 42 })),
    };
    return {
      catalogEnvironments: () => [
        {
          environmentId: envA,
          label: "Env A",
          connectionState: "connected" as const,
          isPrimary: true,
          voiceLiveCapable: true,
          scopes: ["orchestration:read", "orchestration:operate"],
        },
      ],
      openEnvironment: () => access as never,
    } as unknown as VoiceToolHost;
  };

  it("surfaces the T5 refusal as a tool error through the real executor", async () => {
    const host = noListRefsHost();
    const executor = createVoiceToolExecutor(host);
    await expect(
      executor.startThread({
        requestId: "req-no-listrefs" as never,
        environmentId: envA,
        projectId: projectA,
        task: "Start work.",
        modelSelection: { instanceId: "inst-a" as never, model: "model-a" },
      }),
    ).rejects.toMatchObject({
      error: {
        code: "invalid_request",
        message: expect.stringContaining(projectA),
      },
    });
  });

  it("the delegation bridge propagates the refusal without announcing success", async () => {
    const host = noListRefsHost();
    const executor = createVoiceToolExecutor(host);
    const harness = makeModule(executor as unknown as ReturnType<typeof executorFixture>);
    harness.module.profiles.save({ routine: { instanceId: "inst-a", model: "model-a" } });
    const events: VoiceResearchBridgeEvent[] = [];
    harness.module.research.onEvent((event) => events.push(event));
    await expect(
      harness.module.research.delegate(delegateInput("req-no-listrefs-delegate")),
    ).rejects.toMatchObject({
      error: {
        code: "invalid_request",
        message: expect.stringContaining("cannot list refs"),
      },
    });
    // No success was announced: no delegation_started event, no dispatch.
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Client-durable delivery store
// ---------------------------------------------------------------------------

describe("web voice delivery store", () => {
  const watchingRecord = (): VoiceDeliveryRecord => ({
    requestId: "req-store-1" as VoiceDeliveryRecord["requestId"],
    environmentId: envA,
    projectId: projectA,
    threadId: threadA,
    afterSequence: 42,
    status: "watching",
    deliveredTurnIds: [],
  });

  it("round-trips a record through storage and upserts by request id", async () => {
    const storage = memoryStorage();
    const store = createWebVoiceDeliveryStore(storage);
    await store.save(watchingRecord());
    const record = (await store.load())[0]!;
    expect(record.status).toBe("watching");
    record.afterSequence = 50;
    await store.save(record);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.afterSequence).toBe(50);
  });

  it("returns an empty list for missing, malformed, or invalid stored payloads", async () => {
    const storage = memoryStorage();
    const store = createWebVoiceDeliveryStore(storage);
    expect(await store.load()).toEqual([]);
    storage.setItem(VOICE_DELIVERY_RECORDS_STORAGE_KEY, "not json");
    expect(await store.load()).toEqual([]);
    storage.setItem(
      VOICE_DELIVERY_RECORDS_STORAGE_KEY,
      JSON.stringify([{ requestId: "x" }, "junk", watchingRecord()]),
    );
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.threadId).toBe(threadA);
  });
});

// ---------------------------------------------------------------------------
// Module wiring: shared executor, steer/mark rebinding, recover on live
// ---------------------------------------------------------------------------

describe("voice module wiring", () => {
  it("exposes one shared executor instance across calls", () => {
    const harness = makeModule();
    expect(harness.module.executor).toBe(harness.module.executor);
    expect(harness.module.boundClient()).toBeUndefined();
  });

  it("binds steer and marks to the current client and rebinds per reconnect", async () => {
    const harness = makeModule();
    harness.module.profiles.save({ routine: { instanceId: "inst-a", model: "model-a" } });

    harness.module.createClient(fakeClientOptions());
    const first = harness.newClient();
    // One running observation (in-flight mark) before the finished one.
    let rebindObserveCount = 0;
    harness.executor.observeThread.mockImplementation(async () => {
      rebindObserveCount += 1;
      return rebindObserveCount === 1 ? runningObservation(threadA) : finishedObservation(threadA);
    });
    await harness.module.research.delegate(delegateInput("req-rebind-1"));
    await harness.scheduler.pump();

    // Delivery steered through the client that was current at delivery time.
    expect(first.steer).toHaveBeenCalledTimes(1);
    expect(first.steer.mock.calls[0]![0]).toContain("The final research answer.");
    expect(first.emitMark).toHaveBeenCalledWith("function_call_received", expect.any(String));
    expect(first.emitMark).toHaveBeenCalledWith("tool_done", expect.any(String));

    // Reconnect: the newer client becomes the steering/mark target; the old
    // client is never touched again.
    harness.module.createClient(fakeClientOptions());
    const second = harness.newClient();
    expect(harness.module.boundClient()).toBe(second.client);

    harness.executor.observeThread.mockImplementation(async () => finishedObservation(threadB));
    harness.executor.readThread.mockImplementation(async () => readThreadOutput(threadB));
    harness.executor.startThread.mockImplementation(async (input: { requestId: string }) =>
      startReceipt(threadB, input.requestId),
    );
    await harness.module.research.delegate(delegateInput("req-rebind-2"));
    await harness.scheduler.pump();

    expect(second.steer).toHaveBeenCalledTimes(1);
    expect(first.steer).toHaveBeenCalledTimes(1);
  });

  it("defers delivery (steer returns false) and recovers it after the next session goes live", async () => {
    const harness = makeModule();
    harness.module.profiles.save({ routine: { instanceId: "inst-a", model: "model-a" } });

    harness.module.createClient(fakeClientOptions());
    const ended = harness.newClient();
    ended.steer.mockReturnValue(false);
    const events: VoiceResearchBridgeEvent[] = [];
    harness.module.research.onEvent((event) => events.push(event));

    await harness.module.research.delegate(delegateInput("req-defer"));
    await harness.scheduler.pump();
    expect(ended.steer).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "delivery_deferred")).toBe(true);
    // The record stays watching in the durable store.
    const stored = await createWebVoiceDeliveryStore(harness.storage).load();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe("watching");
    expect(stored[0]!.deliveredTurnIds).toHaveLength(0);

    // Reconnect: a fresh client goes live, recovery re-arms observation and
    // delivers exactly once through the new session.
    harness.module.createClient(fakeClientOptions());
    const reconnected = harness.newClient();
    reconnected.emit({ type: "state", state: "live" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.scheduler.pump();

    expect(reconnected.steer).toHaveBeenCalledTimes(1);
    expect(reconnected.steer.mock.calls[0]![0]).toContain("The final research answer.");
    const delivered = await createWebVoiceDeliveryStore(harness.storage).load();
    expect(delivered[0]!.deliveredTurnIds).toHaveLength(1);
    // A second recovery attempt delivers nothing further.
    reconnected.emit({ type: "state", state: "live" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.scheduler.pump();
    expect(reconnected.steer).toHaveBeenCalledTimes(1);
  });

  it("resumes a persisted watching record from the store when a fresh session goes live", async () => {
    const harness = makeModule();
    const store = createWebVoiceDeliveryStore(harness.storage);
    await store.save({
      requestId: "req-persisted" as VoiceDeliveryRecord["requestId"],
      environmentId: envA,
      projectId: projectA,
      threadId: threadA,
      afterSequence: 42,
      status: "watching",
      deliveredTurnIds: [],
    });

    harness.module.createClient(fakeClientOptions());
    const client = harness.newClient();
    client.emit({ type: "state", state: "live" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.scheduler.pump();

    expect(harness.executor.observeThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: envA, threadId: threadA, afterSequence: 42 }),
    );
    expect(client.steer).toHaveBeenCalledTimes(1);
  });

  it("does not trigger recovery for non-live state events", async () => {
    const harness = makeModule();
    harness.module.createClient(fakeClientOptions());
    const client = harness.newClient();
    client.emit({ type: "state", state: "closed" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(harness.executor.observeThread).not.toHaveBeenCalled();
  });

  it("disposes the research bridge and drops the client binding", async () => {
    const harness = makeModule();
    harness.module.createClient(fakeClientOptions());
    expect(harness.module.boundClient()).toBeDefined();
    harness.module.dispose();
    expect(harness.module.boundClient()).toBeUndefined();
    await harness.scheduler.pump();
    // No observation work after dispose: no records were watching.
    expect(harness.executor.observeThread).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Resource cleanup (manager correction): controller disposal semantics
// ---------------------------------------------------------------------------

interface DisposableMic extends VoiceMicController {
  readonly stopped: boolean;
}

const makeDisposableMic = (): DisposableMic & { stop: ReturnType<typeof vi.fn> } => {
  const track = { kind: "audio", enabled: true } as unknown as VoiceLiveMediaStreamTrack & {
    enabled: boolean;
  };
  const stop = vi.fn(() => {
    track.enabled = false;
  });
  return {
    track: track as VoiceMicController["track"],
    setMuted: (muted) => {
      track.enabled = !muted;
    },
    stop,
    get stopped() {
      return stop.mock.calls.length > 0;
    },
  };
};

interface LifecycleClientHarness {
  client: VoiceLiveClient;
  readonly close: ReturnType<typeof vi.fn>;
  readonly emit: (event: VoiceLiveClientEvent) => void;
  /** Arms the start gate so the next start() stays pending until
      releaseStart() (for the end-during-pending-start tests). */
  holdStart: () => void;
  releaseStart: () => void;
}

const makeLifecycleClient = (): LifecycleClientHarness => {
  const listeners = new Set<(event: VoiceLiveClientEvent) => void>();
  // Mirrors the corrected real client: once close ran, a pending/late start
  // settles without ever transitioning to live.
  let closeRan = false;
  const close = vi.fn(async () => {
    closeRan = true;
    for (const listener of listeners) {
      listener({ type: "state", state: "closed" });
    }
  });
  let holdNextStart = false;
  let startRelease: (() => void) | undefined;
  const client: VoiceLiveClient = {
    start: vi.fn(async () => {
      if (holdNextStart) {
        holdNextStart = false;
        await new Promise<void>((resolve) => {
          startRelease = resolve;
        });
      }
      if (!closeRan) {
        for (const listener of listeners) {
          listener({ type: "state", state: "live" });
        }
      }
      return { sessionId: "sess-1" as never };
    }),
    close,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emitMark: () => {},
    steer: () => true,
    getState: () => "live",
    getSessionId: () => undefined,
  };
  return {
    client,
    close,
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    holdStart: () => {
      holdNextStart = true;
    },
    releaseStart: () => {
      startRelease?.();
      startRelease = undefined;
    },
  };
};

interface ControllerHarness {
  controller: ReturnType<typeof createVoicePanelController>;
  readonly mic: ReturnType<typeof makeDisposableMic>;
  readonly clients: LifecycleClientHarness[];
  readonly brokerResolutions: { count: number };
  /** Arms the mic-capture gate so the next capture stays pending until
      releaseMic() (for the disposal-race test); default resolves instantly. */
  holdMic: () => void;
  releaseMic: () => void;
  /** Arms the broker-port gate so the next resolution stays pending until
      releaseBroker() (for the end-during-pending-resolution tests). */
  holdBroker: () => void;
  releaseBroker: () => void;
  /** Gates the start of the next created client until its releaseStart(). */
  holdNextClientStart: () => void;
}

const makeControllerHarness = (): ControllerHarness => {
  const mic = makeDisposableMic();
  const clients: LifecycleClientHarness[] = [];
  const brokerResolutions = { count: 0 };
  let micGate: ((mic: VoiceMicController) => void) | undefined;
  let brokerGate: (() => void) | undefined;
  let holdNextBroker = false;
  let holdNextClientStart = false;
  const controller = createVoicePanelController({
    resolveBrokerPort: async () => {
      brokerResolutions.count += 1;
      if (holdNextBroker) {
        holdNextBroker = false;
        await new Promise<void>((resolve) => {
          brokerGate = resolve;
        });
      }
      return { mintSession: vi.fn(), closeSession: vi.fn() };
    },
    captureMic: () =>
      micGate !== undefined
        ? new Promise<VoiceMicController>((resolve) => {
            micGate = resolve;
          })
        : Promise.resolve(mic),
    createToolsExecutor: () => ({}) as never,
    driver: {
      navigate: async () => {},
      readCurrentPath: () => "/",
      subscribePathChange: () => () => {},
    },
    reachabilityOf: () => "connected",
    attachSpeakerTrack: () => {},
    createClient: () => {
      const harness = makeLifecycleClient();
      if (holdNextClientStart) {
        holdNextClientStart = false;
        harness.holdStart();
      }
      clients.push(harness);
      return harness.client;
    },
  });
  return {
    controller,
    mic,
    clients,
    brokerResolutions,
    holdMic: () => {
      micGate = () => {};
    },
    releaseMic: () => {
      micGate?.(mic);
      micGate = undefined;
    },
    holdBroker: () => {
      holdNextBroker = true;
    },
    releaseBroker: () => {
      brokerGate?.();
      brokerGate = undefined;
    },
    holdNextClientStart: () => {
      holdNextClientStart = true;
    },
  };
};

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("voice panel controller disposal", () => {
  it("unmount during live ends the session, stops the mic, and detaches late events", async () => {
    const harness = makeControllerHarness();
    await harness.controller.connect();
    expect(harness.controller.getState().phase).toBe("live");
    expect(harness.clients).toHaveLength(1);

    harness.controller.dispose();

    expect(harness.clients[0]!.close).toHaveBeenCalledTimes(1);
    expect(harness.mic.stop).toHaveBeenCalledTimes(1);
    expect(harness.controller.getState().phase).toBe("closed");

    // Late client events after disposal apply no state.
    harness.clients[0]!.emit({
      type: "transcript",
      channel: "input",
      delta: "late",
      utterance: "in-1",
    });
    expect(harness.controller.getState().utterances).toEqual([]);
  });

  it("disposal while a connect is pending acquires nothing afterward", async () => {
    const harness = makeControllerHarness();
    harness.holdMic();
    const connectPromise = harness.controller.connect();
    harness.controller.dispose();
    harness.releaseMic();
    await connectPromise;
    await flushMicrotasks();

    // The captured mic is released; the broker is never asked for a port and
    // no client is ever created.
    expect(harness.mic.stop).toHaveBeenCalledTimes(1);
    expect(harness.brokerResolutions.count).toBe(0);
    expect(harness.clients).toHaveLength(0);
    expect(harness.controller.getState().phase).toBe("idle");
  });

  it("disposal is idempotent (strict-mode double cleanup is a no-op)", async () => {
    const harness = makeControllerHarness();
    await harness.controller.connect();
    harness.controller.dispose();
    harness.controller.dispose();
    expect(harness.clients[0]!.close).toHaveBeenCalledTimes(1);
    expect(harness.mic.stop).toHaveBeenCalledTimes(1);
  });

  it("explicit use after disposal revives the controller (StrictMode remount path)", async () => {
    const harness = makeControllerHarness();
    await harness.controller.connect();
    harness.controller.dispose();
    expect(harness.controller.getState().phase).toBe("closed");

    // A remounted panel re-subscribes to the same instance, then connects
    // again: the display shell revives and a fresh session works.
    const unsubscribe = harness.controller.subscribe(() => {});
    await harness.controller.connect();
    expect(harness.controller.getState().phase).toBe("live");
    expect(harness.clients).toHaveLength(2);
    unsubscribe();
  });

  it("ending on capability or operate-scope loss closes the session and mic readably", async () => {
    const harness = makeControllerHarness();
    await harness.controller.connect();
    expect(harness.controller.getState().phase).toBe("live");

    // The panel's selection-loss effect calls end(); the session closes
    // through the existing lifecycle and the phase is readable.
    await harness.controller.end();
    expect(harness.clients[0]!.close).toHaveBeenCalledTimes(1);
    expect(harness.mic.stop).toHaveBeenCalledTimes(1);
    expect(harness.controller.getState().phase).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Resource cleanup (manager correction): module disposal semantics
// ---------------------------------------------------------------------------

describe("voice module disposal", () => {
  it("dispose leaves a pending delivery watching (at-least-once preserved), and reconnect after the disposal cycle still recovers delivery once", async () => {
    const harness = makeModule();
    harness.module.profiles.save({ routine: { instanceId: "inst-a", model: "model-a" } });
    const events: VoiceResearchBridgeEvent[] = [];
    harness.module.research.onEvent((event) => events.push(event));

    // A live session that cannot steer: the delivery defers.
    harness.module.createClient(fakeClientOptions());
    const ended = harness.newClient();
    ended.steer.mockReturnValue(false);
    await harness.module.research.delegate(delegateInput("req-dispose-recover"));
    await harness.scheduler.pump();
    expect(events.some((event) => event.type === "delivery_deferred")).toBe(true);

    // Unmount disposal: the pending delivery is NOT marked delivered.
    harness.module.dispose();
    const storedAfterDispose = await createWebVoiceDeliveryStore(harness.storage).load();
    expect(storedAfterDispose).toHaveLength(1);
    expect(storedAfterDispose[0]!.status).toBe("watching");
    expect(storedAfterDispose[0]!.deliveredTurnIds).toHaveLength(0);

    // Remount + reconnect: the module re-arms a fresh observation bridge over
    // the same durable store and delivers exactly once through the new
    // session.
    harness.module.createClient(fakeClientOptions());
    const reconnected = harness.newClient();
    reconnected.emit({ type: "state", state: "live" });
    await flushMicrotasks();
    await harness.scheduler.pump();

    expect(reconnected.steer).toHaveBeenCalledTimes(1);
    expect(ended.steer).toHaveBeenCalledTimes(1);
    const storedAfterRecovery = await createWebVoiceDeliveryStore(harness.storage).load();
    expect(storedAfterRecovery[0]!.deliveredTurnIds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cancellation gaps (parent check 4, correction 3): end() must invalidate a
// pending connect(); disposal must not let an old attempt resume.
// ---------------------------------------------------------------------------

describe("controller end() invalidates a pending connect", () => {
  it("end during pending captureMic: no session is established after the user ended it", async () => {
    const harness = makeControllerHarness();
    harness.holdMic();
    const connectPromise = harness.controller.connect();
    await flushMicrotasks();
    await harness.controller.end();
    expect(harness.controller.getState().phase).toBe("idle");

    // The capture lands after the user ended: released, nothing acquired.
    harness.releaseMic();
    await connectPromise;
    await flushMicrotasks();

    expect(harness.mic.stop).toHaveBeenCalled();
    expect(harness.brokerResolutions.count).toBe(0);
    expect(harness.clients).toHaveLength(0);
    expect(harness.controller.getState().phase).toBe("idle");
  });

  it("end during pending resolveBrokerPort: mic released, no client created", async () => {
    const harness = makeControllerHarness();
    harness.holdBroker();
    const connectPromise = harness.controller.connect();
    await flushMicrotasks();
    expect(harness.mic.stop).not.toHaveBeenCalled();
    await harness.controller.end();
    expect(harness.mic.stop).toHaveBeenCalledTimes(1);
    expect(harness.controller.getState().phase).toBe("idle");

    harness.releaseBroker();
    await connectPromise;
    await flushMicrotasks();

    expect(harness.clients).toHaveLength(0);
    expect(harness.controller.getState().phase).toBe("idle");
  });

  it("end during pending client.start: the session closes through the lifecycle", async () => {
    const harness = makeControllerHarness();
    // Gate the start of the client this attempt will create.
    harness.holdNextClientStart();
    const connectPromise = harness.controller.connect();
    await flushMicrotasks();
    const pending = harness.clients[0]!;

    // end() while start is pending: the client exists, so end closes it
    // through the existing lifecycle and the phase settles readably.
    await harness.controller.end();
    expect(pending.close).toHaveBeenCalledTimes(1);
    expect(harness.mic.stop).toHaveBeenCalled();
    expect(harness.controller.getState().phase).toBe("closed");

    // The late start resolution establishes nothing new.
    pending.releaseStart();
    await connectPromise;
    await flushMicrotasks();

    expect(harness.clients).toHaveLength(1);
    expect(harness.controller.getState().phase).toBe("closed");
  });

  it("dispose then revive while the old attempt is mid-flight: the old attempt never resumes or clobbers the newer connection", async () => {
    const harness = makeControllerHarness();
    harness.holdBroker();
    const oldAttempt = harness.controller.connect();
    await flushMicrotasks();

    // Unmount disposes (invalidating the old attempt), StrictMode-style
    // remount re-subscribes (reviving the shell), then the user connects
    // again once the old attempt has settled.
    harness.controller.dispose();
    const unsubscribe = harness.controller.subscribe(() => {});
    harness.releaseBroker();
    await oldAttempt;
    await flushMicrotasks();

    // The revived controller must run a genuinely new attempt: the broker is
    // resolved a second time (a resumed old attempt would reuse its already
    // resolved port and the new connect would be refused by the phase guard).
    await harness.controller.connect();
    expect(harness.brokerResolutions.count).toBe(2);
    expect(harness.clients).toHaveLength(1);
    expect(harness.controller.getState().phase).toBe("live");
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Cancellation gaps (parent check 4, correction 3): the module's research
// recovery listener must be retained, swapped per client, and fenced.
// ---------------------------------------------------------------------------

const seedWatchingRecord = async (
  storage: VoiceKeyValueStorage,
  requestId: string,
): Promise<void> => {
  await createWebVoiceDeliveryStore(storage).save({
    requestId: requestId as VoiceDeliveryRecord["requestId"],
    environmentId: envA,
    projectId: projectA,
    threadId: threadA,
    afterSequence: 42,
    status: "watching",
    deliveredTurnIds: [],
  });
};

describe("module research recovery listener", () => {
  it("a late old-client live event after module disposal does not recreate the bridge", async () => {
    const harness = makeModule();
    await seedWatchingRecord(harness.storage, "req-late-listener");
    harness.module.createClient(fakeClientOptions());
    const oldClient = harness.newClient();
    harness.module.dispose();

    // The disposed module's old client fires its live event late: no revival,
    // no recovery work.
    oldClient.emit({ type: "state", state: "live" });
    await flushMicrotasks();
    await harness.scheduler.pump();
    expect(harness.executor.observeThread).not.toHaveBeenCalled();
  });

  it("replaced and disposed clients' late live events never recover or revive; the new session's live event re-arms recovery", async () => {
    const harness = makeModule();
    await seedWatchingRecord(harness.storage, "req-fence");
    harness.module.createClient(fakeClientOptions());
    const first = harness.newClient();
    first.emit({ type: "state", state: "live" });
    await flushMicrotasks();
    await harness.scheduler.pump();
    expect(first.steer).toHaveBeenCalledTimes(1);

    // Reconnect: the first client is replaced and detached...
    harness.module.createClient(fakeClientOptions());
    const second = harness.newClient();
    // ...then the module is disposed (unmount).
    harness.module.dispose();

    // Both old clients fire late live events: no revival, no recovery work.
    const observationsAfterDispose = harness.executor.observeThread.mock.calls.length;
    first.emit({ type: "state", state: "live" });
    second.emit({ type: "state", state: "live" });
    await flushMicrotasks();
    await harness.scheduler.pump();
    expect(harness.executor.observeThread.mock.calls.length).toBe(observationsAfterDispose);

    // Revival control: a genuinely new client going live re-arms recovery
    // over the same durable store and delivers nothing further (already
    // delivered under its key).
    harness.module.createClient(fakeClientOptions());
    const revived = harness.newClient();
    revived.emit({ type: "state", state: "live" });
    await flushMicrotasks();
    await harness.scheduler.pump(1);
    expect(harness.executor.observeThread.mock.calls.length).toBeGreaterThan(
      observationsAfterDispose,
    );
    expect(revived.steer).not.toHaveBeenCalled();
  });

  it("a repeated live event on the same session does not re-arm recovery twice", async () => {
    const harness = makeModule();
    await seedWatchingRecord(harness.storage, "req-once");
    harness.module.createClient(fakeClientOptions());
    const client = harness.newClient();
    client.emit({ type: "state", state: "live" });
    await flushMicrotasks();
    await harness.scheduler.pump(1);
    const afterFirst = harness.executor.observeThread.mock.calls.length;

    client.emit({ type: "state", state: "live" });
    await flushMicrotasks();
    expect(harness.executor.observeThread.mock.calls.length).toBe(afterFirst);
  });
});
