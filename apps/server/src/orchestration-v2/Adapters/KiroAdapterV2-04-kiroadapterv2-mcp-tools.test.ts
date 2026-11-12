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








describe("KiroAdapterV2 MCP tools", () => {
  // Probed live on Kiro 2.33.1 against a stdio MCP server named t3-code, without
  // the permission round trip. Kiro titles the call "@t3-code/html_render", names
  // it in `tool_id`, and keeps only the result's text.
  it.effect("shows T3's html_render as T3's tool with the page T3 published", () =>
    Effect.gen(function* () {
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const toolCallId = "tooluse_4N3LnlI9PRlphUtzdBQGDD";
      const args = { html: "<p>hi</p>", title: "Probe", height: 120 };
      const rawInput = { tool_id: "t3-code::html_render", arguments: args };
      const kiroMeta = { kiro: { serverName: "t3-code", toolOrigin: "default" } };
      const page = { attachmentId: "kiro-mcp-html-render-page", title: "Probe", height: 120 };
      yield* runKiroScript({
        scenario: "mcp-html-render",
        frames: [
          ...openSessionFrames({
            initialize: KIRO_V3_INITIALIZE,
            configOptions: [modeOption, autopilotOption("on")],
          }),
          turnPrompt,
          update({
            sessionUpdate: "tool_call",
            toolCallId,
            title: "@t3-code/html_render",
            kind: "other",
            status: "pending",
            rawInput,
            _meta: kiroMeta,
          }),
          update({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            rawInput,
            _meta: kiroMeta,
          }),
          update({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            title: "@t3-code/html_render",
            rawInput,
            rawOutput: { response: "Rendered.", imageBase64Urls: [], message: "Rendered." },
            content: [{ type: "content", content: { type: "text", text: "Rendered." } }],
            _meta: kiroMeta,
          }),
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        drive: ({ events, startTurn }) =>
          Effect.gen(function* () {
            // T3's MCP server records the page when Kiro calls html_render.
            yield* mcpSessions.recordHtmlRender(
              ThreadId.make("thread-kiro-mcp-html-render"),
              args,
              page,
            );
            yield* startTurn;
            const turn = yield* collectTurn(events);
            const items = turn.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === toolCallId
                ? [event.turnItem]
                : [],
            );
            const completed = items.at(-1);
            assert.deepEqual(
              items.map((item) => item.toolName),
              items.map(() => "t3-code.html_render"),
            );
            assert.equal(completed?.status, "completed");
            assert.deepEqual(completed?.input, args);
            assert.deepEqual(
              completed === undefined ? undefined : htmlRenderFromToolItem(completed),
              page,
            );
          }),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

