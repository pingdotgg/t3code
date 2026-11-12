import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  type ProviderApprovalDecision,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderTurnId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  ProviderAdapterV2RuntimePolicy,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@t3tools/provider-testing/replayGate";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { KiroSettings } from "@t3tools/provider-kiro/settings";
import {
  KIRO_PROVIDER,
  kiroApprovalOptions,
  kiroAutopilotValue,
  kiroPermissionDisposition,
  makeKiroAdapterV2,
} from "@t3tools/provider-kiro/testing";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const SESSION_ID = "sess_abb5e0cf-d4a2-4360-9f03-2f8f0889a707";
const ENABLED_KIRO_SETTINGS = Schema.decodeSync(KiroSettings)({ enabled: true });

type Frame = Record<string, unknown>;
const outbound = (method: string, params: unknown = "<any>", label = method): Frame => ({
  type: "expect_outbound",
  label,
  frame: { kind: "request", method, params },
});
const answer = (method: string, result: unknown, label = `${method}.result`): Frame => ({
  type: "emit_inbound",
  label,
  frame: { kind: "response", method, result },
});
const update = (sessionUpdate: Record<string, unknown>): Frame => ({
  type: "emit_inbound",
  label: `update.${String(sessionUpdate.sessionUpdate)}`,
  frame: {
    kind: "notification",
    method: "session/update",
    params: { sessionId: SESSION_ID, update: sessionUpdate },
  },
});
const kiroNotification = (method: string, params: unknown): Frame => ({
  type: "emit_inbound",
  label: method,
  frame: { kind: "notification", method, params },
});

/**
 * Kiro CLI 2.27.0 (KAS 0.66.22) `initialize` result, recorded with
 * `kiro-cli acp --agent-engine=v3 --auth-method=cli`. Only the extension
 * method list is shortened and the log paths dropped.
 */
const KIRO_V3_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    sessionCapabilities: {
      list: {},
      close: {},
      delete: {},
      fork: { _meta: { kiro: { messageId: true } } },
    },
    _meta: {
      kiro: {
        checkpoints: true,
        sessionList: true,
        policyNotifications: true,
        extensionMethods: ["_kiro/session/context", "_kiro/session/compact", "_kiro/knowledge"],
        sessionSources: ["local", "remote"],
        sessionListScopes: ["workspace", "user"],
        executionTargets: ["local", "cloud-sandbox"],
        replayMarking: true,
      },
    },
  },
  authMethods: [
    { id: "aws-builder-id", name: "AWS Builder ID" },
    { id: "aws-iam-identity-center", name: "AWS IAM Identity Center" },
  ],
};

/** A deployment that advertises no Kiro extensions at all. */
const KIRO_V3_INITIALIZE_WITHOUT_EXTENSIONS = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
  },
  authMethods: [],
};

const option = (value: string, name = value) => ({ value, name });
const autopilotOption = (currentValue: "on" | "off") => ({
  type: "select",
  id: "autopilot",
  name: "Autopilot",
  currentValue,
  options: [option("on", "Autopilot"), option("off", "Supervised")],
});
const modeOption = {
  type: "select",
  id: "mode",
  name: "Mode",
  category: "mode",
  currentValue: "vibe",
  options: [option("vibe", "Default"), option("spec", "Spec"), option("plan", "Plan")],
};
// Recorded sessions without a signed-in account carry no `model` option; the
// migration guide documents it as `configId: "model"`.
const modelOption = (currentValue: string) => ({
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue,
  options: [option("auto", "Auto"), option("claude-sonnet", "Claude Sonnet")],
});

/**
 * Kiro's `model` option as 2.27.0 advertises it (fixtures/kiro_model_switch),
 * trimmed to three choices. Each choice's `_meta.kiro` names its effort levels.
 */
const kiroModelChoice = (
  value: string,
  name: string,
  effort?: { readonly levels: ReadonlyArray<string>; readonly defaultLevel: string },
) => ({
  value,
  name,
  _meta: {
    kiro:
      effort === undefined
        ? { hasEffort: false, thinkingToggleable: false }
        : {
            hasEffort: true,
            effortSchemaPath: "output_config",
            effortLevels: effort.levels,
            defaultEffortLevel: effort.defaultLevel,
            thinkingToggleable: false,
          },
  },
});
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_4_6_EFFORT_LEVELS = ["low", "medium", "high", "max"];
const kiroModelOption = (currentValue: string) => ({
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue,
  options: [
    kiroModelChoice("auto", "Auto"),
    kiroModelChoice("claude-opus-5.5", "Claude Opus 5.5", {
      levels: CLAUDE_EFFORT_LEVELS,
      defaultLevel: "medium",
    }),
    kiroModelChoice("claude-opus-4.6", "Claude Opus 4.6", {
      levels: CLAUDE_4_6_EFFORT_LEVELS,
      defaultLevel: "high",
    }),
    kiroModelChoice("claude-sonnet-4.5", "Claude Sonnet 4.5"),
  ],
});
/**
 * Kiro's effort option as kiro-cli 2.27.0 advertised it to a direct ACP probe
 * on Claude Opus 5.5: a `thought_level` select with id `effortLevel`, present
 * only while a model with effort runs and starting at that model's default
 * level. No replay fixture records it yet.
 */
const effortOption = (currentValue: string, levels: ReadonlyArray<string>) => ({
  type: "select",
  id: "effortLevel",
  name: "Effort",
  category: "thought_level",
  currentValue,
  options: levels.map((level) => option(level)),
});
const setConfig = (configId: string, value: string) =>
  outbound("session/set_config_option", { sessionId: SESSION_ID, configId, value });
const configResult = (configOptions: ReadonlyArray<unknown>) =>
  answer("session/set_config_option", { configOptions });
const reasoning = (value: string) => [{ id: "reasoningEffort", value }];

/** Kiro's `session/new` result, recorded from 2.27.0 and trimmed to what T3 reads. */
const sessionSetup = (configOptions: ReadonlyArray<unknown>) => ({
  _meta: { schemaVersion: "1.0.0", id: SESSION_ID, agentMode: "vibe", source: "local" },
  sessionId: SESSION_ID,
  modes: {
    currentModeId: "vibe",
    availableModes: [
      { id: "vibe", name: "Default" },
      { id: "spec", name: "Spec" },
      { id: "plan", name: "Plan" },
    ],
  },
  configOptions,
});

/** What Kiro sends right after `initialize` and around `session/new`, all unknown to T3. */
const kiroSessionNoise: ReadonlyArray<Frame> = [
  kiroNotification("_kiro/mcp/status", { sessionId: SESSION_ID, servers: [] }),
  kiroNotification("_kiro/sessions/changed", { upserted: [], deleted: [] }),
];

// Kiro advertises `sessionCapabilities.close`, so T3 closes the session on teardown.
const closeSession: ReadonlyArray<Frame> = [
  outbound("session/close", { sessionId: SESSION_ID }),
  answer("session/close", {}),
];

const turnPrompt = outbound("session/prompt", {
  sessionId: SESSION_ID,
  prompt: "<any>",
});

const openSessionFrames = (input: {
  readonly initialize: unknown;
  readonly configOptions: ReadonlyArray<unknown>;
}): ReadonlyArray<Frame> => [
  outbound("initialize"),
  answer("initialize", input.initialize),
  outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
  ...kiroSessionNoise,
  answer("session/new", sessionSetup(input.configOptions)),
  // Supervised threads run Kiro with Autopilot off, its native ask-first posture.
  outbound("session/set_config_option", {
    sessionId: SESSION_ID,
    configId: "autopilot",
    value: "off",
  }),
  answer("session/set_config_option", {
    configOptions: input.configOptions.map((entry) =>
      (entry as { id: string }).id === "autopilot" ? autopilotOption("off") : entry,
    ),
  }),
];

const runKiroScript = Effect.fn("runKiroScript")(function* (input: {
  readonly scenario: string;
  readonly frames: ReadonlyArray<Frame>;
  readonly model?: string;
  /** Option selections (e.g. reasoningEffort) for the session and `startTurn`. */
  readonly options?: ModelSelection["options"];
  readonly runtimeMode?: RuntimeMode;
  /** Holds the script's inbound frames at labels the test releases. */
  readonly replayGate?: ProviderReplayGate;
  readonly testHooks?: Parameters<typeof makeKiroAdapterV2>[0]["testHooks"];
  /** Wraps the runtime's `session/cancel` send. */
  readonly wrapCancel?: (
    send: AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"];
  readonly drive: (session: {
    readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
    readonly startTurn: Effect.Effect<void, ProviderAdapterV2Error>;
    /** Starts turn `ordinal` (from 1) on `model`, with `options` if given. */
    readonly startTurnOn: (
      ordinal: number,
      model: string,
      options?: ModelSelection["options"],
    ) => Effect.Effect<void, ProviderAdapterV2Error>;
    readonly interrupt: (
      providerTurnId: ProviderTurnId,
    ) => Effect.Effect<void, ProviderAdapterV2Error>;
    readonly respond: (
      requestId: RuntimeRequestId,
      decision: ProviderApprovalDecision,
    ) => Effect.Effect<void, ProviderAdapterV2Error>;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: `t3-kiro-${input.scenario}-`,
  });
  const statusPath = path.join(replayDir, "status.json");
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: KIRO_PROVIDER,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: input.scenario,
      entries: input.frames as never,
    },
    KIRO_PROVIDER,
  );
  const instanceId = ProviderInstanceId.make(`kiro-${input.scenario}`);
  const scriptPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
  );
  const adapter = yield* makeKiroAdapterV2({
    instanceId,
    settings: ENABLED_KIRO_SETTINGS,
    environment: {},
    selfInvocation: yield* resolveSelfInvocation(),
    makeRuntime: (runtimeInput) =>
      makeAcpReplayRuntime({
        transcript,
        statusPath,
        scriptPath,
        childProcessSpawner,
        fileSystem,
        ...(input.replayGate === undefined ? {} : { replayGate: input.replayGate }),
      })(runtimeInput).pipe(
        Effect.map((runtime) =>
          input.wrapCancel === undefined
            ? runtime
            : { ...runtime, cancel: input.wrapCancel(runtime.cancel) },
        ),
      ),
    ...(input.testHooks === undefined ? {} : { testHooks: input.testHooks }),
  });
  // Held frames must not outlive a failed drive and wedge teardown.
  yield* Effect.addFinalizer(() => Effect.sync(() => input.replayGate?.releaseAll()));
  const threadId = ThreadId.make(`thread-kiro-${input.scenario}`);
  const modelSelection = {
    instanceId,
    model: input.model ?? "default",
    ...(input.options === undefined ? {} : { options: input.options }),
  };
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: "default",
    cwd: replayDir,
  });
  yield* Effect.gen(function* () {
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-kiro-${input.scenario}`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    const startTurnOn = (ordinal: number, model: string, options?: ModelSelection["options"]) => {
      const suffix = `${threadId}:${ordinal}`;
      const turnSelection = { instanceId, model, ...(options === undefined ? {} : { options }) };
      return session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make(`project:${threadId}`),
          title: "Kiro adapter test",
          providerInstanceId: instanceId,
          modelSelection: turnSelection,
          runtimeMode: runtimePolicy.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make(`run:${suffix}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`attempt:${suffix}`),
        rootNodeId: NodeId.make(`node:${suffix}`),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message:${suffix}`),
          text: "Say hello",
          attachments: [],
        },
        modelSelection: turnSelection,
        runtimePolicy,
      });
    };
    yield* input.drive({
      events: session.events,
      startTurn: startTurnOn(1, modelSelection.model, input.options),
      startTurnOn,
      interrupt: (providerTurnId) => session.interruptTurn({ providerThread, providerTurnId }),
      respond: (requestId, decision) => session.respondToRuntimeRequest({ requestId, decision }),
    });
  }).pipe(Effect.scoped);
  // Closing the session stops the replay agent; every scripted frame must be used.
  yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
});

const collectTurn = (events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>) =>
  events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
    Effect.map((collected) => Array.from(collected)),
  );

const terminalStatus = (events: ReadonlyArray<ProviderAdapterV2Event>) => {
  const terminal = events.find((event) => event.type === "turn.terminal");
  return terminal?.type === "turn.terminal" ? terminal.status : undefined;
};








describe("KiroAdapterV2 early Stop", () => {
  // Stop holds its cancel until Kiro starts the prompt, for at most 2 s.
  // Replay gates hold Kiro's frames until Stop is holding; reaching a gate's
  // label means every frame before it was handled. The test clock moves only
  // where a test adjusts it, so the 2 s bound releases a cancel nowhere else.
  const kiroInfo = (label: string, kiro: Record<string, unknown>): Frame => ({
    ...update({ sessionUpdate: "session_info_update", _meta: { kiro } }),
    label,
  });
  // Shapes recorded from Kiro 2.27 (fixtures/queued_turn/kiro_transcript.ndjson).
  const messageIdEcho = kiroInfo("message-id", {
    userMessageId: "message-2",
    kind: "user_message_id_assigned",
  });
  const turnStart = kiroInfo("turn-start", {
    turnStart: true,
    kind: "turn_start",
    messageId: "message-2-turn-start",
  });
  const cancel: Frame = {
    type: "expect_outbound",
    label: "session/cancel",
    frame: { kind: "notification", method: "session/cancel", params: { sessionId: SESSION_ID } },
  };
  const cancelled = answer("session/prompt", { stopReason: "cancelled" });
  const runningProviderTurnId = (event: ProviderAdapterV2Event) =>
    event.type === "provider_turn.updated" && event.providerTurn.status === "running"
      ? event.providerTurn.id
      : undefined;

  /**
   * Runs a Kiro turn and presses Stop as soon as it runs. Once Stop holds its
   * cancel, `drive` gets the replay gate, a receipt for the cancel T3 sends,
   * and Stop's exit.
   */
  const earlyStop = (input: {
    readonly frames: ReadonlyArray<Frame>;
    readonly gates: ReadonlyArray<string>;
    readonly drive: (stop: {
      readonly replayGate: ProviderReplayGate;
      readonly cancelSent: Deferred.Deferred<void>;
      /** Completed once the cancel was written, right before Stop's acknowledgement wait. */
      readonly cancelWritten: Deferred.Deferred<void>;
      readonly stopFiber: Fiber.Fiber<Exit.Exit<void, ProviderAdapterV2Error>>;
    }) => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      const replayGate = makeProviderReplayGate(input.gates);
      const cancelHeld = yield* Deferred.make<void>();
      const cancelSent = yield* Deferred.make<void>();
      const cancelWritten = yield* Deferred.make<void>();
      yield* runKiroScript({
        scenario: "early-stop",
        replayGate,
        testHooks: {
          onCancelHeld: () => Deferred.succeed(cancelHeld, undefined).pipe(Effect.asVoid),
        },
        // `cancelSent` marks the decision to cancel, `cancelWritten` the write.
        wrapCancel: (send) =>
          Deferred.succeed(cancelSent, undefined).pipe(
            Effect.andThen(send),
            Effect.andThen(Deferred.succeed(cancelWritten, undefined)),
            Effect.asVoid,
          ),
        frames: [
          ...openSessionFrames({
            initialize: KIRO_V3_INITIALIZE,
            configOptions: [modeOption, autopilotOption("on")],
          }),
          turnPrompt,
          ...input.frames,
          ...closeSession,
        ],
        drive: ({ events, startTurn, interrupt }) =>
          Effect.gen(function* () {
            const running = yield* Deferred.make<ProviderTurnId>();
            const turn = yield* collectTurn(
              events.pipe(
                Stream.tap((event) => {
                  const providerTurnId = runningProviderTurnId(event);
                  return providerTurnId === undefined
                    ? Effect.void
                    : Deferred.succeed(running, providerTurnId);
                }),
              ),
            ).pipe(Effect.forkChild);
            yield* startTurn;
            const stop = yield* interrupt(yield* Deferred.await(running)).pipe(
              Effect.exit,
              Effect.forkChild,
            );
            yield* Deferred.await(cancelHeld);
            yield* input.drive({ replayGate, cancelSent, cancelWritten, stopFiber: stop });
            // Stop decides the run's outcome. A Stop Kiro never acknowledges leaves the
            // turn open, since Kiro may still be working, for the user to Force stop.
            if (Exit.isSuccess(yield* Fiber.join(stop))) {
              assert.equal(terminalStatus(yield* Fiber.join(turn)), "interrupted");
            } else {
              assert.isUndefined(turn.pollUnsafe());
            }
          }),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped);

  /**
   * Lets Kiro's frames through one gate at a time. No cancel may go out
   * before the last gate's frame, and Stop must succeed.
   */
  const releaseInOrder = (input: {
    readonly frames: ReadonlyArray<Frame>;
    readonly gates: ReadonlyArray<string>;
    readonly expectCancel: boolean;
  }) =>
    earlyStop({
      frames: input.frames,
      gates: input.gates,
      drive: ({ replayGate, cancelSent, stopFiber }) =>
        Effect.gen(function* () {
          for (const [index, label] of input.gates.entries()) {
            replayGate.release(label);
            const next = input.gates[index + 1];
            if (next === undefined) continue;
            yield* Effect.promise(() => replayGate.waitForReached(next));
            assert.isFalse(
              yield* Deferred.isDone(cancelSent),
              `Stop must still hold its cancel after ${label}`,
            );
          }
          assert.isTrue(Exit.isSuccess(yield* Fiber.join(stopFiber)));
          assert.equal(yield* Deferred.isDone(cancelSent), input.expectCancel);
        }),
    });

  it.effect("holds Stop past Kiro's message-id echo until its turn_start", () =>
    releaseInOrder({
      gates: ["message-id", "turn-start"],
      expectCancel: true,
      frames: [
        messageIdEcho,
        kiroInfo("focus", {
          focus: { status: "in_progress" },
          kind: "focus_update",
          status: "in_progress",
        }),
        turnStart,
        cancel,
        cancelled,
      ],
    }),
  );

  it.effect("does not take the previous prompt's late context usage as the start", () =>
    releaseInOrder({
      // Kiro reports the finished prompt's context usage after answering it,
      // so it can arrive once the next `session/prompt` went out.
      gates: ["previous-context-usage", "turn-start"],
      expectCancel: true,
      frames: [
        kiroInfo("previous-context-usage", {
          contextUsage: { usagePercentage: 8.8 },
          kind: "context_usage",
          usagePercentage: 8.8,
        }),
        turnStart,
        cancel,
        cancelled,
      ],
    }),
  );

  it.effect("does not take Kiro's background cloud-config fetch as the start", () =>
    releaseInOrder({
      // Kiro 2.31 fetches an Identity Center account's cloud config as a tool
      // call of its own, which can arrive once `session/prompt` went out
      // (frames reported by @hstern; the tool call id is invented).
      gates: ["cloud-config", "cloud-config-done", "turn-start"],
      expectCancel: true,
      frames: [
        {
          ...update({
            sessionUpdate: "tool_call",
            toolCallId: "tooluse_cloud_config",
            title: "Fetching your cloud config",
            kind: "other",
            status: "in_progress",
            _meta: { kiro: { toolId: "fetch_cloud_config" } },
          }),
          label: "cloud-config",
        },
        messageIdEcho,
        {
          ...update({
            sessionUpdate: "tool_call_update",
            toolCallId: "tooluse_cloud_config",
            status: "completed",
            rawOutput: { kind: "upToDate" },
          }),
          label: "cloud-config-done",
        },
        turnStart,
        cancel,
        cancelled,
      ],
    }),
  );

  it.effect("cancels on Kiro's first reply text when it sends no turn_start", () =>
    releaseInOrder({
      gates: ["message-id", "reply"],
      expectCancel: true,
      frames: [
        messageIdEcho,
        {
          ...update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "On it" },
          }),
          label: "reply",
        },
        cancel,
        cancelled,
      ],
    }),
  );

  it.effect("cancels 2 s after the prompt when Kiro shows nothing but the echo", () =>
    earlyStop({
      gates: ["message-id", "focus"],
      frames: [
        messageIdEcho,
        kiroInfo("focus", {
          focus: { status: "in_progress" },
          kind: "focus_update",
          status: "in_progress",
        }),
        cancel,
        cancelled,
      ],
      drive: ({ replayGate, cancelSent, stopFiber }) =>
        Effect.gen(function* () {
          replayGate.release("message-id");
          yield* Effect.promise(() => replayGate.waitForReached("focus"));
          yield* TestClock.adjust("1999 millis");
          assert.isFalse(yield* Deferred.isDone(cancelSent), "the echo must not release Stop");
          yield* TestClock.adjust("1 millis");
          yield* Deferred.await(cancelSent);
          // Kiro acknowledges, and Stop still has its own time to see it.
          replayGate.release("focus");
          assert.isTrue(Exit.isSuccess(yield* Fiber.join(stopFiber)));
        }),
    }),
  );

  it.effect("fails a Stop Kiro never acknowledges after the 10 s wait and keeps the turn", () =>
    earlyStop({
      gates: [],
      // Kiro never starts the prompt and never answers it.
      frames: [messageIdEcho, cancel],
      drive: ({ cancelWritten, stopFiber }) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("2 seconds");
          yield* Deferred.await(cancelWritten);
          // The acknowledgement wait gets its full 10 s after the cancel.
          yield* TestClock.adjust("9999 millis");
          assert.isUndefined(stopFiber.pollUnsafe(), "Stop must still wait for Kiro's answer");
          yield* TestClock.adjust("1 millis");
          const error = Exit.findErrorOption(yield* Fiber.join(stopFiber));
          assert.equal(Option.getOrUndefined(error)?._tag, "ProviderAdapterInterruptTimeoutError");
        }),
    }),
  );

  it.effect("sends no cancel when Kiro finishes the prompt before starting it", () =>
    releaseInOrder({
      gates: ["session/prompt.result"],
      expectCancel: false,
      frames: [answer("session/prompt", { stopReason: "end_turn" })],
    }),
  );
});

