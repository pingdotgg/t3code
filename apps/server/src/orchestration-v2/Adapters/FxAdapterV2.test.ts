import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import { FxSettings } from "@t3tools/provider-fx/settings";
import { FX_DRIVER_KIND, FX_SESSION_META, makeFxAdapterV2 } from "@t3tools/provider-fx/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const SESSION_ID = "fx-session-01";
const ENABLED_FX_SETTINGS = Schema.decodeSync(FxSettings)({ enabled: true });
/** The model `fx status --json` reports in the thread's folder, on the gateway. */
const FX_DEFAULT_MODEL = "anthropic/claude-opus-5.5";
const NAMED_MODEL = "anthropic/claude-sonnet-5.5";
const CUSTOM_MODEL = "openai/gpt-6.1-sol";
const CODEX_MODEL = "gpt-6.1-sol";
const FX_0_0_13_MODES = ["code", "ask"];
/** fx 0.0.14+, after vercel-labs/fx#1189. */
const FX_MAIN_MODES = ["auto", "ask", "full-access"];

type Frame = Record<string, unknown>;
const outbound = (method: string, params: unknown = "<any>"): Frame => ({
  type: "expect_outbound",
  label: method,
  frame: { kind: "request", method, params },
});
const answer = (method: string, result: unknown): Frame => ({
  type: "emit_inbound",
  label: `${method}.result`,
  frame: { kind: "response", method, result },
});

const select = (
  id: string,
  category: string,
  currentValue: string,
  values: ReadonlyArray<string>,
) => ({
  id,
  name: id,
  category,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

/**
 * fx's session config as recorded from 0.0.13 (fixtures/simple), models
 * trimmed. fx lists its backend `provider` before `model`, both with
 * category `model`.
 */
const fxConfig = (input: {
  readonly model: string;
  readonly modes: ReadonlyArray<string>;
  readonly mode?: string;
  readonly backend?: string;
  /** The session's own model list, on a backend other than the gateway. */
  readonly models?: ReadonlyArray<string>;
}) => [
  select("provider", "model", input.backend ?? "gateway", ["gateway", "codex", "grok"]),
  select(
    "model",
    "model",
    input.model,
    input.models ?? [NAMED_MODEL, FX_DEFAULT_MODEL, "openai/gpt-5.6-sol"],
  ),
  select("mode", "mode", input.mode ?? "ask", input.modes),
  select("effort", "thought_level", "xhigh", ["auto", "low", "medium", "high", "xhigh", "max"]),
];

/**
 * fx's reply to `session/new` or `session/load`. fx 0.0.13 reports `ask`
 * while it enforces its saved default until a client writes the mode.
 */
const fxSession = (input: {
  readonly model: string;
  readonly modes: ReadonlyArray<string>;
  readonly backend?: string;
  readonly models?: ReadonlyArray<string>;
}) => ({
  sessionId: SESSION_ID,
  configOptions: fxConfig(input),
  modes: { currentModeId: "ask", availableModes: input.modes.map((id) => ({ id, name: id })) },
});

const update = (sessionId: string, sessionUpdate: Record<string, unknown>): Frame => ({
  type: "emit_inbound",
  label: `session/update:${String(sessionUpdate.sessionUpdate)}`,
  frame: {
    kind: "notification",
    method: "session/update",
    params: { sessionId, update: sessionUpdate },
  },
});
/** A `libfx/hook` event as fx 0.0.15 sends it once a session opts in. */
const hookEvent = (sessionId: string, type: string, data: Record<string, unknown>) => ({
  version: 1,
  sessionId,
  rootSessionId: SESSION_ID,
  parentSessionId: sessionId === SESSION_ID ? null : SESSION_ID,
  sourceSessionId: null,
  workId: null,
  turnId: "turn-1",
  executionId: `execution-${sessionId}`,
  stepIndex: 1,
  timestamp: 1_793_283_383_907,
  type,
  data,
  contentCaptured: true,
  contentTruncated: false,
});
const hook = (sessionId: string, type: string, data: Record<string, unknown>): Frame => ({
  type: "emit_inbound",
  label: `libfx/hook:${type}`,
  frame: { kind: "notification", method: "libfx/hook", params: hookEvent(sessionId, type, data) },
});
const subagentReply = (reply: string) =>
  JSON.stringify({ ok: true, result: reply, error_code: null });
const subagentCall = (callId: string, task: string) =>
  update(SESSION_ID, {
    sessionUpdate: "tool_call",
    toolCallId: callId,
    name: "subagent",
    title: `Subagent · ${task}`,
    kind: "other",
    status: "pending",
    rawInput: { action: "run", task },
    _meta: { fx: { toolCall: { internal: false } } },
  });
/** fx's 200-byte ACP preview of a finished `subagent` call. */
const subagentPreview = (callId: string, reply: string) =>
  update(SESSION_ID, {
    sessionUpdate: "tool_call_update",
    toolCallId: callId,
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: subagentReply(reply).slice(0, 199) } },
    ],
  });

const initialize: ReadonlyArray<Frame> = [
  outbound("initialize"),
  answer("initialize", {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
    },
    agentInfo: { name: "fx", title: "fx", version: "0.0.13" },
    authMethods: [],
  }),
];

/** A config write and fx's reply, which lists the session's config after it. */
const setConfig = (
  configId: string,
  value: string,
  configAfter: ReadonlyArray<unknown>,
): ReadonlyArray<Frame> => [
  outbound("session/set_config_option", { sessionId: SESSION_ID, configId, value }),
  answer("session/set_config_option", { configOptions: configAfter }),
];

/**
 * Opens an fx session against a scripted ACP agent, which fails on any
 * frame the script does not expect. Every scripted frame must be used.
 */
const openFxSession = Effect.fn("openFxSession")(function* (input: {
  readonly scenario: string;
  readonly frames: ReadonlyArray<Frame>;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly defaultBackend?: string;
  readonly modeOptions?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  /** Loads this fx session instead of creating one. */
  readonly loadSessionId?: string;
  /** Then starts a turn on this model. */
  readonly turnModel?: string;
  /** `libfx/hook` events fx sends after the turn has ended, collected until `until`. */
  readonly afterTurn?: {
    readonly hooks: ReadonlyArray<ReturnType<typeof hookEvent>>;
    readonly until: (event: ProviderAdapterV2Event) => boolean;
  };
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: `t3-fx-${input.scenario}-`,
  });
  const statusPath = path.join(replayDir, "status.json");
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: FX_DRIVER_KIND,
      protocol: ACP_PROTOCOL,
      version: "1",
      scenario: input.scenario,
      entries: input.frames as never,
    },
    FX_DRIVER_KIND,
  );
  const instanceId = ProviderInstanceId.make(`fx-${input.scenario}`);
  const replayRuntime = makeAcpReplayRuntime({
    transcript,
    statusPath,
    scriptPath: yield* path.fromFileUrl(
      new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
    ),
    childProcessSpawner,
    fileSystem,
    sessionMeta: () => FX_SESSION_META,
  });
  let deliverHook: ((raw: unknown) => Effect.Effect<void>) | undefined;
  const adapter = yield* makeFxAdapterV2({
    instanceId,
    settings: ENABLED_FX_SETTINGS,
    environment: {},
    selfInvocation: yield* resolveSelfInvocation(),
    defaultChoice: (cwd) =>
      // "Default" resolves in the thread's own folder.
      Effect.succeed(
        cwd === replayDir
          ? { backend: input.defaultBackend ?? "gateway", model: FX_DEFAULT_MODEL }
          : undefined,
      ),
    makeRuntime: (runtimeInput) =>
      replayRuntime(runtimeInput).pipe(
        Effect.map((runtime) => ({
          ...runtime,
          handleExtNotification: (method, payload, handler) => {
            if (method === "libfx/hook") {
              deliverHook = (raw) =>
                Schema.decodeUnknownEffect(payload)(raw).pipe(
                  Effect.flatMap(handler),
                  Effect.orDie,
                );
            }
            return runtime.handleExtNotification(method, payload, handler);
          },
        })),
      ),
  });
  const threadId = ThreadId.make(`thread-fx-${input.scenario}`);
  // The thread's effort matches the session's, so no effort write is scripted.
  const selectionOn = (model: string) => ({
    instanceId,
    model,
    options: [{ id: "effort", value: "xhigh" }, ...(input.modeOptions ?? [])],
  });
  const modelSelection = selectionOn(input.model ?? "default");
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    cwd: replayDir,
  });
  const events = yield* Effect.gen(function* () {
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-fx-${input.scenario}`),
      modelSelection,
      runtimePolicy,
      ...(input.loadSessionId === undefined ? {} : { initialNativeThreadId: input.loadSessionId }),
    });
    if (input.turnModel === undefined) return [];
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    const turnSelection = selectionOn(input.turnModel);
    yield* session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project:${threadId}`),
        title: "fx adapter test",
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
      runId: RunId.make(`run:${threadId}:1`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt:${threadId}:1`),
      rootNodeId: NodeId.make(`node:${threadId}:1`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message:${threadId}:1`),
        text: "Say hello",
        attachments: [],
      },
      modelSelection: turnSelection,
      runtimePolicy,
    });
    const turn = yield* session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    if (input.afterTurn === undefined) return turn;
    const later = yield* session.events.pipe(
      Stream.takeUntil(input.afterTurn.until),
      Stream.runCollect,
      Effect.forkScoped,
    );
    for (const event of input.afterTurn.hooks) yield* deliverHook?.(event) ?? Effect.void;
    return [...turn, ...(yield* Fiber.join(later))];
  }).pipe(Effect.scoped);
  yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
  return events;
});

describe("FxAdapterV2", () => {
  it.effect("runs Auto as `code` on 0.0.13, and Auto and Full access as fx names them later", () =>
    Effect.forEach(
      [
        { scenario: "auto-0-0-13", runtimeMode: "auto", modes: FX_0_0_13_MODES, written: "code" },
        { scenario: "auto-main", runtimeMode: "auto", modes: FX_MAIN_MODES, written: "auto" },
        {
          scenario: "full-access-main",
          runtimeMode: "full-access",
          modes: FX_MAIN_MODES,
          written: "full-access",
        },
      ] as const,
      ({ scenario, runtimeMode, modes, written }) =>
        openFxSession({
          scenario,
          runtimeMode,
          frames: [
            ...initialize,
            outbound("session/new", {
              cwd: "<workspace>",
              mcpServers: "<any>",
              _meta: FX_SESSION_META,
            }),
            answer("session/new", fxSession({ model: FX_DEFAULT_MODEL, modes })),
            ...setConfig(
              "mode",
              written,
              fxConfig({ model: FX_DEFAULT_MODEL, modes, mode: written }),
            ),
          ],
        }),
      { discard: true },
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps supervised sessions in the mode set by their runtime policy", () =>
    openFxSession({
      scenario: "supervised-mode-policy",
      runtimeMode: "approval-required",
      modeOptions: [
        { id: "_t3/session-mode", value: "auto" },
        { id: "mode", value: "auto" },
      ],
      frames: [
        ...initialize,
        outbound("session/new", {
          cwd: "<workspace>",
          mcpServers: "<any>",
          _meta: FX_SESSION_META,
        }),
        answer("session/new", fxSession({ model: FX_DEFAULT_MODEL, modes: FX_MAIN_MODES })),
        ...setConfig("mode", "ask", fxConfig({ model: FX_DEFAULT_MODEL, modes: FX_MAIN_MODES })),
      ],
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("restores Default only when its backend is selectable", () =>
    Effect.forEach(
      [
        { backend: "gateway", hasBackendOption: true, restore: true },
        { backend: "unavailable", hasBackendOption: true, restore: false },
        { backend: "gateway", hasBackendOption: false, restore: false },
      ],
      ({ backend, hasBackendOption, restore }) =>
        openFxSession({
          scenario: `default-model-${backend}-${hasBackendOption}`,
          runtimeMode: "approval-required",
          model: "default",
          defaultBackend: backend,
          loadSessionId: SESSION_ID,
          frames: [
            ...initialize,
            outbound("session/load", {
              sessionId: SESSION_ID,
              cwd: "<workspace>",
              mcpServers: "<any>",
              _meta: FX_SESSION_META,
            }),
            answer("session/load", {
              ...fxSession({ model: NAMED_MODEL, modes: FX_0_0_13_MODES }),
              configOptions: fxConfig({ model: NAMED_MODEL, modes: FX_0_0_13_MODES }).filter(
                (option) => hasBackendOption || option.id !== "provider",
              ),
            }),
            ...(restore
              ? setConfig(
                  "model",
                  FX_DEFAULT_MODEL,
                  fxConfig({ model: FX_DEFAULT_MODEL, modes: FX_0_0_13_MODES }),
                )
              : []),
            ...setConfig(
              "mode",
              "ask",
              fxConfig({ model: restore ? FX_DEFAULT_MODEL : NAMED_MODEL, modes: FX_0_0_13_MODES }),
            ),
          ],
        }),
      { discard: true },
    ).pipe(Effect.provide(testLayer)),
  );

  // `fx status` names a gateway model, but this loaded session runs on Codex,
  // whose catalog lacks it: the backend goes back first.
  it.effect("moves a loaded session on another backend back to fx's default backend", () =>
    Effect.gen(function* () {
      for (const modelAvailable of [true, false]) {
        const result = yield* openFxSession({
          scenario: `default-other-backend-${modelAvailable}`,
          runtimeMode: "approval-required",
          model: "default",
          loadSessionId: SESSION_ID,
          frames: [
            ...initialize,
            outbound("session/load"),
            answer(
              "session/load",
              fxSession({
                model: CODEX_MODEL,
                backend: "codex",
                models: [CODEX_MODEL],
                modes: FX_0_0_13_MODES,
              }),
            ),
            // fx then runs the gateway model it saved for that backend.
            ...setConfig(
              "provider",
              "gateway",
              fxConfig({
                model: NAMED_MODEL,
                ...(modelAvailable ? {} : { models: [NAMED_MODEL] }),
                modes: FX_0_0_13_MODES,
              }),
            ),
            ...(modelAvailable
              ? [
                  ...setConfig(
                    "model",
                    FX_DEFAULT_MODEL,
                    fxConfig({ model: FX_DEFAULT_MODEL, modes: FX_0_0_13_MODES }),
                  ),
                  ...setConfig(
                    "mode",
                    "ask",
                    fxConfig({ model: FX_DEFAULT_MODEL, modes: FX_0_0_13_MODES }),
                  ),
                ]
              : setConfig(
                  "provider",
                  "codex",
                  fxConfig({
                    backend: "codex",
                    model: CODEX_MODEL,
                    models: [CODEX_MODEL],
                    modes: FX_0_0_13_MODES,
                  }),
                )),
          ],
        }).pipe(Effect.exit);
        if (modelAvailable) {
          assert.isTrue(Exit.isSuccess(result));
        } else if (Exit.isFailure(result)) {
          assert.include(
            Cause.pretty(result.cause),
            "The default fx model is unavailable on its configured backend.",
          );
        } else {
          assert.fail("Expected Default selection to reject the unavailable model");
        }
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("switches the session's backend, then its model, for a backend's model", () =>
    openFxSession({
      scenario: "backend-model",
      runtimeMode: "approval-required",
      model: `codex:${CODEX_MODEL}`,
      turnModel: "gateway:openai/gpt-5.6-sol",
      frames: [
        ...initialize,
        outbound("session/new"),
        answer("session/new", fxSession({ model: FX_DEFAULT_MODEL, modes: FX_0_0_13_MODES })),
        // fx already picks the thread's model on Codex, so only the backend is written.
        ...setConfig(
          "provider",
          "codex",
          fxConfig({
            model: CODEX_MODEL,
            backend: "codex",
            models: [CODEX_MODEL, "gpt-5.4-mini"],
            modes: FX_0_0_13_MODES,
          }),
        ),
        ...setConfig(
          "mode",
          "ask",
          fxConfig({
            model: CODEX_MODEL,
            backend: "codex",
            models: [CODEX_MODEL, "gpt-5.4-mini"],
            modes: FX_0_0_13_MODES,
          }),
        ),
        // The next turn moves the same session to a gateway model; the id
        // after the backend goes to fx whole, slash included.
        ...setConfig(
          "provider",
          "gateway",
          fxConfig({ model: NAMED_MODEL, modes: FX_0_0_13_MODES }),
        ),
        ...setConfig(
          "model",
          "openai/gpt-5.6-sol",
          fxConfig({ model: "openai/gpt-5.6-sol", modes: FX_0_0_13_MODES }),
        ),
        outbound("session/prompt"),
        answer("session/prompt", { stopReason: "end_turn" }),
      ],
    }).pipe(Effect.provide(testLayer)),
  );

  // fx 0.0.13's gateway takes any model id (src/acp/server.zig
  // handleSetConfigOption) and lists the current one even when its catalog
  // does not, so a custom model reaches fx instead of running on another,
  // and switching back afterwards leaves it again.
  it.effect("sends a custom model fx does not list, and leaves it for Default", () =>
    openFxSession({
      scenario: "custom-model",
      runtimeMode: "approval-required",
      model: CUSTOM_MODEL,
      turnModel: "default",
      frames: [
        ...initialize,
        outbound("session/new"),
        answer("session/new", fxSession({ model: FX_DEFAULT_MODEL, modes: FX_0_0_13_MODES })),
        ...setConfig(
          "model",
          CUSTOM_MODEL,
          fxConfig({ model: CUSTOM_MODEL, modes: FX_0_0_13_MODES }),
        ),
        ...setConfig("mode", "ask", fxConfig({ model: CUSTOM_MODEL, modes: FX_0_0_13_MODES })),
        // Back on Default, which the session started on: fx runs the custom
        // model now, so the write must go out again.
        ...setConfig(
          "model",
          FX_DEFAULT_MODEL,
          fxConfig({ model: FX_DEFAULT_MODEL, modes: FX_0_0_13_MODES }),
        ),
        outbound("session/prompt"),
        answer("session/prompt", { stopReason: "end_turn" }),
      ],
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("retains full replies arriving after failed or cancelled children settle", () =>
    Effect.gen(function* () {
      for (const phase of ["failed", "cancelled"] as const) {
        for (const withPreview of [false, true]) {
          const reply = `Child ${phase}: ${"The complete diagnostic. ".repeat(20)}`;
          const childSessionId = "fx-session-child";
          const events = yield* openFxSession({
            scenario: `late-${phase}-${withPreview}`,
            runtimeMode: "approval-required",
            turnModel: "default",
            frames: [
              ...initialize,
              outbound("session/new"),
              answer("session/new", {
                ...fxSession({ model: FX_DEFAULT_MODEL, modes: FX_MAIN_MODES }),
                _meta: { fx: { hooksVersion: 1 } },
              }),
              ...setConfig(
                "mode",
                "ask",
                fxConfig({ model: FX_DEFAULT_MODEL, modes: FX_MAIN_MODES }),
              ),
              outbound("session/prompt"),
              subagentCall("call_child", "Read package.json"),
              hook(SESSION_ID, "delegation", {
                callId: "call_child",
                childSessionId,
                phase: "dispatched",
              }),
              ...(withPreview ? [subagentPreview("call_child", reply)] : []),
              hook(SESSION_ID, "delegation", {
                callId: "call_child",
                childSessionId,
                phase,
              }),
              hook(SESSION_ID, "tool.end", {
                call: { callId: "call_child", name: "subagent", provenance: "model" },
                output: JSON.stringify({ ok: false, result: reply, error_code: null }),
                status: "success",
              }),
              answer("session/prompt", { stopReason: "end_turn" }),
            ],
          });
          const subagents = events.flatMap((event) =>
            event.type === "subagent.updated" ? [event.subagent] : [],
          );
          const terminal = subagents.filter((subagent) => subagent.status === phase);
          assert.isAtLeast(terminal.length, 2);
          assert.notEqual(terminal[0]?.result, reply);
          const settled = terminal.at(-1);
          assert.equal(settled?.result, reply);
          assert.equal(settled?.completedAt, terminal[0]?.completedAt);
          if (phase === "failed") {
            assert.isFalse(
              events.some(
                (event) =>
                  event.type === "message.updated" &&
                  event.message.threadId === settled?.childThreadId &&
                  event.message.role === "assistant",
              ),
              "a failed result stays on the task without inventing an assistant reply",
            );
          }
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "subagent" &&
                event.turnItem.status === phase &&
                event.turnItem.result === reply,
            ),
          );
        }
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps a child's steps and reply when it outlives its parent's turn", () =>
    Effect.gen(function* () {
      const reply = `FULL_CHILD_REPLY ${"package.json has twelve lines. ".repeat(12)}`;
      const childSessionId = "fx-session-child";
      const childHook = (type: string, data: Record<string, unknown>) =>
        hookEvent(childSessionId, type, data);
      const events = yield* openFxSession({
        scenario: "async-child-outlives-turn",
        runtimeMode: "approval-required",
        turnModel: "default",
        frames: [
          ...initialize,
          outbound("session/new"),
          answer("session/new", {
            ...fxSession({ model: FX_DEFAULT_MODEL, modes: FX_MAIN_MODES }),
            _meta: { fx: { hooksVersion: 1 } },
          }),
          ...setConfig("mode", "ask", fxConfig({ model: FX_DEFAULT_MODEL, modes: FX_MAIN_MODES })),
          outbound("session/prompt"),
          update(SESSION_ID, {
            sessionUpdate: "tool_call",
            toolCallId: "call_child",
            name: "subagent",
            title: "Subagent · reviewer",
            kind: "other",
            status: "pending",
            rawInput: { action: "message", agent: "reviewer", message: "Read package.json" },
          }),
          hook(SESSION_ID, "delegation", {
            callId: "call_child",
            childSessionId,
            phase: "dispatched",
          }),
          subagentPreview("call_child", "Sent to reviewer."),
          hook(SESSION_ID, "tool.end", {
            call: { callId: "call_child", name: "subagent", provenance: "model" },
            output: subagentReply("Sent to reviewer."),
            status: "success",
          }),
          answer("session/prompt", { stopReason: "end_turn" }),
        ],
        afterTurn: {
          until: (event) =>
            event.type === "subagent.updated" && event.subagent.status === "completed",
          hooks: [
            childHook("tool.start", {
              call: {
                callId: "call_read",
                name: "read_file",
                provenance: "model",
                argumentsJson: '{"path":"package.json"}',
              },
            }),
            childHook("tool.end", {
              call: { callId: "call_read", name: "read_file", provenance: "model" },
              output: '{"name":"fixture"}',
              status: "success",
            }),
            childHook("model.start", { modelCallId: 1, purpose: "agent" }),
            childHook("model.end", { modelCallId: 1, output: reply, toolCalls: [] }),
            childHook("turn.end", { outcome: "completed", error: null }),
          ],
        },
      });
      assert.isTrue(
        events.some((event) => event.type === "turn.terminal" && event.status === "completed"),
      );
      const settled = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent] : [],
      );
      const childThreadId = settled.at(-1)?.childThreadId;
      assert.equal(settled.at(-1)?.result, reply);
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.threadId === childThreadId &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.status === "completed",
        ),
        "the child's read step lands in its thread",
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "message.updated" &&
            event.message.threadId === childThreadId &&
            event.message.role === "assistant" &&
            event.message.text === reply,
        ),
        "the child's reply lands in its thread",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  // A restart reloads the session: fx replays the finished call from history
  // with its 200-byte preview and none of the child's steps, which T3 already
  // holds. The reload confirms hooks, so the next sub-agent shows its steps.
  it.effect("leaves a reloaded sub-agent's thread alone and follows the next one", () =>
    Effect.gen(function* () {
      const earlierReply = `package.json names fx-hooks-fixture. ${"It has five scripts. ".repeat(12)}`;
      const reply = `tsconfig.json targets ES2023. ${"Strict mode is on. ".repeat(12)}`;
      const childSessionId = "fx-session-04";
      const events = yield* openFxSession({
        scenario: "reload-subagent",
        runtimeMode: "approval-required",
        loadSessionId: SESSION_ID,
        turnModel: "default",
        frames: [
          ...initialize,
          outbound("session/load", {
            sessionId: SESSION_ID,
            cwd: "<workspace>",
            mcpServers: "<any>",
            _meta: FX_SESSION_META,
          }),
          update(SESSION_ID, {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "Spawn a subagent to read package.json" },
          }),
          subagentCall("call_earlier", "Read package.json"),
          subagentPreview("call_earlier", earlierReply),
          update(SESSION_ID, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "The subagent read package.json." },
          }),
          answer("session/load", {
            ...fxSession({ model: FX_DEFAULT_MODEL, modes: FX_MAIN_MODES }),
            _meta: { fx: { hooksVersion: 1 } },
          }),
          ...setConfig("mode", "ask", fxConfig({ model: FX_DEFAULT_MODEL, modes: FX_MAIN_MODES })),
          outbound("session/prompt"),
          subagentCall("call_next", "Read tsconfig.json"),
          hook(SESSION_ID, "delegation", {
            callId: "call_next",
            childSessionId,
            workId: "work-1",
            operationId: null,
            phase: "dispatched",
          }),
          hook(childSessionId, "tool.start", {
            call: {
              callId: "call_read",
              name: "read_file",
              provenance: "fx_local",
              argumentsJson: '{"path":"tsconfig.json"}',
            },
            rerun: false,
          }),
          hook(childSessionId, "tool.end", {
            call: {
              callId: "call_read",
              name: "read_file",
              provenance: "fx_local",
              argumentsJson: '{"path":"tsconfig.json"}',
            },
            output: '{"compilerOptions":{"target":"ES2023"}}',
            status: "success",
            error: null,
          }),
          hook(SESSION_ID, "delegation", {
            callId: "call_next",
            childSessionId,
            workId: "work-1",
            operationId: null,
            phase: "completed",
          }),
          subagentPreview("call_next", reply),
          hook(SESSION_ID, "tool.end", {
            call: { callId: "call_next", name: "subagent", provenance: "model" },
            output: subagentReply(reply),
            status: "success",
            error: null,
          }),
          answer("session/prompt", { stopReason: "end_turn" }),
        ],
      });

      const subagents = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent] : [],
      );
      assert.deepEqual(
        [...new Set(subagents.map((subagent) => subagent.nativeTaskRef?.nativeId))],
        ["call_next"],
        "the reload projects nothing for the earlier sub-agent",
      );
      assert.lengthOf(
        events.filter((event) => event.type === "app_thread.created"),
        1,
      );
      const settled = subagents.at(-1);
      assert.equal(settled?.status, "completed");
      assert.equal(settled?.result, reply);
      const childItems = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.threadId === settled?.childThreadId
          ? [event.turnItem]
          : [],
      );
      assert.deepInclude(childItems.at(-1), { type: "assistant_message", text: reply });
      assert.isTrue(
        childItems.some(
          (item) =>
            item.type === "dynamic_tool" &&
            item.status === "completed" &&
            item.title === "Read tsconfig.json",
        ),
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
