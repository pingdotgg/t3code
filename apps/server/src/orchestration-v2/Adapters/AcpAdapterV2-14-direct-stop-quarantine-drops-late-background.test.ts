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
  sessionId,
} from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.live("direct Stop quarantine drops late background task mutations from the stopped run", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const capturedMutation: {
        current:
          | ((mutation: {
              readonly sessionId: string;
              readonly taskId: string;
              readonly status: "running" | "completed" | "failed";
            }) => Effect.Effect<void>)
          | null;
      } = { current: null };
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          preserveRuntimeOnSettledInterrupt: true,
          registerExtensions: (context) =>
            Effect.sync(() => {
              capturedMutation.current = context.applyBackgroundTaskMutation;
            }),
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            ownDetachedProcessGroup: true,
            protocolEvents,
          }),
        },
        selfInvocation,
        continuationRequests: { offer: () => Effect.void },
      });
      const threadId = ThreadId.make("thread-acp-stop-quarantine-late-task");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-stop-quarantine-late-task"),
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
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const applyMutation = capturedMutation.current;
      if (applyMutation === null) {
        return yield* Effect.die("registerExtensions must capture applyBackgroundTaskMutation");
      }
      yield* applyMutation({
        sessionId: "mock-session-1",
        taskId: "task-pre-stop",
        status: "running",
      });
      assert.isTrue(
        yield* hasPendingBackgroundWork,
        "a running background task mutation on the root session must track before Stop",
      );
      yield* applyMutation({
        sessionId: "mock-session-1",
        taskId: "task-pre-stop",
        status: "completed",
      });
      assert.isFalse(
        yield* hasPendingBackgroundWork,
        "a completed background task mutation must clear pending background work",
      );

      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true });
      let terminalStatus: string | null = null;
      while (terminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
          terminalStatus = event.status;
        }
      }
      assert.equal(terminalStatus, "interrupted");

      yield* applyMutation({
        sessionId: "mock-session-1",
        taskId: "task-late-after-stop",
        status: "running",
      });
      assert.isFalse(
        yield* hasPendingBackgroundWork,
        "direct Stop quarantine must drop residual background task mutations from the stopped run",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect(
    "does not pin hasPendingBackgroundWork when a late TaskOutput re-reports an in-turn-handled task",
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
        const instanceId = ProviderInstanceId.make("acp-test");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            extractBackgroundTaskId: (toolCall) =>
              toolCall.toolCallId === "tool-call-monitor-1" ? "task-monitor-1" : undefined,
            extractBackgroundTaskCompletion: (toolCall) =>
              toolCall.toolCallId === "tool-call-fetch-1"
                ? [
                    {
                      taskId: "task-monitor-1",
                      status: toolCall.status === "completed" ? "completed" : "running",
                      appendOutput: toolCall.status === "completed" ? "MONITOR_LISTING_TOKEN" : "",
                    },
                  ]
                : [],
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: {
                T3_ACP_EMIT_IN_TURN_TASKOUTPUT_THEN_LATE_DUPLICATE: "1",
              },
              protocolEvents,
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
        const threadId = ThreadId.make("thread-acp-already-handled-wake-pin");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-already-handled-wake-pin",
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
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
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

        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes("MONITOR_LISTING_TOKEN_LATE"),
          ),
          Stream.runHead,
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        assert.lengthOf(
          continuationRequests,
          0,
          "already-handled late TaskOutput must not open a continuation run",
        );
        assert.isFalse(
          yield* hasPendingBackgroundWork,
          "wake buffer must not stay non-empty and pin idle release after an already-handled re-report",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("keeps a buffered continuation current when a user turn starts before dispatch", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
        [];
      const userPromptStarted = yield* Deferred.make<void>();
      const releaseUserPrompt = yield* Deferred.make<void>();
      const bufferedAssistantText = "BUFFERED_WAKE_QUEUED_AFTER_USER";
      let promptOrdinal = 0;
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          deferFinalizeForBackgroundWork: true,
          enablePostSettleContinuation: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              prompt: (payload) =>
                Effect.gen(function* () {
                  promptOrdinal += 1;
                  const currentPromptOrdinal = promptOrdinal;
                  const result = yield* runtime.prompt(payload);
                  if (currentPromptOrdinal === 2) {
                    yield* Deferred.succeed(userPromptStarted, undefined);
                    yield* Deferred.await(releaseUserPrompt);
                  }
                  return result;
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
      const threadId = ThreadId.make("thread-acp-buffered-continuation-user-race");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(
          "provider-session-acp-buffered-continuation-user-race",
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
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const firstProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      let firstTerminalStatus: string | null = null;
      while (firstTerminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
          firstTerminalStatus = event.status;
        }
      }
      assert.equal(firstTerminalStatus, "completed");
      assert.isDefined(sessionUpdateHandler, "session update handler must be wired");

      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: bufferedAssistantText },
        },
      });
      assert.lengthOf(continuationRequests, 1);
      const continuationRequest = continuationRequests[0]!;
      assert.isDefined(continuationRequest.dispatchIfCurrent);

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 2,
          messageText: "User turn won the continuation dispatch race.",
        }),
      );
      yield* Deferred.await(userPromptStarted);
      let continuationDispatched = false;
      const dispatchOutcome = yield* continuationRequest.dispatchIfCurrent!(
        Effect.sync(() => {
          continuationDispatched = true;
        }),
      );
      assert.isTrue(
        Option.isSome(dispatchOutcome),
        "queue_after_active dispatch must remain current while the user run is active",
      );
      assert.isTrue(continuationDispatched);
      yield* Deferred.succeed(releaseUserPrompt, undefined);

      const userProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
      });
      let userTerminalStatus: string | null = null;
      while (userTerminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === userProviderTurnId) {
          userTerminalStatus = event.status;
        }
      }
      assert.equal(userTerminalStatus, "completed");
      assert.isTrue(
        yield* hasPendingBackgroundWork,
        "the queued continuation must retain ownership of its buffered wake traffic",
      );

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 3,
          messageCreatedBy: "agent",
          messageCreationSource: "provider",
          messageText: "Background task completed.",
        }),
      );
      yield* TestClock.adjust("3 seconds");
      const continuationProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:3"),
      });
      let continuationTerminalStatus: string | null = null;
      let bufferedTextSeen = false;
      while (continuationTerminalStatus === null) {
        const event = yield* Queue.take(events);
        if (
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.text.includes(bufferedAssistantText)
        ) {
          bufferedTextSeen = true;
        }
        if (event.type === "turn.terminal" && event.providerTurnId === continuationProviderTurnId) {
          continuationTerminalStatus = event.status;
        }
      }
      assert.equal(continuationTerminalStatus, "completed");
      assert.isTrue(bufferedTextSeen, "continuation must drain the wake buffer after the user run");
      assert.isFalse(yield* hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
