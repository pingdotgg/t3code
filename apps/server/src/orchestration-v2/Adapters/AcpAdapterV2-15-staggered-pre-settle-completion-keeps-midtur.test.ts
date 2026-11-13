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

import { layerTest, ACP_TEST_DRIVER, makeMockRuntime, sessionId } from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.effect(
    "staggered pre-settle completion keeps midTurn marks until last background task ends post-finalize",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const promptGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
        const capturedMutation: {
          current:
            | ((mutation: {
                readonly sessionId: string;
                readonly taskId: string;
                readonly status: "running" | "completed" | "failed";
              }) => Effect.Effect<void>)
            | null;
        } = { current: null };
        const instanceId = ProviderInstanceId.make("acp-test");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            extractBackgroundTaskId: (toolCall) => {
              if (toolCall.toolCallId === "tool-call-monitor-a") return "task-monitor-a";
              if (toolCall.toolCallId === "tool-call-monitor-b") return "task-monitor-b";
              return undefined;
            },
            extractBackgroundToolMutation: (text) => {
              if (text.includes('Monitor "task-monitor-a" ended')) {
                return [{ taskId: "task-monitor-a", status: "completed", appendOutput: "" }];
              }
              if (text.includes('Monitor "task-monitor-b" ended')) {
                return [{ taskId: "task-monitor-b", status: "completed", appendOutput: "" }];
              }
              return [];
            },
            registerExtensions: (context) =>
              Effect.sync(() => {
                capturedMutation.current = context.applyBackgroundTaskMutation;
              }),
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
              protocolEvents,
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdateHandler = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: () => Deferred.await(promptGate),
              }),
            }),
          },
          selfInvocation,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
        });
        const threadId = ThreadId.make("thread-acp-staggered-midturn-keep-until-last");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-staggered-midturn-keep-until-last",
          ),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime
          .startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
          )
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.isDefined(sessionUpdateHandler);
        const applyMutation = capturedMutation.current;
        if (applyMutation === null) {
          return yield* Effect.die("registerExtensions must capture applyBackgroundTaskMutation");
        }

        for (const [toolCallId, title] of [
          ["tool-call-monitor-a", "Monitor: staggered A"],
          ["tool-call-monitor-b", "Monitor: staggered B"],
        ] as const) {
          yield* sessionUpdateHandler!({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title,
              kind: "execute",
              status: "pending",
              rawInput: {},
            },
          });
          yield* sessionUpdateHandler!({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "in_progress",
            },
          });
        }
        yield* applyMutation({
          sessionId: "mock-session-1",
          taskId: "task-monitor-a",
          status: "running",
        });
        yield* applyMutation({
          sessionId: "mock-session-1",
          taskId: "task-monitor-b",
          status: "running",
        });
        yield* applyMutation({
          sessionId: "mock-session-1",
          taskId: "task-monitor-a",
          status: "completed",
        });
        assert.lengthOf(
          continuationRequests,
          0,
          "pre-settle unhandled completion must not offer while the turn is active",
        );

        yield* Deferred.succeed(promptGate, { stopReason: "end_turn" });
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });
        let terminalStatus: string | null = null;
        while (terminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
            terminalStatus = event.status;
          }
        }
        assert.equal(terminalStatus, "completed");
        assert.lengthOf(
          continuationRequests,
          0,
          "finalize must not offer while B is still running",
        );

        const bEndNotice = {
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "user_message_chunk" as const,
            content: {
              type: "text" as const,
              text: 'Monitor "task-monitor-b" ended: [monitor ended: exit 0]',
            },
          },
        };
        assert.isFalse(
          acpPostSettleWakeEvidence(bEndNotice, {
            extractBackgroundToolMutation: (text) =>
              text.includes('Monitor "task-monitor-b" ended')
                ? [{ taskId: "task-monitor-b", status: "completed", appendOutput: "" }]
                : [],
          }),
          "mutation-only end-notice must not count as post-settle wake evidence",
        );
        yield* sessionUpdateHandler!(bEndNotice);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.lengthOf(
          continuationRequests,
          1,
          "exactly one continuation when the last running task ends post-finalize with kept midTurn marks",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect(
    "two-turn in-turn monitors never open a wake run or retain turn-1 injected-turn ack chatter",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const promptGates: Array<Deferred.Deferred<EffectAcpSchema.PromptResponse, never>> = [];
        const promptStarted = yield* Queue.unbounded<void>();
        const capturedMutation: {
          current:
            | ((mutation: {
                readonly sessionId: string;
                readonly taskId: string;
                readonly status: "running" | "completed" | "failed";
              }) => Effect.Effect<void>)
            | null;
        } = { current: null };
        const instanceId = ProviderInstanceId.make("acp-test");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            extractBackgroundTaskId: (toolCall) => {
              if (toolCall.toolCallId === "tool-call-monitor-1") return "task-monitor-1";
              if (toolCall.toolCallId === "tool-call-monitor-2") return "task-monitor-2";
              return undefined;
            },
            extractBackgroundToolMutation: (text) => {
              if (text.includes('Monitor "task-monitor-1" ended')) {
                return [{ taskId: "task-monitor-1", status: "completed", appendOutput: "" }];
              }
              if (text.includes('Monitor "task-monitor-2" ended')) {
                return [{ taskId: "task-monitor-2", status: "completed", appendOutput: "" }];
              }
              return [];
            },
            extractBackgroundTaskCompletion: (toolCall) => {
              if (toolCall.toolCallId === "tool-call-fetch-1") {
                return [
                  {
                    taskId: "task-monitor-1",
                    status: toolCall.status === "completed" ? "completed" : "running",
                    appendOutput: toolCall.status === "completed" ? "MONITOR_LISTING_TOKEN" : "",
                  },
                ];
              }
              if (toolCall.toolCallId === "tool-call-fetch-2") {
                return [
                  {
                    taskId: "task-monitor-2",
                    status: toolCall.status === "completed" ? "completed" : "running",
                    appendOutput: toolCall.status === "completed" ? "MONITOR_LISTING_TOKEN_2" : "",
                  },
                ];
              }
              return [];
            },
            registerExtensions: (context) =>
              Effect.sync(() => {
                capturedMutation.current = context.applyBackgroundTaskMutation;
              }),
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
              protocolEvents,
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdateHandler = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: () =>
                  Effect.gen(function* () {
                    const gate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
                    promptGates.push(gate);
                    yield* Queue.offer(promptStarted, undefined);
                    return yield* Deferred.await(gate);
                  }),
              }),
            }),
          },
          selfInvocation,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
        });
        const threadId = ThreadId.make("thread-acp-multiturn-in-turn-monitor-no-wake");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-multiturn-in-turn-monitor-no-wake",
          ),
          modelSelection,
          runtimePolicy,
        });
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die(
            "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
          );
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime
          .startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
          )
          .pipe(Effect.forkScoped);
        yield* Queue.take(promptStarted);
        assert.isDefined(sessionUpdateHandler, "session update handler must be wired");
        const applyMutation = capturedMutation.current;
        if (applyMutation === null) {
          return yield* Effect.die("registerExtensions must capture applyBackgroundTaskMutation");
        }

        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-call-monitor-1",
            title: "Monitor: first turn",
            kind: "execute",
            status: "pending",
            rawInput: {},
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-monitor-1",
            status: "in_progress",
          },
        });
        yield* applyMutation({
          sessionId: "mock-session-1",
          taskId: "task-monitor-1",
          status: "running",
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-call-fetch-1",
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "pending",
            rawInput: { task_id: "task-monitor-1" },
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-fetch-1",
            status: "completed",
            rawOutput: { output: "MONITOR_LISTING_TOKEN" },
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Monitor listing ready in-turn." },
          },
        });
        yield* applyMutation({
          sessionId: "mock-session-1",
          taskId: "task-monitor-1",
          status: "completed",
        });
        assert.lengthOf(continuationRequests, 0);

        yield* Deferred.succeed(promptGates[0]!, { stopReason: "end_turn" });
        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });
        let firstTerminal: string | null = null;
        while (firstTerminal === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminal = event.status;
          }
        }
        assert.equal(firstTerminal, "completed");

        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "user_message_chunk",
            content: {
              type: "text",
              text: '<monitor-event taskId="task-monitor-1">Monitor "task-monitor-1" ended</monitor-event>',
            },
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: "That monitor event is the same run I already summarized.",
            },
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "That monitor event is the same run I already summarized above.",
            },
          },
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.lengthOf(
          continuationRequests,
          0,
          "turn-1 injected-turn acks must not open a continuation",
        );
        assert.isFalse(
          yield* hasPendingBackgroundWork,
          "turn-1 injected-turn ack chatter must not remain as wake buffer evidence",
        );

        yield* runtime
          .startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now: yield* DateTime.now,
              ordinal: 2,
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Queue.take(promptStarted);
        if (sessionUpdateHandler === undefined || capturedMutation.current === null) {
          return yield* Effect.die("extensions and session handler must be wired for turn 2");
        }

        yield* sessionUpdateHandler({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-call-monitor-2",
            title: "Monitor: second turn",
            kind: "execute",
            status: "pending",
            rawInput: {},
          },
        });
        yield* sessionUpdateHandler({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-monitor-2",
            status: "in_progress",
          },
        });
        yield* capturedMutation.current({
          sessionId: "mock-session-1",
          taskId: "task-monitor-2",
          status: "running",
        });
        yield* sessionUpdateHandler({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-call-fetch-2",
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "pending",
            rawInput: { task_id: "task-monitor-2" },
          },
        });
        yield* sessionUpdateHandler({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-fetch-2",
            status: "completed",
            rawOutput: { output: "MONITOR_LISTING_TOKEN_2" },
          },
        });
        yield* sessionUpdateHandler({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Second monitor listing ready in-turn." },
          },
        });
        yield* capturedMutation.current({
          sessionId: "mock-session-1",
          taskId: "task-monitor-2",
          status: "completed",
        });
        assert.lengthOf(
          continuationRequests,
          0,
          "mid-turn task_completed for an in-turn-handled monitor must not open a wake run",
        );

        yield* Deferred.succeed(promptGates[1]!, { stopReason: "end_turn" });
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
        });
        let secondTerminal: string | null = null;
        while (secondTerminal === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminal = event.status;
          }
        }
        assert.equal(secondTerminal, "completed");
        assert.lengthOf(
          continuationRequests,
          0,
          "no continuation must be offered across the multiturn in-turn monitor sequence",
        );
        assert.isFalse(
          yield* hasPendingBackgroundWork,
          "wake buffer must not retain turn-1 or turn-2 in-turn-handled ack residue",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
