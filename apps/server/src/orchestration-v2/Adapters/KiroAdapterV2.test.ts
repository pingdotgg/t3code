import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  KiroSettings,
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
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
import {
  kiroAutopilotValue,
  kiroPermissionDisposition,
} from "../../provider/acp/KiroAcpSupport.ts";
import { KIRO_PROVIDER, makeKiroAdapterV2 } from "./KiroAdapterV2.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
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

describe("KiroAdapterV2", () => {
  it.effect("opens a session on a deployment that advertises no Kiro extensions", () =>
    runKiroScript({
      scenario: "no-extensions",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE_WITHOUT_EXTENSIONS),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        // No autopilot option advertised, so T3 sends no config write.
        answer("session/new", sessionSetup([modeOption])),
        turnPrompt,
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        }),
        answer("session/prompt", { stopReason: "end_turn" }),
      ],
      drive: ({ events, startTurn }) =>
        Effect.gen(function* () {
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("switches back to Kiro's default model after a named one", () =>
    runKiroScript({
      scenario: "default-after-named",
      frames: [
        ...openSessionFrames({
          initialize: KIRO_V3_INITIALIZE,
          configOptions: [modeOption, modelOption("auto"), autopilotOption("on")],
        }),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        outbound("session/set_config_option", {
          sessionId: SESSION_ID,
          configId: "model",
          value: "claude-sonnet",
        }),
        answer("session/set_config_option", {
          configOptions: [modeOption, modelOption("claude-sonnet"), autopilotOption("off")],
        }),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // "Kiro default" is Kiro's `auto`, so the session leaves the named model.
        outbound("session/set_config_option", {
          sessionId: SESSION_ID,
          configId: "model",
          value: "auto",
        }),
        answer("session/set_config_option", {
          configOptions: [modeOption, modelOption("auto"), autopilotOption("off")],
        }),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ events, startTurnOn }) =>
        Effect.gen(function* () {
          // The session already runs `auto`, so the first default turn sends no write.
          for (const [ordinal, model] of [
            [1, "default"],
            [2, "claude-sonnet"],
            [3, "default"],
          ] as const) {
            yield* startTurnOn(ordinal, model);
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("sets the thread's effort once the model write advertises it, and after a switch", () =>
    runKiroScript({
      scenario: "effort-after-model",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        // On `auto` Kiro offers no effort option.
        answer(
          "session/new",
          sessionSetup([modeOption, kiroModelOption("auto"), autopilotOption("on")]),
        ),
        // Turn 1: the model write's result is the first to advertise effort,
        // at the model's default, so the chosen level goes out after it.
        setConfig("model", "claude-opus-5.5"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("on"),
          effortOption("medium", CLAUDE_EFFORT_LEVELS),
        ]),
        setConfig("effortLevel", "high"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("on"),
          effortOption("high", CLAUDE_EFFORT_LEVELS),
        ]),
        setConfig("autopilot", "off"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("off"),
          effortOption("high", CLAUDE_EFFORT_LEVELS),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // Turn 2: same model and effort, so nothing is written.
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // Turn 3: a model without effort drops the option; no effort write.
        setConfig("model", "claude-sonnet-4.5"),
        configResult([modeOption, kiroModelOption("claude-sonnet-4.5"), autopilotOption("off")]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // Turn 4: back on an effort model, Kiro starts at its default again.
        setConfig("model", "claude-opus-5.5"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("off"),
          effortOption("medium", CLAUDE_EFFORT_LEVELS),
        ]),
        setConfig("effortLevel", "high"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("off"),
          effortOption("high", CLAUDE_EFFORT_LEVELS),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      model: "claude-opus-5.5",
      options: reasoning("high"),
      drive: ({ events, startTurnOn }) =>
        Effect.gen(function* () {
          for (const [ordinal, model] of [
            [1, "claude-opus-5.5"],
            [2, "claude-opus-5.5"],
            [3, "claude-sonnet-4.5"],
            [4, "claude-opus-5.5"],
          ] as const) {
            yield* startTurnOn(ordinal, model, reasoning("high"));
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("waits for Kiro to advertise the model before setting its effort", () =>
    runKiroScript({
      scenario: "effort-after-advert",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        // Kiro 2.27.0 leaves `model` out of `session/new`.
        answer("session/new", sessionSetup([modeOption, autopilotOption("on")])),
        // Written before Kiro advertised anything: the result carries neither
        // the model nor its effort, and an effort write now would be ignored.
        setConfig("model", "claude-opus-5.5"),
        configResult([modeOption, autopilotOption("on")]),
        update({
          sessionUpdate: "config_option_update",
          configOptions: [
            modeOption,
            kiroModelOption("claude-opus-5.5"),
            effortOption("medium", CLAUDE_EFFORT_LEVELS),
            autopilotOption("on"),
          ],
        }),
        setConfig("effortLevel", "high"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          effortOption("high", CLAUDE_EFFORT_LEVELS),
          autopilotOption("on"),
        ]),
        setConfig("autopilot", "off"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          effortOption("high", CLAUDE_EFFORT_LEVELS),
          autopilotOption("off"),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      model: "claude-opus-5.5",
      options: reasoning("high"),
      drive: ({ events, startTurnOn }) =>
        Effect.gen(function* () {
          yield* startTurnOn(1, "claude-opus-5.5", reasoning("high"));
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("never sends an effort level the model does not offer", () =>
    runKiroScript({
      scenario: "effort-not-offered",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer(
          "session/new",
          sessionSetup([modeOption, kiroModelOption("auto"), autopilotOption("on")]),
        ),
        // Turn 1 asks for xhigh, which Opus 4.6 does not offer: no effort
        // write, and the turn runs at Kiro's default.
        setConfig("model", "claude-opus-4.6"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-4.6"),
          autopilotOption("on"),
          effortOption("high", CLAUDE_4_6_EFFORT_LEVELS),
        ]),
        setConfig("autopilot", "off"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-4.6"),
          autopilotOption("off"),
          effortOption("high", CLAUDE_4_6_EFFORT_LEVELS),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // Turn 2 picks max, which it offers.
        setConfig("effortLevel", "max"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-4.6"),
          autopilotOption("off"),
          effortOption("max", CLAUDE_4_6_EFFORT_LEVELS),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      model: "claude-opus-4.6",
      options: reasoning("xhigh"),
      drive: ({ events, startTurnOn }) =>
        Effect.gen(function* () {
          for (const [ordinal, effort] of [
            [1, "xhigh"],
            [2, "max"],
          ] as const) {
            yield* startTurnOn(ordinal, "claude-opus-4.6", reasoning(effort));
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("answers a stale 'this session' approval with Kiro's allow_once", () =>
    runKiroScript({
      scenario: "stale-session-approval",
      frames: [
        ...openSessionFrames({
          initialize: KIRO_V3_INITIALIZE,
          configOptions: [modeOption, autopilotOption("on")],
        }),
        turnPrompt,
        {
          type: "emit_inbound",
          label: "session/request_permission",
          frame: {
            kind: "request",
            method: "session/request_permission",
            // Kiro 2.27's options for a write (kiro_supervised_transcript.ndjson).
            params: {
              sessionId: SESSION_ID,
              toolCall: { toolCallId: "call-1", title: "Write File", kind: "edit" },
              options: [
                { optionId: "accept", name: "Allow", kind: "allow_once" },
                { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
                { optionId: "reject", name: "Deny", kind: "reject_once" },
              ],
            },
          },
        },
        // The card offered no "this session" choice, so the answer is one-time
        // rather than Kiro's workspace-wide `allow_always`.
        {
          type: "expect_outbound",
          label: "session/request_permission.result",
          frame: {
            kind: "response",
            method: "session/request_permission",
            result: { outcome: { outcome: "selected", optionId: "accept" } },
          },
        },
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ events, startTurn, respond }) =>
        Effect.gen(function* () {
          const pending = yield* Deferred.make<RuntimeRequestId>();
          const turn = yield* collectTurn(
            events.pipe(
              Stream.tap((event) =>
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending"
                  ? Deferred.succeed(pending, event.runtimeRequest.id)
                  : Effect.void,
              ),
            ),
          ).pipe(Effect.forkChild);
          yield* startTurn;
          yield* respond(yield* Deferred.await(pending), "acceptForSession");
          assert.equal(terminalStatus(yield* Fiber.join(turn)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("sends a model Kiro does not list, and fails with Kiro's own message", () =>
    runKiroScript({
      scenario: "unlisted-model",
      model: "claude-opus-9",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        // Kiro has already listed its models, without the thread's custom one.
        answer(
          "session/new",
          sessionSetup([modeOption, modelOption("auto"), autopilotOption("on")]),
        ),
        // Shapes from kiro-cli 2.27.0, probed live with this id: Kiro takes
        // the write and fails the prompt.
        setConfig("model", "claude-opus-9"),
        configResult([modeOption, modelOption("claude-opus-9"), autopilotOption("on")]),
        setConfig("autopilot", "off"),
        configResult([modeOption, modelOption("claude-opus-9"), autopilotOption("off")]),
        turnPrompt,
        {
          type: "emit_inbound",
          label: "session/prompt.error",
          frame: {
            kind: "response",
            method: "session/prompt",
            error: {
              code: -32000,
              message:
                "The model 'claude-opus-9' is not available. Please select a different model and try again.",
              data: { errorType: "InvalidModelError", retryErrorType: "CLIENT_ERROR" },
            },
          },
        },
        ...closeSession,
      ],
      drive: ({ events, startTurn }) =>
        Effect.gen(function* () {
          yield* startTurn;
          const terminal = (yield* collectTurn(events)).find(
            (event) => event.type === "turn.terminal",
          );
          if (terminal?.type !== "turn.terminal" || terminal.status !== "failed") {
            return yield* Effect.die("the unavailable model must fail its turn");
          }
          assert.include(terminal.failure.message, "'claude-opus-9' is not available");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("KiroAdapterV2 early Stop", () => {
  // Kiro CLI 2.27.1 dropped a `session/cancel` sent 0-0.5 s after
  // `session/prompt` and ran the turn to completion (reported by TinBane), so
  // T3 holds Stop's cancel until Kiro shows it started the prompt, or for at
  // most 2 s. Replay gates hold Kiro's frames until Stop is holding; a gate's
  // label being reached means every frame before it was handled. The test
  // clock moves only where a test adjusts it, so the 2 s bound releases a
  // cancel nowhere else.
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
            // Stop decides the run's outcome.
            assert.equal(terminalStatus(yield* Fiber.join(turn)), "interrupted");
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

  it.effect("fails a Stop Kiro never acknowledges after the 10 s wait", () =>
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
          assert.isTrue(Exit.isFailure(yield* Fiber.join(stopFiber)));
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

describe("KiroAdapterV2 unknown model", () => {
  // Recorded live from Kiro 2.27.0 with the thread on a model id the account
  // lacks. Kiro has not advertised `model` yet, so T3 sends the id; Kiro
  // accepts it and fails the prompt with its own explanation.
  it.effect("fails the turn with Kiro's own unavailable-model message", () =>
    Effect.gen(function* () {
      const recorded = yield* readProviderReplayTranscript(
        new URL("../testkit/fixtures/kiro_unknown_model/kiro_transcript.ndjson", import.meta.url),
      );
      const firstPromptAnswer = recorded.entries.findIndex(
        (entry) =>
          entry.type === "emit_inbound" &&
          (entry.frame as { kind?: unknown; method?: unknown }).kind === "response" &&
          (entry.frame as { method?: unknown }).method === "session/prompt",
      );
      const frames = recorded.entries.slice(0, firstPromptAnswer + 1).map((entry) => {
        const frame = entry.type === "runtime_exit" ? undefined : (entry.frame as Frame);
        return frame?.method === "session/prompt" && frame.kind === "request"
          ? { ...entry, frame: { ...frame, params: "<any>" } }
          : entry;
      });
      const sessionId = recorded.entries.flatMap((entry) => {
        const frame = entry.type === "runtime_exit" ? undefined : (entry.frame as Frame);
        const result = frame?.result as { sessionId?: unknown } | undefined;
        return frame?.method === "session/new" && typeof result?.sessionId === "string"
          ? [result.sessionId]
          : [];
      })[0];
      yield* runKiroScript({
        scenario: "unknown-model",
        model: "not-a-kiro-model",
        // As recorded: Kiro already runs on Autopilot, so T3 writes only the model.
        runtimeMode: "full-access",
        frames: [
          ...(frames as ReadonlyArray<Frame>),
          outbound("session/close", { sessionId }),
          answer("session/close", {}),
        ],
        drive: ({ events, startTurn }) =>
          Effect.gen(function* () {
            yield* startTurn;
            const turn = yield* collectTurn(events);
            const terminal = turn.find((event) => event.type === "turn.terminal");
            if (terminal?.type !== "turn.terminal" || terminal.status !== "failed") {
              return yield* Effect.die("the unknown model must fail its turn");
            }
            assert.include(terminal.failure.message, "not-a-kiro-model");
            assert.include(terminal.failure.message, "is not available");
            assert.equal(terminal.failure.code, "-32000");
          }),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("Kiro permission policy", () => {
  const policy = (input: {
    readonly runtimeMode: RuntimeMode;
    readonly approvalPolicy?: unknown;
    readonly sandboxPolicy?: unknown;
  }) =>
    ProviderAdapterV2RuntimePolicy.make({
      interactionMode: "default",
      cwd: "/workspace",
      ...input,
    });

  it("keeps Autopilot on only for an unrestricted Full access thread", () => {
    assert.equal(kiroAutopilotValue(policy({ runtimeMode: "full-access" })), "on");
    assert.equal(kiroAutopilotValue(policy({ runtimeMode: "approval-required" })), "off");
    // An explicit override restricts Full access, so Kiro's review stays on.
    assert.equal(
      kiroAutopilotValue(policy({ runtimeMode: "full-access", approvalPolicy: "on-request" })),
      "off",
    );
    assert.equal(
      kiroAutopilotValue(
        policy({ runtimeMode: "full-access", sandboxPolicy: { type: "readOnly" } }),
      ),
      "off",
    );
  });

  const writeRequest = (
    options: EffectAcpSchema.RequestPermissionRequest["options"],
  ): EffectAcpSchema.RequestPermissionRequest => ({
    sessionId: "session-1",
    toolCall: { toolCallId: "call-1", title: "Write File", kind: "edit" },
    options,
  });

  it("never lets a policy approval persist Kiro's workspace-wide allow_always", () => {
    const fullAccess = policy({ runtimeMode: "full-access" });
    assert.equal(
      kiroPermissionDisposition(
        fullAccess,
        writeRequest([
          { optionId: "accept", name: "Allow", kind: "allow_once" },
          { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
        ]),
      ),
      "allow",
    );
    // With no one-time choice, approving would save a rule beyond the thread,
    // so the request goes to the user instead.
    assert.equal(
      kiroPermissionDisposition(
        fullAccess,
        writeRequest([
          { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
          { optionId: "reject", name: "Deny", kind: "reject_once" },
        ]),
      ),
      "ask",
    );
  });
});
