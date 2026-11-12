import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  RunAttemptId,
  RunId,
  type ModelSelection,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@t3tools/provider-testing/replayGate";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ServerSettings from "../../serverSettings.ts";
import type { AcpRegistryLiveConfiguration } from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { t3AcpPromptWithInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { AcpRegistryAdapterV2Driver } from "@t3tools/provider-acp-registry/server";
import {
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
  acpRegistryProbeResult,
} from "@t3tools/provider-acp-registry/testing";

const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

const layerInjectedRuntimeCatalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
  resolve: () => Effect.die("the runtime is injected"),
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
  layerRegistry,
  ServerSettings.layerTest(),
);

const CLAUDE_ROOT_SESSION = "claude-session";

/** Replay frames of Claude Agent (claude-agent-acp 0.90.0) on ACP v2. */
const claudeFrames = {
  open: [
    { type: "expect_outbound", frame: { kind: "request", method: "initialize", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "initialize",
        result: {
          protocolVersion: 2,
          info: { name: "@agentclientprotocol/claude-agent-acp", version: "0.90.0" },
          capabilities: { session: {} },
          authMethods: [],
        },
      },
    },
    { type: "expect_outbound", frame: { kind: "request", method: "session/new", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "session/new",
        result: { sessionId: CLAUDE_ROOT_SESSION },
      },
    },
  ],
  update: (sessionId: string, sessionUpdate: Record<string, unknown>) => ({
    type: "emit_inbound",
    frame: {
      kind: "notification",
      method: "session/update",
      params: { sessionId, update: sessionUpdate },
    },
  }),
  childState: (parent: string, child: string, state: string) =>
    claudeFrames.update(parent, {
      sessionUpdate: "subagent_update",
      sessionId: child,
      state: { state },
    }),
  /** A prompt Claude takes in and works on. */
  prompt: (ordinal: number) => [
    {
      type: "expect_outbound",
      frame: { kind: "request", method: "session/prompt", params: "<any>" },
    },
    claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "user_message",
      messageId: `user-${ordinal}`,
      content: [{ type: "text", text: "test prompt" }],
    }),
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "session/prompt",
        result: { messageId: `user-${ordinal}` },
      },
    },
    claudeFrames.update(CLAUDE_ROOT_SESSION, { sessionUpdate: "state_update", state: "running" }),
  ],
  idle: (stopReason: string) =>
    claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason,
    }),
  closeRequest: {
    type: "expect_outbound",
    frame: {
      kind: "request",
      method: "session/close",
      params: { sessionId: CLAUDE_ROOT_SESSION },
    },
  },
  closed: {
    type: "emit_inbound",
    frame: { kind: "response", method: "session/close", result: {} },
  },
};

const openClaudeReplaySession = Effect.fn("openClaudeReplaySession")(function* (
  entries: ReadonlyArray<unknown>,
  replayGate?: ProviderReplayGate,
  continuationEnabled = true,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-lifecycle-" });
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: ACP_REGISTRY_PROVIDER,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: "claude-lifecycle",
      entries: entries as never,
    },
    ACP_REGISTRY_PROVIDER,
  );
  const offers: Array<ProviderContinuationRequest> = [];
  const offered = yield* Queue.unbounded<void>();
  const continuationRequests = {
    offer: (request: ProviderContinuationRequest) =>
      Effect.sync(() => {
        offers.push(request);
      }).pipe(Effect.andThen(Queue.offer(offered, undefined)), Effect.asVoid),
  };
  const instanceId = ProviderInstanceId.make("claude-lifecycle");
  let onTermination: NonNullable<
    AcpSessionRuntime.AcpSessionRuntimeOptions["onTermination"]
  > = () => Effect.die("Runtime has not started");
  const replayRuntime = makeAcpReplayRuntime({
    transcript,
    statusPath: path.join(replayDir, "status.json"),
    scriptPath: yield* path.fromFileUrl(
      new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
    ),
    childProcessSpawner,
    fileSystem,
    ...(replayGate === undefined ? {} : { replayGate }),
  });
  const adapterOptions = {
    selfInvocation: yield* resolveSelfInvocation(),
    instanceId,
    settings: yield* decodeAcpRegistryAdapterSettings({ agentId: "claude-acp" }),
    environment: {},
    ...(continuationEnabled ? { continuationRequests } : {}),
    makeRuntime: (runtimeInput: Parameters<typeof replayRuntime>[0]) => {
      onTermination = runtimeInput.onTermination;
      return replayRuntime(runtimeInput);
    },
  };
  const adapter = yield* makeAcpRegistryAdapterV2(adapterOptions).pipe(
    Effect.provide(layerInjectedRuntimeCatalog),
  );
  const threadId = ThreadId.make("thread-claude-lifecycle");
  const modelSelection = { instanceId, model: "default" } as const;
  const runtimeMode = "approval-required";
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: replayDir,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-claude-lifecycle"),
    modelSelection,
    runtimePolicy,
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => replayGate?.releaseAll()));
  if (continuationEnabled) {
    assert.isDefined(
      runtime.hasPendingBackgroundWork,
      "Claude ACP v2 must report background work after foreground idle",
    );
  }
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const turnInput = (
    ordinal: number,
    options: { readonly continuation?: boolean } = {},
  ): ProviderAdapter.ProviderAdapterV2TurnInput => ({
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project-claude-lifecycle`),
      title: "Claude Agent",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode,
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
    runId: RunId.make(`run-claude-lifecycle-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-claude-lifecycle-${ordinal}`),
    rootNodeId: NodeId.make(`node-claude-lifecycle-${ordinal}`),
    providerThread,
    message: {
      ...(options.continuation === true
        ? { createdBy: "agent" as const, creationSource: "provider" as const }
        : { createdBy: "user" as const, creationSource: "web" as const }),
      messageId: MessageId.make(`message-claude-lifecycle-${ordinal}`),
      text: "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  });
  const until = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (predicate(event)) return seen;
      }
    });
  const throughMarker = (title: string) =>
    until(
      (event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.nativeMetadata?.title === title,
    );
  const terminal = until((event) => event.type === "turn.terminal").pipe(
    Effect.map((seen) => {
      const event = seen.at(-1)!;
      if (event.type !== "turn.terminal") throw new Error("Missing terminal");
      return event;
    }),
  );
  return {
    runtime,
    providerThread,
    turnInput,
    until,
    throughMarker,
    terminal,
    offers,
    offered,
    terminate: () =>
      onTermination(
        new EffectAcpErrors.AcpTransportError({
          detail: "Injected fixture process exit",
          cause: "test",
        }),
      ),
  };
});

const claudeMarker = (title: string) =>
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "session_info_update",
    title,
  });
const claudeChild = [
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "tool_call_update",
    toolCallId: "agent-1",
    name: "Agent",
    title: "Review",
    kind: "think",
    status: "in_progress",
    rawInput: { prompt: "Review the code", description: "Review", run_in_background: true },
  }),
  claudeFrames.childState(CLAUDE_ROOT_SESSION, "child-1", "running"),
  claudeFrames.update("child-1", {
    sessionUpdate: "session_message",
    messageId: "agent-1",
    senderSessionId: CLAUDE_ROOT_SESSION,
    recipientSessionId: "child-1",
    content: [{ type: "text", text: "Review the code" }],
  }),
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "tool_call_update",
    toolCallId: "agent-1",
    status: "completed",
    _meta: { claudeCode: { toolResponse: { isAsync: true } } },
  }),
];

const claudeUnrelatedChildren = [
  claudeFrames.childState("unknown-parent", "unrelated-child", "running"),
  claudeFrames.update("unrelated-child", {
    sessionUpdate: "session_message",
    messageId: "agent-1",
    senderSessionId: "unknown-parent",
    content: [{ type: "text", text: "Unrelated delegation" }],
  }),
  claudeFrames.update("unlinked-child", {
    sessionUpdate: "agent_message_chunk",
    messageId: "unlinked-reply",
    content: { type: "text", text: "Unlinked output" },
  }),
];






describe("AcpRegistryAdapterV2", () => {
  describe("the agent's own pickers", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const permissionModeOption = (currentValue: string) => ({
      id: "permission-mode",
      name: "Permission mode",
      category: "mode",
      type: "select",
      currentValue,
      options: ["ask", "auto"].map((value) => ({ value, name: value })),
    });

    const openWithStoredPicks = Effect.fn("openWithStoredPicks")(function* (input: {
      readonly setup: unknown;
      readonly pickFrames: ReadonlyArray<Frame>;
      readonly customModels?: ReadonlyArray<string>;
      readonly storedModel?: string;
      readonly storedModePick?: string;
      readonly turnModels?: ReadonlyArray<string>;
      readonly rejectedModel?: string;
    }) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Scope release gives the replay agent at most a second to exit, so the status
      // read below waits for the agent itself instead of racing its last write.
      const agentExits: Array<Effect.Effect<void>> = [];
      const childProcessSpawner = ChildProcessSpawner.make((command) =>
        spawner
          .spawn(command)
          .pipe(
            Effect.tap((handle) =>
              Effect.sync(() => agentExits.push(Effect.ignore(handle.exitCode))),
            ),
          ),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-stored-picks-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-picks",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.pickFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-stored-picks");
      let published: AcpRegistryLiveConfiguration | undefined;
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "test",
          customModels: input.customModels ?? [],
        }),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          customModels: input.customModels,
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerInjectedRuntimeCatalog,
            Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
              withForegroundStartup: (_startupKey, effect) => effect,
              publishLiveConfiguration: (_instanceId, configuration) =>
                Effect.sync(() => {
                  published = configuration;
                }),
            }),
          ),
        ),
      );
      const threadId = ThreadId.make("thread-acp-registry-stored-picks");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: replayDir,
      });
      const stored: ModelSelection = {
        instanceId,
        model: input.storedModel ?? "default",
        ...(input.storedModePick === undefined
          ? {}
          : { options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick }] }),
      };
      const configurations: Array<AcpRegistryLiveConfiguration | undefined> = [];
      yield* Effect.gen(function* () {
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-stored-picks"),
          modelSelection: stored,
          runtimePolicy,
        });
        configurations.push(published);
        if (input.turnModels === undefined) return;
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: stored,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        let current = stored;
        for (const [index, model] of input.turnModels.entries()) {
          const target: ModelSelection = { instanceId, model };
          const plan = yield* adapter.planSelectionTransition({
            current,
            target,
            sessionCapabilities: runtime.providerSession.capabilities,
          });
          assert.equal(plan.type, "apply_on_next_turn");
          yield* runtime.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now,
              ordinal: index + 1,
              modelSelection: target,
            }),
          );
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "turn.terminal") {
                  assert.equal(event.status, "completed", event.failure?.message);
                }
              }),
            ),
          );
          configurations.push(published);
          current = target;
        }
      }).pipe(
        Effect.match({
          onFailure: (error) => {
            assert.isDefined(input.rejectedModel);
            assert.equal(
              makeProviderFailure({ cause: error }).message,
              `The agent did not accept the model "${input.rejectedModel}". Choose another model for this provider, then retry.`,
            );
          },
          onSuccess: () => assert.isUndefined(input.rejectedModel),
        }),
        Effect.scoped,
      );
      yield* Effect.all(agentExits, { discard: true });
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
      return { configurations };
    });

    it.effect("switches an agent that only advertises modes with session/set_mode", () =>
      openWithStoredPicks({
        setup: {
          modes: {
            currentModeId: "default",
            availableModes: ["default", "autoEdit"].map((id) => ({ id, name: id })),
          },
        },
        pickFrames: [
          outbound("session/set_mode", { sessionId: "agent-session", modeId: "autoEdit" }),
          answer("session/set_mode", {}),
        ],
        storedModePick: "autoEdit",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("switches a mode config option under its own id", () =>
      openWithStoredPicks({
        setup: { configOptions: [permissionModeOption("ask")] },
        pickFrames: [
          outbound("session/set_config_option", {
            sessionId: "agent-session",
            configId: "permission-mode",
            value: "auto",
          }),
          answer("session/set_config_option", { configOptions: [permissionModeOption("auto")] }),
        ],
        storedModePick: "auto",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    const modelOption = (id: string, currentValue: string, grouped = false) => ({
      id,
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: grouped
        ? [{ group: "models", name: "Models", options: [{ value: "default", name: "Default" }] }]
        : [{ value: "auto", name: "Auto" }],
    });
    const configOptionUpdate = (configOptions: ReadonlyArray<unknown>): Frame => ({
      type: "emit_inbound",
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: "agent-session",
          update: { sessionUpdate: "config_option_update", configOptions },
        },
      },
    });
    const prompt = (...updates: ReadonlyArray<Frame>): ReadonlyArray<Frame> => [
      outbound("session/prompt"),
      ...updates,
      answer("session/prompt", { stopReason: "end_turn" }),
    ];
    const setModel = (modelId: string): ReadonlyArray<Frame> => [
      outbound("session/set_model", { sessionId: "agent-session", modelId }),
      answer("session/set_model", {}),
    ];

    it.effect(
      "discovers session models and switches through live model configuration changes",
      () =>
        Effect.gen(function* () {
          const flatOption = (current: string) => modelOption("live-model", current);
          const groupedOption = (current: string) =>
            modelOption("replacement-model", current, true);
          const { configurations } = yield* openWithStoredPicks({
            setup: {
              models: {
                currentModelId: "hermes",
                availableModels: ["hermes", "auto", "default"].map((modelId) => ({
                  modelId,
                  name: modelId,
                })),
              },
            },
            customModels: ["custom-model"],
            storedModel: "default",
            turnModels: [
              "hermes",
              "custom-model",
              "auto",
              "default",
              "hermes",
              "custom-model",
              "auto",
              "custom-model",
              "default",
              "hermes",
            ],
            pickFrames: [
              ...setModel("default"),
              ...setModel("hermes"),
              ...prompt(),
              ...setModel("custom-model"),
              ...prompt(),
              ...setModel("auto"),
              ...prompt(),
              ...setModel("default"),
              ...prompt(),
              ...setModel("hermes"),
              ...prompt(configOptionUpdate([flatOption("hermes")])),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "live-model",
                value: "custom-model",
              }),
              answer("session/set_config_option", { configOptions: [flatOption("custom-model")] }),
              ...prompt(),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "live-model",
                value: "auto",
              }),
              answer("session/set_config_option", { configOptions: [flatOption("auto")] }),
              ...prompt(configOptionUpdate([groupedOption("auto")])),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "replacement-model",
                value: "custom-model",
              }),
              answer("session/set_config_option", {
                configOptions: [groupedOption("custom-model")],
              }),
              ...prompt(),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "replacement-model",
                value: "default",
              }),
              answer("session/set_config_option", { configOptions: [groupedOption("default")] }),
              ...prompt(configOptionUpdate([])),
              ...setModel("hermes"),
              ...prompt(),
            ],
          });
          assert.deepEqual(
            configurations.map((configuration) => ({
              models: configuration?.models.map((model) => model.id),
              current: configuration?.currentModelId,
            })),
            [
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["hermes", "auto", "default"], current: "hermes" },
              { models: ["hermes", "auto", "default"], current: null },
              { models: ["hermes", "auto", "default"], current: "auto" },
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["auto"], current: null },
              { models: ["auto"], current: null },
              { models: ["default"], current: null },
              { models: ["default"], current: null },
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["hermes", "auto", "default"], current: "hermes" },
            ],
          );
        }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect.each([
      "config",
      "legacy",
      "updated-config",
      "removed-config",
      "configuration-update",
      "unavailable-before-configuration",
    ] as const)(
      "rejects an unavailable explicit model in a %s catalog before inference",
      (catalog) => {
        const duringTurn = catalog === "updated-config" || catalog === "removed-config";
        const duringConfiguration = catalog === "configuration-update";
        const changesOptions =
          duringConfiguration || catalog === "unavailable-before-configuration";
        const model = duringTurn || duringConfiguration ? "hermes" : "missing";
        const restrictedOption = {
          ...modelOption("model", "other"),
          options: [{ value: "other", name: "Other" }],
        };
        return openWithStoredPicks({
          setup: {
            ...(catalog === "legacy" || catalog === "removed-config"
              ? {
                  models: {
                    currentModelId: "other",
                    availableModels: [{ modelId: "other", name: "Other" }],
                  },
                }
              : {}),
            configOptions:
              catalog === "legacy"
                ? []
                : [
                    {
                      ...modelOption("model", "hermes"),
                      options: [{ value: "hermes", name: "Hermes" }],
                    },
                    ...(changesOptions ? [permissionModeOption("ask")] : []),
                  ],
          },
          storedModel: model,
          ...(duringTurn ? { turnModels: [model, model] } : {}),
          ...(changesOptions ? { storedModePick: "auto" } : {}),
          rejectedModel: model,
          pickFrames: duringTurn
            ? prompt(configOptionUpdate(catalog === "removed-config" ? [] : [restrictedOption]))
            : duringConfiguration
              ? [
                  outbound("session/set_config_option", {
                    sessionId: "agent-session",
                    configId: "permission-mode",
                    value: "auto",
                  }),
                  answer("session/set_config_option", {
                    configOptions: [restrictedOption, permissionModeOption("auto")],
                  }),
                ]
              : [],
        }).pipe(Effect.provide(layerTest), Effect.scoped);
      },
    );

    // regression: #19519 models come from session model state, not a hardcoded list
    it.effect("keeps unadvertised default and auto selections agent-controlled", () =>
      Effect.gen(function* () {
        const { configurations } = yield* openWithStoredPicks({
          setup: {
            models: {
              currentModelId: "hermes",
              availableModels: ["hermes", "other"].map((modelId) => ({ modelId, name: modelId })),
            },
          },
          storedModel: "default",
          turnModels: ["auto", "default", "other", "default", "auto", "default", "auto"],
          pickFrames: [
            ...prompt(),
            ...prompt(),
            ...setModel("other"),
            ...prompt(
              configOptionUpdate([
                {
                  ...modelOption("live-model", "other"),
                  options: [{ value: "other", name: "Other" }],
                },
              ]),
            ),
            ...prompt(),
            ...prompt(),
            ...prompt(
              configOptionUpdate([
                {
                  ...modelOption("replacement-model", "other", true),
                  options: [
                    {
                      group: "models",
                      name: "Models",
                      options: [{ value: "other", name: "Other" }],
                    },
                  ],
                },
              ]),
            ),
            ...prompt(),
          ],
        });
        assert.deepEqual(
          configurations.map((configuration) => configuration?.currentModelId),
          ["hermes", "hermes", "hermes", "other", "other", "other", "other", "other"],
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
    const modelOptions = [
      { id: "fast", name: "Fast", category: "model", type: "boolean", currentValue: false },
      {
        id: " ",
        name: "Unnamed",
        category: "model",
        type: "select",
        currentValue: "unaddressable",
        options: [{ value: "unaddressable", name: "Unaddressable" }],
      },
      {
        id: "provider",
        name: "Provider",
        category: "model",
        type: "select",
        currentValue: "gateway",
        options: [
          {
            group: "hosted",
            name: "Hosted",
            options: [
              { value: "gateway", name: "Gateway" },
              { value: "codex", name: "Codex" },
            ],
          },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "later-model",
        options: [{ value: "later-model", name: "Later model" }],
      },
    ] as const;

    it.effect("opens a model from the catalog by writing the first usable model select", () =>
      Effect.gen(function* () {
        const setup = { sessionId: "agent-session", configOptions: modelOptions };
        const catalog = acpRegistryProbeResult(ProviderInstanceId.make("acp-registry-mode-pick"), {
          sessionId: setup.sessionId,
          initializeResult: { protocolVersion: 1 },
          sessionSetupResult: {
            ...setup,
            // The catalog uses the normalized groupId; ACP v1 sends group on the wire.
            configOptions: modelOptions.map((option) =>
              option.id === "provider"
                ? {
                    ...option,
                    options: [{ ...option.options[0], groupId: option.options[0].group }],
                  }
                : option,
            ),
          },
          modelConfigId: "provider",
        });
        assert.deepEqual(catalog.models, [
          { id: "gateway", name: "Gateway", description: null },
          { id: "codex", name: "Codex", description: null },
        ]);
        assert.equal(catalog.currentModelId, "gateway");
        const model = catalog.models[1]?.id;
        assert.isDefined(model);
        const opened = yield* openWithStoredPicks({
          setup,
          pickFrames: [
            outbound("session/set_config_option", {
              sessionId: "agent-session",
              configId: "provider",
              value: "codex",
            }),
            answer("session/set_config_option", {
              configOptions: modelOptions.map((option) =>
                option.id === "provider" ? { ...option, currentValue: "codex" } : option,
              ),
            }),
          ],
          storedModel: model,
        });
        assert.equal(opened.configurations.at(-1)?.currentModelId, "codex");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
  });
});


