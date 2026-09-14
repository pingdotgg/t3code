import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  VoiceSessionId,
  type VoiceObserveThreadOutput,
  type VoiceReadThreadOutput,
  type VoiceStartThreadOutput,
  type VoiceToolError,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createVoiceLiveClient,
  type VoiceLiveRtcDataChannel,
  type VoiceLiveRtcPeerConnection,
  type VoiceLiveSessionDescription,
} from "./live-client";
import {
  createInMemoryVoiceDeliveryStore,
  createResearchBridge,
  DEFAULT_RESEARCH_POLL_INTERVAL_MS,
  resolveWorkerModelSelection,
  type VoiceDeliveryRecord,
  type VoiceDeliveryStore,
  type VoiceResearchBridgeEvent,
  type VoiceWorkerProfilesConfig,
} from "./research";
import { VoiceToolFailureError, type VoiceToolExecutor, type VoiceToolHost } from "./tools";

const envA = EnvironmentId.make("env-a");
const projectA = ProjectId.make("project-a");
const threadA = ThreadId.make("0aaaaaaa-0000-4000-8000-000000000001");
const turn1 = TurnId.make("turn-1");
const turn2 = TurnId.make("turn-2");
const commandA = CommandId.make("0bbbbbbb-0000-4000-8000-000000000001");
const messageA = MessageId.make("0ccccccc-0000-4000-8000-000000000001");
const requestId = "voice-request-t6-1" as VoiceStartThreadOutput["requestId"];

// ---------------------------------------------------------------------------
// Fixtures (prepared-connection and executor boundaries mocked; no network)
// ---------------------------------------------------------------------------

const providersFixture = () => [
  {
    instanceId: "inst-a",
    driver: "claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-02T10:00:00.000Z",
    models: [
      { slug: "model-a", name: "Model A", isCustom: false, capabilities: null },
      { slug: "model-b", name: "Model B", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  },
];

const profilesFixture = (): VoiceWorkerProfilesConfig => ({
  routine: { instanceId: "inst-a", model: "model-a" },
  deep: { instanceId: "inst-a", model: "model-b" },
});

const startReceipt = (overrides?: {
  requestId?: VoiceStartThreadOutput["requestId"];
  threadId?: ThreadId;
  dispatchSequence?: number;
}): VoiceStartThreadOutput => ({
  requestId: overrides?.requestId ?? requestId,
  environment: { environmentId: envA, status: "ok" },
  commandId: commandA,
  threadId: overrides?.threadId ?? threadA,
  messageId: messageA,
  dispatchSequence: overrides?.dispatchSequence ?? 42,
  session: { status: "running", lastError: null },
});

const runningObservation = (sequence: number): VoiceObserveThreadOutput => ({
  environment: { environmentId: envA, status: "ok" },
  threadId: threadA,
  sequence,
  session: { status: "running", lastError: null },
  running: true,
});

const finishedObservation = (
  sequence: number,
  turnId: TurnId,
  status: "ready" | "idle" = "ready",
): VoiceObserveThreadOutput => ({
  environment: { environmentId: envA, status: "ok" },
  threadId: threadA,
  sequence,
  session: { status, lastError: null },
  turnId,
  running: false,
});

const errorObservation = (
  sequence: number,
  lastError: string | null,
): VoiceObserveThreadOutput => ({
  environment: { environmentId: envA, status: "ok" },
  threadId: threadA,
  sequence,
  session: { status: "error", lastError },
  turnId: turn1,
  running: false,
});

const readThreadOutput = (
  assistantText: string | null,
  turnId: TurnId = turn1,
): VoiceReadThreadOutput => ({
  environment: { environmentId: envA, status: "ok" },
  thread: {
    threadId: threadA,
    projectId: projectA,
    title: "Research thread",
    sessionStatus: "ready",
    turns: [
      {
        turnId,
        createdAt: "2026-09-11T10:00:00.000Z",
        userText: "Research this",
        assistantText,
      },
    ],
  },
});

/** Bounded manual scheduler: steps queue up and tests pump them one by one. */
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
    /** Runs at most `max` queued steps, awaiting each async step. Returns
        the number of steps still queued. */
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
    clear() {
      queue.length = 0;
    },
  };
};

interface BridgeHarness {
  bridge: ReturnType<typeof createResearchBridge>;
  executor: {
    startThread: ReturnType<typeof vi.fn>;
    observeThread: ReturnType<typeof vi.fn>;
    readThread: ReturnType<typeof vi.fn>;
  };
  steer: ReturnType<typeof vi.fn>;
  marks: Array<{ mark: string; detail?: string }>;
  events: VoiceResearchBridgeEvent[];
  store: VoiceDeliveryStore;
  scheduler: ReturnType<typeof makeScheduler>;
}

interface BridgeOverrides {
  profiles?: VoiceWorkerProfilesConfig | (() => Promise<VoiceWorkerProfilesConfig>);
  providers?: unknown;
  steerResult?: boolean;
  deliveryChannel?: "fallback" | "commentary";
  observeOutputs?: Array<VoiceObserveThreadOutput | { reject: VoiceToolError }>;
  readResult?: VoiceReadThreadOutput | { failWith: VoiceToolError };
  store?: VoiceDeliveryStore;
}

function makeBridge(overrides: BridgeOverrides = {}): BridgeHarness {
  const scheduler = makeScheduler();
  const marks: Array<{ mark: string; detail?: string }> = [];
  const events: VoiceResearchBridgeEvent[] = [];
  const store = overrides.store ?? createInMemoryVoiceDeliveryStore();

  const access = {
    serverConfig: vi.fn(async () => ({ providers: overrides.providers ?? providersFixture() })),
  };
  const host: VoiceToolHost = {
    catalogEnvironments: vi.fn(() => [
      {
        environmentId: envA,
        label: "Env A",
        connectionState: "connected" as const,
        isPrimary: true,
        voiceLiveCapable: true,
        scopes: ["orchestration:read", "orchestration:operate"],
      },
    ]),
    openEnvironment: vi.fn(() => access as never),
  };

  const observeQueue = [...(overrides.observeOutputs ?? [])];
  const executor = {
    startThread: vi.fn(async (): Promise<VoiceStartThreadOutput> => startReceipt()),
    observeThread: vi.fn(async (): Promise<VoiceObserveThreadOutput> => {
      const next = observeQueue.shift();
      if (next === undefined) {
        throw new VoiceToolFailureError({
          code: "environment_unreachable",
          message: "observe queue exhausted",
        });
      }
      if ("reject" in next) {
        throw new VoiceToolFailureError(next.reject);
      }
      return next;
    }),
    readThread: vi.fn(async (): Promise<VoiceReadThreadOutput> => {
      const read = overrides.readResult;
      if (read !== undefined && "failWith" in read) {
        throw new VoiceToolFailureError(read.failWith);
      }
      return read ?? readThreadOutput("The final research answer.");
    }),
  };

  const steer = vi.fn(() => overrides.steerResult ?? true);

  const bridge = createResearchBridge({
    host,
    executor: executor as unknown as Pick<
      VoiceToolExecutor,
      "startThread" | "observeThread" | "readThread"
    >,
    profiles: overrides.profiles ?? profilesFixture(),
    steer,
    emitMark: (mark, detail) => marks.push({ mark, ...(detail !== undefined ? { detail } : {}) }),
    schedule: scheduler.schedule,
    pollIntervalMs: DEFAULT_RESEARCH_POLL_INTERVAL_MS,
    store,
    ...(overrides.deliveryChannel !== undefined
      ? { deliveryChannel: overrides.deliveryChannel }
      : {}),
  });
  bridge.onEvent((event) => events.push(event));

  return { bridge, executor, steer, marks, events, store, scheduler };
}

async function failureOf(run: () => Promise<unknown>): Promise<VoiceToolFailureError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof VoiceToolFailureError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the call to reject with VoiceToolFailureError.");
}

const savedRecords = async (
  store: VoiceDeliveryStore,
): Promise<ReadonlyArray<VoiceDeliveryRecord>> => store.load();

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

describe("resolveWorkerModelSelection", () => {
  it("resolves the configured routine and deep profiles", () => {
    const config = profilesFixture();
    expect(resolveWorkerModelSelection({ kind: "profile", profile: "routine" }, config)).toEqual({
      instanceId: "inst-a",
      model: "model-a",
    });
    expect(resolveWorkerModelSelection({ kind: "profile", profile: "deep" }, config)).toEqual({
      instanceId: "inst-a",
      model: "model-b",
    });
  });

  it("passes an explicit user-stated model through unchanged", () => {
    expect(
      resolveWorkerModelSelection(
        { kind: "explicit", instanceId: "inst-x", model: "model-x" },
        profilesFixture(),
      ),
    ).toEqual({ instanceId: "inst-x", model: "model-x" });
  });

  it("fails model_unavailable for an unconfigured profile instead of falling back", async () => {
    const failure = await failureOf(() =>
      Promise.resolve().then(() =>
        resolveWorkerModelSelection(
          { kind: "profile", profile: "deep" },
          { routine: { instanceId: "inst-a", model: "model-a" } },
        ),
      ),
    );
    expect(failure.error.code).toBe("model_unavailable");
    expect(failure.error.message).toContain("deep");
  });
});

// ---------------------------------------------------------------------------
// Delegation: quick receipt, gating, permissions
// ---------------------------------------------------------------------------

describe("delegate", () => {
  it("resolves the thread/task receipt immediately without blocking on the worker", async () => {
    const harness = makeBridge({
      observeOutputs: [runningObservation(43)],
    });
    const receipt = await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research the deployment failure",
      model: { kind: "profile", profile: "routine" },
    });
    expect(receipt.threadId).toBe(threadA);
    expect(receipt.dispatchSequence).toBe(42);
    expect(receipt.session).toEqual({ status: "running", lastError: null });
    // Quick receipt: no observation has run yet.
    expect(harness.executor.observeThread).not.toHaveBeenCalled();
    expect(harness.events[0]).toMatchObject({
      type: "delegation_started",
      threadId: threadA,
      model: { instanceId: "inst-a", model: "model-a" },
    });
    harness.bridge.dispose();
  });

  it("passes the creation through T5's path untouched: no runtimeMode, no own dispatch", async () => {
    const harness = makeBridge();
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "deep" },
    });
    expect(harness.executor.startThread).toHaveBeenCalledTimes(1);
    const input = harness.executor.startThread.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toEqual({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      modelSelection: { instanceId: "inst-a", model: "model-b" },
    });
    expect("runtimeMode" in input).toBe(false);
    harness.bridge.dispose();
  });

  it("validates the resolved profile model against the environment and fails model_unavailable before dispatch", async () => {
    const harness = makeBridge({
      providers: [
        {
          instanceId: "inst-a",
          driver: "claude",
          enabled: true,
          installed: true,
          version: "1",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-09-02T10:00:00.000Z",
          models: [{ slug: "other-model", name: "Other", isCustom: false, capabilities: null }],
          slashCommands: [],
          skills: [],
        },
      ],
    });
    const failure = await failureOf(() =>
      harness.bridge.delegate({
        requestId,
        environmentId: envA,
        projectId: projectA,
        task: "Research it",
        model: { kind: "profile", profile: "routine" },
      }),
    );
    expect(failure.error.code).toBe("model_unavailable");
    expect(failure.error.model).toBe("model-a");
    expect(harness.executor.startThread).not.toHaveBeenCalled();
    harness.bridge.dispose();
  });

  it("validates an explicit user-stated model the same way", async () => {
    const harness = makeBridge({ providers: [{ instanceId: "inst-x", enabled: false }] });
    const failure = await failureOf(() =>
      harness.bridge.delegate({
        requestId,
        environmentId: envA,
        projectId: projectA,
        task: "Research it",
        model: { kind: "explicit", instanceId: "inst-x", model: "model-x" },
      }),
    );
    expect(failure.error.code).toBe("model_unavailable");
    expect(harness.executor.startThread).not.toHaveBeenCalled();
    harness.bridge.dispose();
  });

  it("refuses a fabricated environment from the catalog without any network call", async () => {
    const harness = makeBridge();
    const failure = await failureOf(() =>
      harness.bridge.delegate({
        requestId,
        environmentId: EnvironmentId.make("nope"),
        projectId: projectA,
        task: "Research it",
        model: { kind: "profile", profile: "routine" },
      }),
    );
    expect(failure.error.code).toBe("environment_not_in_catalog");
    expect(harness.executor.startThread).not.toHaveBeenCalled();
    harness.bridge.dispose();
  });

  it("loads profile configuration lazily through the injected loader", async () => {
    const harness = makeBridge({
      profiles: async () => ({ routine: { instanceId: "inst-a", model: "model-b" } }),
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    const input = harness.executor.startThread.mock.calls[0]![0] as {
      modelSelection: { model: string };
    };
    expect(input.modelSelection.model).toBe("model-b");
    harness.bridge.dispose();
  });
});

// ---------------------------------------------------------------------------
// Observation, exactly-once delivery, (threadId, turnId) keying
// ---------------------------------------------------------------------------

describe("observation and delivery (fallback channel)", () => {
  it("delivers the result once, keyed by (threadId, turnId), with afterSequence resume", async () => {
    const harness = makeBridge({
      observeOutputs: [runningObservation(43), finishedObservation(44, turn1)],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();

    // Observation used the creation receipt sequence as the resume cursor.
    expect(harness.executor.observeThread.mock.calls[0]![0]).toMatchObject({
      environmentId: envA,
      threadId: threadA,
      afterSequence: 42,
    });
    expect(harness.executor.observeThread.mock.calls[1]![0]).toMatchObject({ afterSequence: 43 });

    expect(harness.steer).toHaveBeenCalledTimes(1);
    const content = harness.steer.mock.calls[0]![0] as string;
    expect(content).toContain(threadA);
    expect(content).toContain(turn1);
    expect(content).toContain("The final research answer.");
    expect(content).toContain("voice.readThread");

    const deliveredEvents = harness.events.filter((event) => event.type === "delivered");
    expect(deliveredEvents).toHaveLength(1);
    expect(deliveredEvents[0]).toMatchObject({
      type: "delivered",
      threadId: threadA,
      turnId: turn1,
      channel: "fallback",
    });
    const [record] = await savedRecords(harness.store);
    expect(record?.deliveredTurnIds).toEqual([`${threadA}:${turn1}`]);
    expect(record?.afterSequence).toBe(44);
    harness.bridge.dispose();
  });

  it("never delivers twice for duplicate terminal events on the same turn", async () => {
    const harness = makeBridge({
      observeOutputs: [
        finishedObservation(43, turn1),
        finishedObservation(44, turn1),
        finishedObservation(45, turn1),
      ],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();
    expect(harness.steer).toHaveBeenCalledTimes(1);
    harness.bridge.dispose();
  });

  it("delivers a second turn on the same thread separately under its own key", async () => {
    const harness = makeBridge({
      observeOutputs: [
        finishedObservation(43, turn1),
        // A later follow-up turn starts and finishes on the same thread.
        runningObservation(45),
        finishedObservation(46, turn2),
      ],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();

    expect(harness.steer).toHaveBeenCalledTimes(2);
    expect(harness.events.filter((event) => event.type === "delivered")).toHaveLength(2);
    const [record] = await savedRecords(harness.store);
    expect(record?.deliveredTurnIds).toEqual([`${threadA}:${turn1}`, `${threadA}:${turn2}`]);
    harness.bridge.dispose();
  });

  it("defers delivery when the voice session cannot steer and delivers exactly once after reconnect", async () => {
    const harness = makeBridge({
      steerResult: false,
      observeOutputs: [finishedObservation(43, turn1)],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();
    // The bridge asked the (refusing) steering channel once; the content was
    // not accepted, so nothing was delivered.
    expect(harness.steer).toHaveBeenCalledTimes(1);
    expect(harness.events.some((event) => event.type === "delivery_deferred")).toBe(true);
    expect(harness.events.some((event) => event.type === "delivered")).toBe(false);
    // Polling suspended while delivery is deferred.
    expect(harness.scheduler.pending).toBe(0);

    // Reconnect: the same bridge re-arms the suspended record.
    harness.steer.mockImplementation(() => true);
    harness.executor.observeThread.mockImplementation(async () => finishedObservation(43, turn1));
    const resumed = await harness.bridge.recover();
    expect(resumed).toBe(1);
    await harness.scheduler.pump();
    expect(harness.steer).toHaveBeenCalledTimes(2);
    expect(harness.events.some((event) => event.type === "delivered")).toBe(true);

    // A second recovery does not deliver twice: the steering channel saw
    // only the refused attempt plus the one accepted delivery.
    const deliveredCount = harness.events.filter((event) => event.type === "delivered").length;
    const resumedAgain = await harness.bridge.recover();
    await harness.scheduler.pump();
    expect(harness.steer).toHaveBeenCalledTimes(2);
    expect(harness.events.filter((event) => event.type === "delivered")).toHaveLength(
      deliveredCount,
    );
    expect(resumedAgain).toBe(0);
    harness.bridge.dispose();
  });

  it("delivers once after a full client restart via the persisted pending mapping", async () => {
    const store = createInMemoryVoiceDeliveryStore();
    const first = makeBridge({
      store,
      observeOutputs: [finishedObservation(43, turn1)],
    });
    await first.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await first.scheduler.pump();
    expect(first.steer).toHaveBeenCalledTimes(1);
    first.bridge.dispose();

    // A fresh bridge (page reload) recovers from the shared store.
    const second = makeBridge({
      store,
      observeOutputs: [finishedObservation(43, turn1)],
    });
    const resumed = await second.bridge.recover();
    expect(resumed).toBe(1);
    await second.scheduler.pump(1);
    // Already delivered under the persisted (threadId, turnId) key.
    expect(second.steer).not.toHaveBeenCalled();
    expect(second.executor.observeThread).toHaveBeenCalledTimes(1);
    // Resume cursor came from the persisted record.
    expect(second.executor.observeThread.mock.calls[0]![0]).toMatchObject({ afterSequence: 43 });
    second.bridge.dispose();
  });
});

// ---------------------------------------------------------------------------
// Delivery channels
// ---------------------------------------------------------------------------

describe("delivery channels", () => {
  it("commentary channel steers the bare result text", async () => {
    const harness = makeBridge({
      deliveryChannel: "commentary",
      observeOutputs: [finishedObservation(43, turn1)],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();
    expect(harness.steer).toHaveBeenCalledWith("The final research answer.");
    const delivered = harness.events.filter((event) => event.type === "delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ type: "delivered", channel: "commentary" });
    harness.bridge.dispose();
  });

  it("reports a finished turn without a final message as a readable failure, never a fabricated result", async () => {
    const harness = makeBridge({
      readResult: readThreadOutput(null),
      observeOutputs: [finishedObservation(43, turn1)],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();
    expect(harness.steer).toHaveBeenCalledTimes(1);
    expect(harness.steer.mock.calls[0]![0] as string).toContain("without a final result message");
    harness.bridge.dispose();
  });
});

// ---------------------------------------------------------------------------
// Worker errors and revocation
// ---------------------------------------------------------------------------

describe("worker errors and revocation", () => {
  it("surfaces a worker error in-band on the delivery plus the client error path and stops", async () => {
    const harness = makeBridge({
      observeOutputs: [errorObservation(43, "worker exploded")],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();

    expect(harness.steer).toHaveBeenCalledTimes(1);
    expect(harness.steer.mock.calls[0]![0] as string).toContain("worker exploded");
    const errorEvents = harness.events.filter((event) => event.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      type: "error",
      threadId: threadA,
      error: { code: "partial_failure", threadId: threadA },
    });
    const [record] = await savedRecords(harness.store);
    expect(record?.status).toBe("failed");
    expect(record?.lastError).toBe("worker exploded");
    // The failure notice consumed this turn's delivery key.
    expect(record?.deliveredTurnIds).toEqual([`${threadA}:${turn1}`]);
    // Terminal: no further polling.
    expect(harness.scheduler.pending).toBe(0);
    harness.bridge.dispose();
  });

  it("reports a worker error without lastError as a readable generic failure", async () => {
    const harness = makeBridge({
      observeOutputs: [errorObservation(43, null)],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();
    expect(harness.steer.mock.calls[0]![0] as string).toContain("could not be completed");
    harness.bridge.dispose();
  });

  it("keeps a worker-error notice pending when steering is unavailable and delivers it once on recovery", async () => {
    const harness = makeBridge({
      steerResult: false,
      observeOutputs: [errorObservation(43, "boom")],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();
    // The refusal happens at the steering channel; the notice stays pending.
    expect(harness.steer).toHaveBeenCalledTimes(1);
    expect((await savedRecords(harness.store))[0]?.status).toBe("watching");
    expect(harness.events.some((event) => event.type === "delivered")).toBe(false);

    harness.steer.mockImplementation(() => true);
    harness.executor.observeThread.mockImplementation(async () => errorObservation(43, "boom"));
    await harness.bridge.recover();
    await harness.scheduler.pump();
    expect(harness.steer).toHaveBeenCalledTimes(2);
    expect((await savedRecords(harness.store))[0]?.status).toBe("failed");
    harness.bridge.dispose();
  });

  it("stops the retry loop on auth_invalid from observation", async () => {
    const harness = makeBridge({
      observeOutputs: [
        { reject: { code: "auth_invalid", message: "session revoked" } },
        runningObservation(50),
      ],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();
    expect(harness.executor.observeThread).toHaveBeenCalledTimes(1);
    expect(harness.events.some((event) => event.type === "auth_invalid")).toBe(true);
    const [record] = await savedRecords(harness.store);
    expect(record?.status).toBe("auth_invalid");
    expect(record?.lastError).toBe("session revoked");
    harness.bridge.dispose();
  });

  it("stops on auth_invalid surfacing from the result read", async () => {
    const harness = makeBridge({
      observeOutputs: [finishedObservation(43, turn1)],
      readResult: {
        environment: {
          environmentId: envA,
          status: "error",
          error: { code: "auth_invalid", message: "revoked mid-read" },
        },
      } as unknown as VoiceReadThreadOutput,
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();
    expect(harness.steer).not.toHaveBeenCalled();
    expect(harness.events.some((event) => event.type === "auth_invalid")).toBe(true);
    expect((await savedRecords(harness.store))[0]?.status).toBe("auth_invalid");
    expect(harness.scheduler.pending).toBe(0);
    harness.bridge.dispose();
  });

  it("keeps observing through transient boundary failures", async () => {
    const harness = makeBridge({
      observeOutputs: [
        { reject: { code: "environment_unreachable", message: "socket dropped" } },
        finishedObservation(44, turn1),
      ],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump(2);
    expect(harness.executor.observeThread).toHaveBeenCalledTimes(2);
    // The resume cursor advances only on a successful observation; the
    // failed first step left it at the creation receipt sequence.
    expect(harness.executor.observeThread.mock.calls[1]![0]).toMatchObject({ afterSequence: 42 });
    expect(harness.steer).toHaveBeenCalledTimes(1);
    harness.bridge.dispose();
  });
});

// ---------------------------------------------------------------------------
// In-flight marks (T4's emitMark indirection)
// ---------------------------------------------------------------------------

describe("research progress marks", () => {
  it("emits in-flight and done marks around observed research progress, once per phase", async () => {
    const harness = makeBridge({
      observeOutputs: [
        runningObservation(43),
        finishedObservation(44, turn1),
        runningObservation(46),
        finishedObservation(47, turn2),
      ],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump();

    const names = harness.marks.map((mark) => mark.mark);
    expect(names).toEqual([
      "function_call_received",
      "tool_done",
      "function_call_received",
      "tool_done",
    ]);
    for (const mark of harness.marks) {
      expect(mark.detail).toBe(`research:${threadA}`);
    }
    harness.bridge.dispose();
  });

  it("dispose clears an in-flight mark and cancels pending steps", async () => {
    const harness = makeBridge({
      observeOutputs: [runningObservation(43), runningObservation(44)],
    });
    await harness.bridge.delegate({
      requestId,
      environmentId: envA,
      projectId: projectA,
      task: "Research it",
      model: { kind: "profile", profile: "routine" },
    });
    await harness.scheduler.pump(1);
    harness.bridge.dispose();
    const callsAfterDispose = harness.executor.observeThread.mock.calls.length;
    await harness.scheduler.pump();
    expect(harness.executor.observeThread.mock.calls.length).toBe(callsAfterDispose);
    expect(harness.marks.at(-1)?.mark).toBe("tool_done");
  });
});

// ---------------------------------------------------------------------------
// Live-client steering boundary (session.commentary.append, delegation_id null)
// ---------------------------------------------------------------------------

class SteerTestDataChannel implements VoiceLiveRtcDataChannel {
  readonly sent: Array<string> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: { readonly message?: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  receive(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

class SteerTestPeerConnection implements VoiceLiveRtcPeerConnection {
  readonly channel = new SteerTestDataChannel();
  connectionState = "new";
  ontrack: VoiceLiveRtcPeerConnection["ontrack"] = null;
  onconnectionstatechange: (() => void) | null = null;

  createDataChannel(): VoiceLiveRtcDataChannel {
    return this.channel;
  }

  async createOffer(): Promise<VoiceLiveSessionDescription> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(): Promise<void> {}

  addTrack(): void {}

  close(): void {}
}

const makeSteerClient = () => {
  const peerConnection = new SteerTestPeerConnection();
  const client = createVoiceLiveClient({
    broker: {
      async mintSession() {
        return { sessionId: VoiceSessionId.make("sess-1"), sdp: "answer-sdp" };
      },
      async closeSession() {
        return { closed: true };
      },
    },
    createPeerConnection: () => peerConnection,
  });
  const startToLive = async () => {
    const started = client.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    peerConnection.channel.receive({ type: "session.started" });
    await started;
  };
  return { client, channel: peerConnection.channel, startToLive };
};

describe("live-client steer", () => {
  it("sends session.commentary.append with delegation_id null on a live session", async () => {
    const { client, channel, startToLive } = makeSteerClient();
    expect(client.steer!("Not yet live")).toBe(false);
    await startToLive();
    expect(client.steer!("Research finished: the answer is 4.")).toBe(true);
    const sent = JSON.parse(channel.sent[0]!) as Record<string, unknown>;
    expect(sent.type).toBe("session.commentary.append");
    expect(sent.delegation_id).toBeNull();
    expect(sent.content).toBe("Research finished: the answer is 4.");
    expect(typeof sent.event_id).toBe("string");
    // Two appends get distinct event ids (acknowledgments match by id).
    expect(client.steer!("Second append")).toBe(true);
    const second = JSON.parse(channel.sent[1]!) as Record<string, unknown>;
    expect(second.event_id).not.toBe(sent.event_id);
  });

  it("refuses empty or whitespace content and steering after close", async () => {
    const { client, channel, startToLive } = makeSteerClient();
    await startToLive();
    expect(client.steer!("   ")).toBe(false);
    channel.receive({ type: "session.closed" });
    await client.close();
    expect(client.steer!("After close")).toBe(false);
    expect(channel.sent).toHaveLength(0);
  });
});
