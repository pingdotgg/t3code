// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import {
  extractCopilotSubagentUpdate,
  makeCopilotSubagentRouting,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
  extractDevinSubagentUpdate,
  makeAcpRegistryAdapterV2,
} from "@t3tools/provider-acp-registry/testing";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { decodeAcpReplayTranscript, makeAcpReplayRuntime } from "./AcpAdapterV2.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DocumentText from "../../provider/DocumentText.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ProviderOptionDescriptor,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { deriveBlockedOnThreadWait } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/compat";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  ACP_EMPTY_OPTION_VALUE,
  ACP_SESSION_MODE_OPTION_ID,
  acpProviderOptionDescriptors,
} from "@t3tools/provider-acp/server/sessionConfig";
import {
  extractXAiAcpSubagentUpdate,
  makeGrokAdapterV2,
  makeXAiPromptCompletionRuntime,
  normalizeXAiAcpToolCallState,
  registerXAiBackgroundTaskTracking,
} from "@t3tools/provider-grok/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  AcpProviderCapabilitiesV2,
  acpPerTurnPromptUsage,
  acpScopedNativeId,
  acpPostSettleContinuationOfferEvidence,
  acpPostSettleWakeEvidence,
  acpToolCallDiffPatch,
  acpToolCallSnippetEdit,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
  type AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import { appendUserInputAttachmentPaths } from "../../provider/userInputAttachments.ts";
import { makeGrokAcpAdapterFlavor } from "@t3tools/provider-grok/testing";
import {
  acpRegistryPromptFailure,
  registerMistralVibeAcpExtensions,
} from "@t3tools/provider-acp-registry/testing";

import {
  layerTest,
  ACP_TEST_DRIVER,
  makeMockRuntime,
  rawProtocolMethod,
  rawProtocolRequestParam,
  rawProtocolPromptTextBlocks,
  makeInstructionCompactionHarness,
  assertReinjectedInstructions,
  sessionId,
} from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.live.each([
    { modeIds: "plain", environment: {}, planModeId: "architect", buildModeId: "ask" },
    {
      modeIds: "Copilot URL",
      environment: { T3_ACP_COPILOT_MODES: "1" },
      planModeId: "https://agentclientprotocol.com/protocol/session-modes#plan",
      buildModeId: "https://agentclientprotocol.com/protocol/session-modes#agent",
    },
    {
      // Without a `mode` category, T3 derives no mode state and only the config option switches.
      modeIds: "Copilot URL collaboration_mode",
      environment: { T3_ACP_COPILOT_MODES: "1", T3_ACP_MODE_OPTION_CATEGORY: "collaboration_mode" },
      planModeId: "https://agentclientprotocol.com/protocol/session-modes#plan",
      buildModeId: "https://agentclientprotocol.com/protocol/session-modes#agent",
    },
  ])(
    "refreshes ACP prompt instructions and native mode when the interaction mode changes ($modeIds mode ids)",
    ({ environment, planModeId, buildModeId }) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
        const instanceId = ProviderInstanceId.make("acp-test-instruction-transitions");
        const threadId = ThreadId.make("thread-acp-instruction-transitions");
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("environment-acp-instruction-transitions"),
          threadId,
          providerSessionId: "mcp-session-acp-instruction-transitions",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer instruction-transition-token",
          browserToolsAvailable: false,
        });
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              protocolEvents,
              environment,
            }),
          },
          selfInvocation,
        });
        const policy = (interactionMode: "default" | "plan") =>
          ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode,
            cwd: process.cwd(),
          });
        const defaultPolicy = policy("default");
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-instruction-transitions"),
          modelSelection,
          runtimePolicy: defaultPolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: defaultPolicy,
        });
        const now = yield* DateTime.now;
        const runTurn = Effect.fnUntraced(function* (
          ordinal: number,
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
          messageText: string,
        ) {
          yield* runtime.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now,
              ordinal,
              messageText,
            }),
          );
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runDrain,
          );
          const methods: Array<string> = [];
          const modeSets: Array<unknown> = [];
          while (true) {
            const event = yield* Queue.take(protocolEvents);
            if (event.direction !== "outgoing") continue;
            const method = rawProtocolMethod(event);
            if (method === undefined) continue;
            methods.push(method);
            if (
              method === "session/set_config_option" &&
              rawProtocolRequestParam(event, "configId") === "mode"
            ) {
              modeSets.push(rawProtocolRequestParam(event, "value"));
            }
            if (method === "session/prompt") {
              const promptBlocks = rawProtocolPromptTextBlocks(event);
              return {
                methods,
                modeSets,
                prompt: promptBlocks.map((block) => block.text).join("\n"),
                textBlockCount: promptBlocks.length,
              };
            }
          }
        });

        const command = yield* runTurn(0, defaultPolicy, "/compact");
        assert.isTrue(command.prompt.startsWith("/compact"));
        assert.notInclude(command.prompt, "<t3_code_instructions>");
        assert.equal(command.textBlockCount, 1);
        const whitespaceCommand = yield* runTurn(1, defaultPolicy, "  /repro-skill");
        assert.equal(whitespaceCommand.prompt, "  /repro-skill");
        assert.equal(whitespaceCommand.textBlockCount, 1);
        assert.notInclude(whitespaceCommand.prompt, "<t3_code_instructions>");
        const firstDefault = yield* runTurn(2, defaultPolicy, "First default request.");
        assert.equal(firstDefault.textBlockCount, 2);
        assert.include(firstDefault.prompt, "T3 Code interaction mode: Default");
        assert.include(firstDefault.prompt, "## T3 Code browser");
        assert.include(firstDefault.prompt, "T3 Code orchestration");
        assert.notInclude(
          firstDefault.methods,
          "session/set_config_option",
          "Build should preserve the agent's advertised mode default",
        );
        assert.include(
          (yield* runTurn(3, defaultPolicy, "Second default request.")).prompt,
          "Second default request.",
        );

        const planPolicy = policy("plan");
        const firstPlan = yield* runTurn(4, planPolicy, "Plan this change.");
        assert.include(firstPlan.prompt, "T3 Code interaction mode: Plan");
        assert.deepEqual(firstPlan.modeSets, [planModeId]);
        assert.include(
          (yield* runTurn(5, planPolicy, "Continue planning.")).prompt,
          "Continue planning.",
        );
        const restoredBuild = yield* runTurn(6, defaultPolicy, "Implement the change.");
        assert.include(restoredBuild.prompt, "T3 Code interaction mode: Default");
        assert.deepEqual(
          restoredBuild.modeSets,
          [buildModeId],
          "Build should restore the native mode that T3 temporarily replaced for Plan",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live(
    "reinjects ACP instructions after protocol compaction, including during reinjection",
    () =>
      Effect.gen(function* () {
        const runTurn = yield* makeInstructionCompactionHarness({
          T3_ACP_COMPACTION_PROMPT_ORDINALS: "2,4",
        });
        yield* runTurn("Start work.");
        yield* runTurn("Continue until context compacts.");
        assert.deepEqual(yield* runTurn("  /repro-skill"), [
          { type: "text", text: "  /repro-skill" },
        ]);
        assertReinjectedInstructions(
          yield* runTurn("Continue after compaction."),
          "Continue after compaction.",
        );
        assertReinjectedInstructions(
          yield* runTurn("Continue after the second compaction."),
          "Continue after the second compaction.",
        );
        assert.equal((yield* runTurn("Finish work."))[0]?.text, "Finish work.");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live(
    "reinjects ACP instructions after successful native compact, but not failed compact",
    () =>
      Effect.gen(function* () {
        const runTurn = yield* makeInstructionCompactionHarness({
          T3_ACP_FAIL_PROMPT_ORDINAL: "2",
        });
        yield* runTurn("Start work.");
        assert.deepEqual(yield* runTurn("/compact", "failed"), [
          { type: "text", text: "/compact" },
        ]);
        assert.equal(
          (yield* runTurn("Continue after failure."))[0]?.text,
          "Continue after failure.",
        );
        assert.deepEqual(yield* runTurn("/compact"), [{ type: "text", text: "/compact" }]);
        assert.deepEqual(yield* runTurn("/repro-skill"), [{ type: "text", text: "/repro-skill" }]);
        assertReinjectedInstructions(yield* runTurn("Continue work."), "Continue work.");
        assert.equal((yield* runTurn("Finish work."))[0]?.text, "Finish work.");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("reapplies a selection after a switch away from it failed partway", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-partial-selection-reapply");
      const threadId = ThreadId.make("thread-acp-partial-selection-reapply");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            environment: { T3_ACP_FAIL_SET_MODE_CONFIG_OPTION: "1" },
          }),
        },
        selfInvocation: yield* resolveSelfInvocation(),
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const selectionA = { instanceId, model: "composer-2" } as const;
      const selectionB = {
        instanceId,
        model: "composer-2[fast=true]",
        options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: "code" }],
      } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-partial-selection"),
        modelSelection: selectionA,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: selectionA,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const turnInput = (ordinal: number, modelSelection: ModelSelection) =>
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now,
          ordinal,
          modelSelection,
        });

      const switchToB = yield* Effect.exit(runtime.startTurn(turnInput(1, selectionB)));
      assert.isTrue(Exit.isFailure(switchToB), "the agent rejected B's mode step");
      yield* Queue.clear(protocolEvents);

      yield* runtime.startTurn(turnInput(2, selectionA));
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      const modelSetsBeforePrompt: Array<unknown> = [];
      while (true) {
        const event = yield* Queue.take(protocolEvents);
        if (event.direction !== "outgoing") continue;
        const method = rawProtocolMethod(event);
        if (method === "session/prompt") break;
        if (
          method === "session/set_config_option" &&
          rawProtocolRequestParam(event, "configId") === "model"
        ) {
          modelSetsBeforePrompt.push(rawProtocolRequestParam(event, "value"));
        }
      }
      assert.deepEqual(
        modelSetsBeforePrompt,
        ["composer-2"],
        "the native model was left on B, so the turn on A must set it back first",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // regression: #21499 turns blocked only on T3 thread waits must show as waiting
  it.effect.each(["agent_message_chunk"] as const)(
    "keeps named ACP %s open while deriving thread wait execution state",
    (sessionUpdate) =>
      Effect.gen(function* () {
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let handler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const instanceId = ProviderInstanceId.make("acp-named-stream-wait");
        const path = yield* Path.Path;
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: makeMockRuntime({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              mockAgentPath: yield* path.fromFileUrl(
                new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
              ),
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (next) =>
                  Effect.sync(() => {
                    handler = next;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
                prompt: () =>
                  Effect.gen(function* () {
                    assert.isDefined(handler);
                    const updates = [
                      {
                        sessionUpdate,
                        messageId: "named-stream",
                        content: { type: "text", text: "Waiting for the child result" },
                      },
                      {
                        sessionUpdate: "tool_call",
                        toolCallId: "wait",
                        title: "Wait for the child",
                        status: "in_progress",
                        rawInput: {
                          server: "t3-code",
                          tool: "t3_thread_wait",
                          arguments: { threadId: "child" },
                        },
                        _meta: { is_mcp_tool_call: true },
                      },
                      {
                        sessionUpdate: "tool_call",
                        toolCallId: "command",
                        kind: "execute",
                        title: "Run command",
                        status: "in_progress",
                        rawInput: { command: "pwd" },
                      },
                      {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "command",
                        status: "completed",
                      },
                      {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "wait",
                        status: "completed",
                      },
                    ] satisfies Array<EffectAcpSchema.SessionUpdate>;
                    for (const update of updates)
                      yield* handler!({ sessionId: "mock-session-1", update });
                    return { stopReason: "end_turn" as const };
                  }),
              }),
            }),
          },
        });
        const threadId = ThreadId.make("thread-acp-named-stream-wait");
        const modelSelection = { instanceId, model: "default" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("session-acp-named-stream-wait"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        });
        yield* runtime.startTurn(input);
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const retained = new Map<string, OrchestrationV2TurnItem>();
        const states: Array<boolean> = [];
        for (const event of events) {
          if (event.type !== "turn_item.updated") continue;
          const item = event.turnItem;
          retained.set(item.id, item);
          if (item.type !== "dynamic_tool" && item.type !== "command_execution") continue;
          const streams = [...retained.values()].filter(
            (entry) => entry.type === "assistant_message" || entry.type === "reasoning",
          );
          assert.deepEqual(
            streams.map((entry) => [entry.type, entry.status]),
            [
              [
                sessionUpdate === "agent_message_chunk" ? "assistant_message" : "reasoning",
                "running",
              ],
            ],
          );
          states.push(
            deriveBlockedOnThreadWait({
              activeRun: { id: input.runId, status: "running" },
              turnItems: [...retained.values()],
            }),
          );
        }
        assert.deepEqual(states, [true, false, true, false]);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("starts a new replay message after ACP v2 plan boundaries", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("acp-test-v2-plan-replay-boundary");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            }),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-v2-plan-replay-boundary");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-v2-plan-replay-boundary"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      assert.isDefined(sessionUpdateHandler);

      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "before plan" },
        },
      });
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: "plan-1",
            entries: [{ content: "Continue", priority: "medium", status: "in_progress" }],
          },
        },
      });
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "after plan" },
        },
      });

      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.deepEqual(
        snapshot.messages.map((message) => message.text),
        ["before plan", "after plan"],
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
