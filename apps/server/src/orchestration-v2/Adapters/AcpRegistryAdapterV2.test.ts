import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderTurnId,
  RunAttemptId,
  RunId,
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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@t3tools/provider-testing/replayGate";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ServerSettings from "../../serverSettings.ts";
import type {
  AcpRegistryAvailableCommands,
  AcpRegistryLiveConfiguration,
} from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import { AcpRegistryAdapterV2Driver } from "@t3tools/provider-acp-registry/server";
import {
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
} from "@t3tools/provider-acp-registry/testing";

const registryUrl = "https://registry.test/registry.json";
const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

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

// Adapters given an explicit runtime never resolve through the catalog.
const layerInjectedRuntimeCatalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
  resolve: () => Effect.die("the runtime is injected"),
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
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

/**
 * Opens a Claude Agent session over replayed agent processes: the first runs
 * `entries`, and one that replaces it (after an exit or a Stop) runs
 * `replacement`. Each turn of the session is a user turn unless it continues
 * an offer the agent opened.
 */
const openClaudeReplaySession = Effect.fn("openClaudeReplaySession")(function* (input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<unknown>;
  readonly replacement?: ReadonlyArray<unknown>;
  readonly replayGate?: ProviderReplayGate;
  readonly runtimeMode?: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"];
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: `t3-acp-registry-${input.scenario}-`,
  });
  const decode = (scenario: string, entries: ReadonlyArray<unknown>) =>
    decodeAcpReplayTranscript(
      {
        provider: ACP_REGISTRY_PROVIDER,
        protocol: "acp.ndjson-jsonrpc",
        version: "1",
        scenario,
        entries: entries as never,
      },
      ACP_REGISTRY_PROVIDER,
    );
  const transcript = yield* decode(input.scenario, input.entries);
  const replacement =
    input.replacement === undefined
      ? undefined
      : yield* decode(`${input.scenario}-replacement`, input.replacement);
  const statusPath = path.join(replayDir, "status.json");
  const scriptPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
  );
  // The first agent process's exit, once the adapter handled it.
  const exited = yield* Deferred.make<void>();
  const offered = yield* Deferred.make<ProviderContinuationRequest>();
  let starts = 0;
  const instanceId = ProviderInstanceId.make(`acp-registry-${input.scenario}`);
  const adapter = yield* makeAcpRegistryAdapterV2({
    selfInvocation: yield* resolveSelfInvocation(),
    instanceId,
    settings: yield* decodeAcpRegistryAdapterSettings({ agentId: "claude-acp" }),
    environment: {},
    continuationRequests: {
      offer: (request) => Deferred.succeed(offered, request).pipe(Effect.asVoid),
    },
    makeRuntime: (runtimeInput) => {
      const first = starts++ === 0;
      if (!first && replacement === undefined) {
        return Effect.die(`${input.scenario} replays no replacement agent process`);
      }
      return makeAcpReplayRuntime({
        transcript: first ? transcript : replacement!,
        statusPath: first ? statusPath : path.join(replayDir, "replacement-status.json"),
        scriptPath,
        childProcessSpawner,
        fileSystem,
        ...(first && input.replayGate !== undefined ? { replayGate: input.replayGate } : {}),
      })(
        first
          ? {
              ...runtimeInput,
              onTermination: (error) =>
                runtimeInput
                  .onTermination(error)
                  .pipe(Effect.andThen(Deferred.succeed(exited, undefined))),
            }
          : runtimeInput,
      );
    },
  }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
  const threadId = ThreadId.make(`thread-acp-registry-${input.scenario}`);
  const modelSelection = { instanceId, model: "default" } as const;
  const runtimeMode = input.runtimeMode ?? "full-access";
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: replayDir,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`provider-session-${input.scenario}`),
    modelSelection,
    runtimePolicy,
  });
  const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
  if (hasPendingBackgroundWork === undefined) {
    return yield* Effect.die("Claude Agent's runtime must report pending background work");
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
      projectId: ProjectId.make(`project-${input.scenario}`),
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
    runId: RunId.make(`run-${input.scenario}-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-${input.scenario}-${ordinal}`),
    rootNodeId: NodeId.make(`node-${input.scenario}-${ordinal}`),
    providerThread,
    message: {
      ...(options.continuation === true
        ? { createdBy: "agent" as const, creationSource: "provider" as const }
        : { createdBy: "user" as const, creationSource: "web" as const }),
      messageId: MessageId.make(`message-${input.scenario}-${ordinal}`),
      text: "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  });
  /** Waits for the next turn to end. */
  const turnEnd = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events);
      if (event.type === "turn.terminal") return event;
    }
  });
  return {
    runtime,
    providerThread,
    events,
    hasPendingBackgroundWork,
    turnInput,
    turnEnd,
    exited: Deferred.await(exited),
    offered: Deferred.await(offered),
    starts: () => starts,
    assertReplayed: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
  };
});

describe("AcpRegistryAdapterV2", () => {
  it("preserves and sanitizes structured ACP errors without exposing arbitrary defects", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
    });
    assert.deepEqual(acpRegistryPromptFailure("mistral-vibe", limit), {
      class: "usage_limit",
      message: limit.errorMessage,
      code: "-31001",
      retryable: null,
    });
    assert.equal(acpRegistryPromptFailure("other-agent", limit).class, "provider_error");
    assert.equal(
      acpRegistryPromptFailure("mistral-vibe", new Error("private defect")).message,
      "Provider turn failed.",
    );
    const rejected = acpRegistryPromptFailure(
      "any-agent",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Request rejected. api_key=private-key https://example.test/?token=secret",
      }),
    );
    assert.include(rejected.message, "Request rejected.");
    assert.notInclude(rejected.message, "private-key");
    assert.notInclude(rejected.message, "token=secret");
  });
  it("is registered as a generic provider driver with schema defaults", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(ACP_REGISTRY_PROVIDER));
    assert.equal(AcpRegistryAdapterV2Driver.driverKind, ACP_REGISTRY_PROVIDER);
    assert.deepEqual(AcpRegistryAdapterV2Driver.defaultConfig(), {
      source: "registry",
      commandArgs: [],
      enabled: true,
      agentId: "",
      commandPath: "",
      authMethodId: "",
      distribution: "auto",
      customModels: [],
    });
  });

  describe("the agent's own mode picker", () => {
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

    // A scripted ACP v1 agent: initialize, session/new answered with `setup`,
    // then the frames T3 must send (and the agent's answers) to apply the
    // user's stored pick from the agent's mode picker.
    const openWithStoredModePick = Effect.fn("openWithStoredModePick")(function* (input: {
      readonly setup: unknown;
      readonly modeFrames: ReadonlyArray<Frame>;
      readonly storedModePick: string;
    }) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-mode-pick-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-mode-pick",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.modeFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-mode-pick");
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "test",
        }),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
      yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-acp-registry-mode-pick"),
          providerSessionId: ProviderSessionId.make("provider-session-mode-pick"),
          modelSelection: {
            instanceId,
            model: "default",
            options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick }],
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: replayDir,
          }),
        })
        .pipe(Effect.scoped);
      // Closing the session stops the agent. It records its replay status before
      // sending each answer, so the status is final once T3 has read the last
      // one. The script must be consumed exactly.
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
    });

    it.effect("switches an agent that only advertises modes with session/set_mode", () =>
      openWithStoredModePick({
        setup: {
          modes: {
            currentModeId: "default",
            availableModes: ["default", "autoEdit"].map((id) => ({ id, name: id })),
          },
        },
        modeFrames: [
          outbound("session/set_mode", { sessionId: "agent-session", modeId: "autoEdit" }),
          answer("session/set_mode", {}),
        ],
        storedModePick: "autoEdit",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("switches a mode config option under its own id", () =>
      openWithStoredModePick({
        setup: { configOptions: [permissionModeOption("ask")] },
        modeFrames: [
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
  });

  it.effect("offers client terminals to Devin only and client fs to no registry agent", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const advertisedCapabilities = Effect.fn("advertisedCapabilities")(function* (
        agentId: string,
      ) {
        let clientCapabilities: unknown;
        const instanceId = ProviderInstanceId.make(`acp-registry-capabilities-${agentId}`);
        const adapter = yield* makeAcpRegistryAdapterV2({
          selfInvocation: yield* resolveSelfInvocation(),
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId, authMethodId: "test" }),
          environment: {},
          makeRuntime: (input) =>
            Effect.gen(function* () {
              clientCapabilities = input.clientCapabilities;
              const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
              const context = yield* Layer.build(
                AcpSessionRuntime.layer({
                  ...runtimeInput,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    cwd: input.cwd,
                    env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                  },
                  authMethodId: "test",
                }).pipe(
                  Layer.provide(
                    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                  ),
                ),
              );
              return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
                Effect.provide(context),
              );
            }),
        }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        yield* adapter.openSession({
          threadId: ThreadId.make(`thread-acp-registry-capabilities-${agentId}`),
          providerSessionId: ProviderSessionId.make(`provider-session-capabilities-${agentId}`),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy,
        });
        return clientCapabilities;
      });

      assert.deepInclude(yield* advertisedCapabilities("devin"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      });
      assert.deepInclude(yield* advertisedCapabilities("gemini"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("launches Claude Agent on ACP v2 unless its instance environment decides", () =>
    Effect.gen(function* () {
      const launchSwitch = Effect.fn("launchSwitch")(function* (
        config: Record<string, unknown>,
        environment: NodeJS.ProcessEnv = {},
      ) {
        let launched: NodeJS.ProcessEnv | undefined;
        const instanceId = ProviderInstanceId.make("acp-registry-launch-environment");
        const adapter = yield* makeAcpRegistryAdapterV2({
          selfInvocation: yield* resolveSelfInvocation(),
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings(config),
          environment,
        }).pipe(
          Effect.provide(
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: (_settings, _cwd, launchEnvironment) => {
                launched = launchEnvironment;
                return Effect.fail(
                  new AcpRegistrySupport.AcpRegistryError({
                    reason: "runner_unavailable",
                    detail: "Recorded the launch environment.",
                  }),
                );
              },
            }),
          ),
        );
        yield* adapter
          .openSession({
            threadId: ThreadId.make("thread-acp-registry-launch-environment"),
            providerSessionId: ProviderSessionId.make("provider-session-launch-environment"),
            modelSelection: { instanceId, model: "default" },
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: process.cwd(),
            }),
          })
          .pipe(Effect.flip);
        return launched?.CLAUDE_AGENT_ACP_EXPERIMENTAL_V2;
      });

      assert.equal(yield* launchSwitch({ agentId: "claude-acp" }), "1");
      assert.equal(
        yield* launchSwitch(
          { source: "local", commandPath: "/opt/bin/claude-agent-acp" },
          { PATH: "/opt/bin" },
        ),
        "1",
      );
      assert.equal(
        yield* launchSwitch({ agentId: "claude-acp" }, { CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "0" }),
        "0",
      );
      assert.isUndefined(yield* launchSwitch({ agentId: "gemini" }));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps Claude Agent's session while any subagent runs, until Stop ends them", () =>
    Effect.gen(function* () {
      const { childState, update, idle, prompt, closeRequest, closed } = claudeFrames;
      const session = yield* openClaudeReplaySession({
        scenario: "claude-pending-work",
        entries: [
          ...claudeFrames.open,
          // Run 1 ends while only a nested subagent still runs.
          ...prompt(1),
          childState(CLAUDE_ROOT_SESSION, "child-1", "running"),
          childState("child-1", "grandchild-1", "running"),
          childState(CLAUDE_ROOT_SESSION, "child-1", "idle"),
          idle("end_turn"),
          // Run 2 starts another subagent and is stopped with a restart.
          ...prompt(2),
          childState(CLAUDE_ROOT_SESSION, "child-2", "running"),
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "agent_message_chunk",
            messageId: "msg-2",
            content: { type: "text", text: "Working on it." },
          }),
          // Its subagents run on after a cancel, so Stop closes the session:
          // Claude's teardown ends its query and with it every subagent,
          // then answers.
          closeRequest,
          idle("cancelled"),
          closed,
          { type: "runtime_exit", status: "success" },
        ],
      });
      const { runtime, events, hasPendingBackgroundWork, turnInput, turnEnd } = session;

      yield* runtime.startTurn(turnInput(1));
      assert.equal((yield* turnEnd).status, "completed");
      assert.isTrue(yield* hasPendingBackgroundWork, "a running nested subagent keeps the session");

      yield* runtime.startTurn(turnInput(2));
      // Stop once Claude has taken the prompt in and is working on it.
      let secondTurnId: ProviderTurnId | undefined;
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === "provider_turn.updated" && event.providerTurn.status === "running") {
          secondTurnId = event.providerTurn.id;
        }
        if (event.type === "message.updated" && secondTurnId !== undefined) break;
      }
      yield* runtime.interruptTurn({
        providerThread: session.providerThread,
        providerTurnId: secondTurnId,
        requestRuntimeRestart: true,
      });
      assert.equal((yield* turnEnd).status, "interrupted");
      assert.isFalse(yield* hasPendingBackgroundWork, "Stop ended the subagents");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps Claude Agent's work after a refused close, until a retried Stop closes it", () =>
    Effect.gen(function* () {
      const { childState, idle, prompt, closeRequest, closed } = claudeFrames;
      const session = yield* openClaudeReplaySession({
        scenario: "claude-close-refused",
        entries: [
          ...claudeFrames.open,
          ...prompt(1),
          childState(CLAUDE_ROOT_SESSION, "child-1", "running"),
          childState("child-1", "grandchild-1", "running"),
          childState(CLAUDE_ROOT_SESSION, "child-1", "idle"),
          idle("end_turn"),
          // The agent stays connected but refuses the first close.
          closeRequest,
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/close",
              error: { code: -32603, message: "Internal error" },
            },
          },
          closeRequest,
          closed,
          { type: "runtime_exit", status: "success" },
        ],
      });
      const { runtime, hasPendingBackgroundWork, turnInput, turnEnd } = session;

      yield* runtime.startTurn(turnInput(1));
      const ended = yield* turnEnd;
      assert.equal(ended.status, "completed");
      const stop = {
        providerThread: session.providerThread,
        providerTurnId: ended.providerTurnId,
        requestRuntimeRestart: true,
      };
      const refused = yield* runtime.interruptTurn(stop).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(refused), "Stop fails while the agent's work may still run");
      assert.isTrue(yield* hasPendingBackgroundWork, "the subagents still keep the session");
      yield* runtime.interruptTurn(stop);
      assert.isFalse(yield* hasPendingBackgroundWork, "the retried close ended the subagents");
      yield* session.assertReplayed;
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("fails Stop when Claude Agent does not answer its close in time", () =>
    Effect.gen(function* () {
      const { childState, idle, prompt, closeRequest } = claudeFrames;
      const replayGate = makeProviderReplayGate(["close.answer"]);
      const session = yield* openClaudeReplaySession({
        scenario: "claude-close-unanswered",
        replayGate,
        entries: [
          ...claudeFrames.open,
          ...prompt(1),
          childState(CLAUDE_ROOT_SESSION, "child-1", "running"),
          idle("end_turn"),
          closeRequest,
          // Held: the agent never answers in time.
          { ...claudeFrames.closed, label: "close.answer" },
        ],
      });
      const { runtime, hasPendingBackgroundWork, turnInput, turnEnd } = session;

      yield* runtime.startTurn(turnInput(1));
      const ended = yield* turnEnd;
      const stop = yield* runtime
        .interruptTurn({
          providerThread: session.providerThread,
          providerTurnId: ended.providerTurnId,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.exit, Effect.forkScoped);
      // The agent got the close; the answer it writes waits at the gate.
      assert.isTrue(yield* Effect.promise(() => replayGate.waitForReached("close.answer")));
      yield* TestClock.adjust("10 seconds");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(stop)));
      assert.isTrue(yield* hasPendingBackgroundWork, "the subagent still keeps the session");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  const cycleIdle = {
    completed: claudeFrames.idle("end_turn"),
    cancelled: claudeFrames.idle("cancelled"),
    failed: claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: { code: -32603, message: "API Error: 529 overloaded" },
    }),
  };
  const cycleEcho = {
    user_message: claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "user_message",
      messageId: "user-cycle",
      content: [{ type: "text", text: "Background work ended." }],
    }),
    user_message_chunk: claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "user_message_chunk",
      messageId: "user-cycle",
      content: { type: "text", text: "Background work ended." },
    }),
  };

  it.effect.each([
    { ended: "completed", echo: "user_message", idleBeforeAttach: true },
    { ended: "completed", echo: "user_message_chunk", idleBeforeAttach: true },
    { ended: "cancelled", echo: "user_message_chunk", idleBeforeAttach: true },
    { ended: "failed", echo: "user_message_chunk", idleBeforeAttach: true },
    { ended: "completed", echo: "user_message_chunk", idleBeforeAttach: false },
  ] as const)(
    "ends a continuation $ended at Claude's own cycle idle (echo $echo, idle before attach: $idleBeforeAttach)",
    (testCase) =>
      Effect.gen(function* () {
        const { update, idle, prompt } = claudeFrames;
        // A session_info_update shows as provider_thread.updated once the
        // adapter handled it and every frame before it.
        const marker = (title: string) =>
          update(CLAUDE_ROOT_SESSION, { sessionUpdate: "session_info_update", title });
        const replayGate = makeProviderReplayGate(["attached"]);
        const session = yield* openClaudeReplaySession({
          scenario: `claude-cycle-${testCase.ended}-${testCase.echo}-${testCase.idleBeforeAttach}`,
          replayGate,
          entries: [
            ...claudeFrames.open,
            ...prompt(1),
            idle("end_turn"),
            // Claude's own cycle, with no turn to show it yet.
            update(CLAUDE_ROOT_SESSION, { sessionUpdate: "state_update", state: "running" }),
            cycleEcho[testCase.echo],
            update(CLAUDE_ROOT_SESSION, {
              sessionUpdate: "agent_message_chunk",
              messageId: "msg-cycle",
              content: { type: "text", text: "Reporting the result." },
            }),
            ...(testCase.idleBeforeAttach ? [cycleIdle[testCase.ended]] : []),
            marker("cycle seen"),
            { ...marker("attached"), label: "attached" },
            ...(testCase.idleBeforeAttach ? [] : [cycleIdle[testCase.ended]]),
          ],
        });
        const { runtime, events, turnInput, turnEnd } = session;
        /** The turn ends seen until the marker titled `title`. */
        const terminalsUntil = (title: string) =>
          Effect.gen(function* () {
            const terminals: Array<string> = [];
            while (true) {
              const event = yield* Queue.take(events);
              if (event.type === "turn.terminal") terminals.push(event.status);
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.nativeMetadata?.title === title
              ) {
                return terminals;
              }
            }
          });

        yield* runtime.startTurn(turnInput(1));
        assert.equal((yield* turnEnd).status, "completed");
        yield* session.offered;
        assert.deepEqual(yield* terminalsUntil("cycle seen"), []);
        yield* runtime.startTurn(turnInput(2, { continuation: true }));
        replayGate.release("attached");
        // An idle the cycle reported before the attach ends the run now; one
        // still ahead ends it when it arrives.
        assert.deepEqual(
          yield* terminalsUntil("attached"),
          testCase.idleBeforeAttach ? [testCase.ended] : [],
        );
        if (!testCase.idleBeforeAttach) {
          assert.equal((yield* turnEnd).status, testCase.ended);
        }
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  const backgroundRequests = {
    approval: {
      type: "emit_inbound",
      frame: {
        kind: "request",
        method: "session/request_permission",
        params: {
          sessionId: "child-1",
          title: "Run sleep 300?",
          subject: {
            type: "tool_call",
            toolCall: {
              toolCallId: "toolu_child_bash",
              name: "Bash",
              title: "sleep 300",
              kind: "execute",
              status: "pending",
              rawInput: { command: "sleep 300" },
            },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      },
    },
    question: {
      type: "emit_inbound",
      frame: {
        kind: "request",
        method: "elicitation/create",
        params: {
          sessionId: "child-1",
          mode: "form",
          message: "Which file should I fix?",
          requestedSchema: {
            type: "object",
            properties: { file: { type: "string", title: "File", enum: ["a.ts", "b.ts"] } },
            required: ["file"],
          },
        },
      },
    },
  };
  it.effect.each(Object.entries(backgroundRequests))(
    "fails the run of a background %s the agent's exit dropped",
    ([kind, request]) =>
      Effect.gen(function* () {
        const { update, childState, idle, prompt } = claudeFrames;
        const replayGate = makeProviderReplayGate(["before.exit"]);
        const session = yield* openClaudeReplaySession({
          scenario: `claude-${kind}-exit`,
          runtimeMode: "approval-required",
          replayGate,
          entries: [
            ...claudeFrames.open,
            // Run 1 ends while its background subagent works.
            ...prompt(1),
            update(CLAUDE_ROOT_SESSION, {
              sessionUpdate: "tool_call_update",
              toolCallId: "toolu_agent_1",
              name: "Agent",
              title: "Background work",
              kind: "think",
              status: "in_progress",
              rawInput: {
                description: "Background work",
                prompt: "Run sleep 300.",
                run_in_background: true,
              },
            }),
            childState(CLAUDE_ROOT_SESSION, "child-1", "running"),
            update("child-1", {
              sessionUpdate: "session_message",
              messageId: "toolu_agent_1",
              senderSessionId: CLAUDE_ROOT_SESSION,
              recipientSessionId: "child-1",
              content: [{ type: "text", text: "Run sleep 300." }],
            }),
            update(CLAUDE_ROOT_SESSION, {
              sessionUpdate: "tool_call_update",
              toolCallId: "toolu_agent_1",
              status: "completed",
              _meta: { claudeCode: { toolResponse: { status: "async_launched", isAsync: true } } },
            }),
            idle("end_turn"),
            // The subagent asks while no turn runs, then the agent dies.
            request,
            {
              ...update(CLAUDE_ROOT_SESSION, { sessionUpdate: "session_info_update", title: "x" }),
              label: "before.exit",
            },
            { type: "runtime_exit", status: "error" },
          ],
          // The replacement resumes the session and has nothing to say.
          replacement: [
            ...claudeFrames.open,
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/resume", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: { kind: "response", method: "session/resume", result: {} },
            },
          ],
        });
        const { runtime, turnInput, turnEnd } = session;

        yield* runtime.startTurn(turnInput(1));
        assert.equal((yield* turnEnd).status, "completed");
        // The request opened a continuation run, which is dispatched before
        // the agent exits.
        const offer = yield* session.offered;
        if (offer.dispatchIfCurrent === undefined) {
          return yield* Effect.die("a request's continuation offer is dispatched once");
        }
        const dispatched = yield* offer.dispatchIfCurrent(Effect.void);
        assert.isTrue(Option.isSome(dispatched));
        assert.isTrue(yield* Effect.promise(() => replayGate.waitForReached("before.exit")));
        replayGate.release("before.exit");
        yield* session.exited;

        yield* runtime.startTurn(turnInput(2, { continuation: true }));
        const ended = yield* turnEnd;
        assert.equal(ended.status, "failed", "the request died with the agent");
        assert.equal(session.starts(), 2);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("opens a real ACP child process resolved from registry configuration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: host.paths.providerStatusCacheDir,
        toolsDir: host.paths.baseDir + "/tools",
        registryUrl,
      });
      const settings = yield* decodeAcpRegistryAdapterSettings({
        agentId: "fixture-agent",
        commandPath: process.execPath,
        authMethodId: "test",
      });
      let startupActive = false;
      let startupCount = 0;
      const instanceId = ProviderInstanceId.make("acp-registry-fixture");
      const commandsPublished = yield* Deferred.make<{
        readonly instanceId: ProviderInstanceId;
        readonly commands: AcpRegistryAvailableCommands;
      }>();
      const configurationPublished = yield* Deferred.make<AcpRegistryLiveConfiguration>();
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings,
        environment: {
          T3_ACP_SESSION_LIFECYCLE: "1",
          T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "750",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
              withForegroundStartup: (agentId, effect) =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    assert.equal(agentId, "fixture-agent");
                    startupActive = true;
                    startupCount += 1;
                  }),
                  () => effect,
                  () =>
                    Effect.sync(() => {
                      startupActive = false;
                    }),
                ),
              runBackgroundProbe: (_agentId, effect) => effect.pipe(Effect.map(Option.some)),
              withSessionMutation: (effect) => effect,
              clearAvailableCommands: () => Effect.void,
              publishAvailableCommands: (publishedInstanceId, commands) =>
                Deferred.succeed(commandsPublished, {
                  instanceId: publishedInstanceId,
                  commands,
                }).pipe(Effect.asVoid),
              getAvailableCommands: () => Effect.succeed(Option.none()),
              watchAvailableCommands: () => Effect.never,
              clearLiveConfiguration: () => Effect.void,
              publishLiveConfiguration: (_publishedInstanceId, configuration) =>
                Deferred.succeed(configurationPublished, configuration).pipe(Effect.asVoid),
              getLiveConfiguration: () => Effect.succeed(Option.none()),
              watchLiveConfiguration: () => Effect.never,
              requestUrlAuthentication: () => Effect.succeed(false),
              acceptUrlAuthentication: () => Effect.succeed(false),
              getUrlAuthAction: () => Effect.succeed(Option.none()),
              watchUrlAuthAction: () => Effect.never,
            }),
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: (configuredSettings, cwd, environment) =>
                Effect.sync(() => assert.isTrue(startupActive)).pipe(
                  Effect.andThen(resolver.resolve(configuredSettings, cwd, environment)),
                  Effect.map((resolved) => ({
                    ...resolved,
                    spawn: {
                      ...resolved.spawn,
                      args: [mockAgentPath],
                    },
                  })),
                ),
            }),
          ),
        ),
      );
      const threadId = ThreadId.make("thread-acp-registry-fixture");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-fixture"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      assert.equal(runtime.providerSession.driver, "acpRegistry");
      assert.equal(startupCount, 1);
      assert.isFalse(startupActive);
      assert.equal(providerThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.equal(providerThread.nativeMetadata?.itemIdentityVersion, 2);
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.deepEqual(yield* Deferred.await(commandsPublished), {
        instanceId,
        commands: {
          slashCommands: [
            {
              name: "review",
              description: "Review the current changes",
              input: { hint: "focus" },
            },
          ],
          skills: [
            {
              name: "workspace-skill",
              description: "Run the workspace skill",
              path: "acp://skill/workspace-skill",
              scope: "agent",
              enabled: true,
            },
          ],
        },
      });
      const configuration = yield* Deferred.await(configurationPublished);
      assert.equal(configuration.currentModelId, "default");
      assert.deepInclude(configuration.models[0], {
        id: "default",
        name: "Auto",
        description: null,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
