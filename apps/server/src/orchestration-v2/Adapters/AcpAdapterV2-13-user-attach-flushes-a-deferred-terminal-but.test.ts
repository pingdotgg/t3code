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
  it.effect(
    "user attach flushes a deferred terminal but leaves wake traffic for its continuation",
    () =>
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
        const bufferedAssistantText = "BUFFERED_WAKE_AFTER_USER_ATTACH";
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const promptSettled = yield* Deferred.make<void>();
        const adapter = yield* makeAcpAdapterV2({
          testHooks: {
            afterPromptSettledWithBackgroundWork: () =>
              Deferred.succeed(promptSettled, undefined).pipe(Effect.asVoid),
          },
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            enablePostSettleContinuation: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
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
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
        });
        const threadId = ThreadId.make("thread-acp-carryover-root-session-continuation");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-carryover-root-session-continuation",
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
        yield* Deferred.await(promptSettled);

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });
        yield* runtime.interruptTurn({ providerThread, providerTurnId: firstProviderTurnId });

        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.isTrue(
          yield* hasPendingBackgroundWork,
          "carryover live subagent must pin hasPendingBackgroundWork after root settle",
        );
        const refusedReplacement = yield* runtime
          .ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
            forceNewNativeThread: true,
          })
          .pipe(Effect.flip);
        assert.equal(refusedReplacement._tag, "ProviderAdapterEnsureThreadError");
        const preserved = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        assert.equal(preserved.nativeThreadRef?.nativeId, providerThread.nativeThreadRef?.nativeId);
        assert.isTrue(yield* hasPendingBackgroundWork);
        assert.isDefined(sessionUpdateHandler, "session update handler must be wired");

        subagentPhase = "complete";
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-generic-1",
            title: "background subagent",
            kind: "other",
            status: "completed",
            rawOutput: { content: "SUB_DONE" },
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: bufferedAssistantText },
          },
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        let completedBeforeDrain = 0;
        let polled = yield* Queue.poll(events);
        while (Option.isSome(polled)) {
          const event = polled.value;
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.status === "completed"
          ) {
            completedBeforeDrain += 1;
          }
          polled = yield* Queue.poll(events);
        }
        assert.equal(
          completedBeforeDrain,
          0,
          "interrupted root-session terminal must wait for an observable attach",
        );
        assert.lengthOf(
          continuationRequests,
          1,
          "root-session post-settle subagent terminal must offer a continuation",
        );
        assert.isTrue(
          yield* hasPendingBackgroundWork,
          "interrupted unprojected terminal must pin hasPendingBackgroundWork until attach",
        );

        const userTurnNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: userTurnNow,
            ordinal: 2,
            messageText: "What finished while the prior turn was settling?",
          }),
        );
        yield* TestClock.adjust("3 seconds");
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const userProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
        });
        let userTurnTerminal: string | null = null;
        let completedSubagentTurnItems = 0;
        let bufferedTextSeenInUserTurn = false;
        while (userTurnTerminal === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.status === "completed"
          ) {
            completedSubagentTurnItems += 1;
          }
          if (
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.text.includes(bufferedAssistantText)
          ) {
            bufferedTextSeenInUserTurn = true;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === userProviderTurnId) {
            userTurnTerminal = event.status;
          }
        }
        assert.equal(userTurnTerminal, "completed");
        assert.equal(
          completedSubagentTurnItems,
          1,
          "user attach must project the deferred terminal subagent turn item once",
        );
        assert.isFalse(bufferedTextSeenInUserTurn, "user attach must not drain wake traffic");
        assert.isTrue(
          yield* hasPendingBackgroundWork,
          "wake traffic must remain pinned for the already-dispatched continuation",
        );

        const continuationNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: continuationNow,
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
        let continuationTerminal: string | null = null;
        let bufferedTextSeenInContinuation = false;
        while (continuationTerminal === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.text.includes(bufferedAssistantText)
          ) {
            bufferedTextSeenInContinuation = true;
          }
          if (
            event.type === "turn.terminal" &&
            event.providerTurnId === continuationProviderTurnId
          ) {
            continuationTerminal = event.status;
          }
        }
        assert.equal(continuationTerminal, "completed");
        assert.isTrue(
          bufferedTextSeenInContinuation,
          "queued continuation must drain the wake content after the user run",
        );
        assert.isFalse(yield* hasPendingBackgroundWork);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect(
    "preserveRuntimeOnSettledInterrupt keeps the process alive and carries subagents through a settled steering interrupt",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        let cancelCalled = false;
        let runtimeOrdinalSeen = 0;
        const promptSettled = yield* Deferred.make<void>();
        const adapter = yield* makeAcpAdapterV2({
          testHooks: {
            afterPromptSettledWithBackgroundWork: () =>
              Deferred.succeed(promptSettled, undefined).pipe(Effect.asVoid),
          },
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            restartRuntimeAfterInterrupt: true,
            restartRuntimeOnEveryInterrupt: true,
            terminateRuntimeProcessGroupOnInterrupt: true,
            preserveRuntimeOnSettledInterrupt: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: (runtimeOrdinal) => {
                runtimeOrdinalSeen = Math.max(runtimeOrdinalSeen, runtimeOrdinal);
                return { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" };
              },
              wrapCancel: (cancel) =>
                Effect.sync(() => {
                  cancelCalled = true;
                }).pipe(Effect.andThen(cancel)),
            }),
          },
          selfInvocation,
        });
        const threadId = ThreadId.make("thread-acp-settled-soft-steer");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-settled-soft-steer"),
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
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        yield* Deferred.await(promptSettled);

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });
        yield* runtime.interruptTurn({ providerThread, providerTurnId: firstProviderTurnId });
        assert.isFalse(
          cancelCalled,
          "settled soft steer must not send session/cancel (the real Grok CLI kills background subagents on cancel)",
        );

        let subagentTurnItemId: string | null = null;
        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
            subagentTurnItemId = event.turnItem.id;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.notEqual(subagentTurnItemId, null);

        subagentPhase = "complete";
        const secondNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: secondNow,
            ordinal: 2,
          }),
        );
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
        });
        let carriedItemStatus: string | null = null;
        let secondTerminalStatus: string | null = null;
        while (secondTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.id === subagentTurnItemId
          ) {
            carriedItemStatus = event.turnItem.status;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminalStatus = event.status;
          }
        }
        assert.equal(carriedItemStatus, "completed");
        assert.equal(secondTerminalStatus, "completed");
        assert.equal(
          runtimeOrdinalSeen,
          1,
          "settled soft steer must not respawn the ACP runtime process",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("preserveRuntimeOnSettledInterrupt does not soften a mid-prompt steering interrupt", () =>
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
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          restartRuntimeOnEveryInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          preserveRuntimeOnSettledInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-unsettled-steer-stays-hard");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(
          "provider-session-acp-unsettled-steer-stays-hard",
        ),
        modelSelection,
        runtimePolicy,
      });
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
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      const interruptExit = yield* runtime
        .interruptTurn({ providerThread, providerTurnId })
        .pipe(Effect.exit);
      if (Exit.isSuccess(interruptExit)) {
        assert.fail("mid-prompt steering interrupt must still take the hard teardown path");
      }
      assert.include(Cause.pretty(interruptExit.cause), "session is poisoned");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
