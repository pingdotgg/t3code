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
    "projects a child terminal in the completed-root finalization window exactly once",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const baseClock = yield* Clock.Clock;
        const finalizationClockRead = yield* Deferred.make<void>();
        const releaseFinalizationClockRead = yield* Deferred.make<void>();
        let blockNextClockRead = false;
        const blockingClock: Clock.Clock = {
          ...baseClock,
          currentTimeMillis: Effect.suspend(() => {
            if (!blockNextClockRead) return baseClock.currentTimeMillis;
            blockNextClockRead = false;
            return Deferred.succeed(finalizationClockRead, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFinalizationClockRead)),
              Effect.andThen(baseClock.currentTimeMillis),
            );
          }),
        };
        yield* Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make("acp-test");
          const firstChildSessionId = "mock-child-session-finalize-window-first";
          const secondChildSessionId = "mock-child-session-finalize-window-second";
          let firstSubagentStatus: "running" | "completed" = "running";
          let secondSubagentStatus: "waiting" | "completed" = "waiting";
          type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
          let sessionUpdateHandler:
            | Parameters<RuntimeService["handleSessionUpdate"]>[0]
            | undefined;
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
              extractSubagentUpdate: (toolCall) => {
                if (toolCall.toolCallId === "tool-call-generic-1") {
                  return {
                    nativeTaskId: "task-finalize-window-first",
                    prompt: "first background subagent",
                    title: "first background subagent",
                    model: null,
                    status: firstSubagentStatus,
                    childSessionId: firstChildSessionId,
                    result: firstSubagentStatus === "completed" ? "FIRST_DONE" : null,
                    suppressNormalTool: true,
                  };
                }
                if (toolCall.toolCallId === "tool-call-generic-2") {
                  return {
                    nativeTaskId: "task-finalize-window-second",
                    prompt: "second background subagent",
                    title: "second background subagent",
                    model: null,
                    status: secondSubagentStatus,
                    childSessionId: secondChildSessionId,
                    result: secondSubagentStatus === "completed" ? "SECOND_DONE" : null,
                    suppressNormalTool: true,
                  } as AcpAdapterV2SubagentUpdate;
                }
                return undefined;
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
            continuationRequests: { offer: () => Effect.void },
          });
          const threadId = ThreadId.make("thread-acp-subagent-finalize-window");
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          });
          const modelSelection = { instanceId, model: "default" } as const;
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(
              "provider-session-acp-subagent-finalize-window",
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
          yield* TestClock.adjust("1 second");
          assert.isDefined(sessionUpdateHandler, "session update handler must be wired");

          firstSubagentStatus = "completed";
          yield* sessionUpdateHandler!({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-call-generic-1",
              title: "first background subagent",
              kind: "other",
              status: "completed",
              rawOutput: { content: "FIRST_DONE" },
            },
          }).pipe(Effect.provideService(Clock.Clock, blockingClock));
          for (let attempt = 0; attempt < 10; attempt += 1) {
            yield* Effect.yieldNow;
          }

          yield* sessionUpdateHandler!({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-call-generic-2",
              title: "second background subagent",
              kind: "other",
              status: "in_progress",
              rawOutput: {},
            },
          });
          assert.isTrue(yield* hasPendingBackgroundWork);

          while (Option.isSome(yield* Queue.poll(events))) {}

          blockNextClockRead = true;
          const adjustFiber = yield* TestClock.adjust("3 seconds").pipe(Effect.forkScoped);
          yield* Deferred.await(finalizationClockRead);
          secondSubagentStatus = "completed";
          yield* sessionUpdateHandler!({
            sessionId: secondChildSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-call-generic-2",
              title: "second background subagent",
              kind: "other",
              status: "completed",
              rawOutput: { content: "SECOND_DONE" },
            },
          });
          yield* Deferred.succeed(releaseFinalizationClockRead, undefined);
          yield* Fiber.join(adjustFiber);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;

          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ACP_TEST_DRIVER,
            nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
          });
          let completedSubagentUpdates = 0;
          let rootTerminalStatus: string | null = null;
          let polled = yield* Queue.poll(events);
          while (Option.isSome(polled)) {
            const event = polled.value;
            if (
              event.type === "turn_item.updated" &&
              event.turnItem.type === "subagent" &&
              event.turnItem.nativeItemRef?.nativeId === "task-finalize-window-second" &&
              event.turnItem.status === "completed"
            ) {
              completedSubagentUpdates += 1;
            }
            if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
              rootTerminalStatus = event.status;
            }
            polled = yield* Queue.poll(events);
          }
          assert.equal(rootTerminalStatus, "completed");
          assert.equal(completedSubagentUpdates, 1);
          assert.isFalse(
            yield* hasPendingBackgroundWork,
            "finalize-window terminal must clear the carryover pin",
          );
        }).pipe(Effect.provideService(Clock.Clock, blockingClock));
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("projects completed-root carryover eagerly and drain cannot resurrect it", () =>
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
      const childSessionId = "019f44a6-4820-7402-925d-bc862ee711dd";
      let subagentPhase: "spawn" | "complete" = "spawn";
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          normalizeToolCall: normalizeXAiAcpToolCallState,
          extractSubagentUpdate: (toolCall) =>
            extractXAiAcpSubagentUpdate(toolCall) ??
            (toolCall.toolCallId !== "tool-call-generic-1"
              ? undefined
              : subagentPhase === "spawn"
                ? {
                    nativeTaskId: "task-generic-1",
                    prompt: "background subagent",
                    title: "background subagent",
                    model: null,
                    status: "running",
                    childSessionId,
                    result: null,
                  }
                : {
                    nativeTaskId: "task-generic-1",
                    prompt: "",
                    title: null,
                    model: null,
                    status: "completed",
                    childSessionId,
                    result: "SUB_DONE",
                  }),
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
            protocolEvents,
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
      const threadId = ThreadId.make("thread-acp-completed-root-eager-carryover");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(
          "provider-session-acp-completed-root-eager-carryover",
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
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "incoming" &&
            event.stage === "raw" &&
            typeof event.payload === "string" &&
            event.payload.includes('"stopReason"'),
        ),
        Stream.runHead,
      );
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

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
      assert.isTrue(yield* hasPendingBackgroundWork);
      assert.isDefined(sessionUpdateHandler, "session update handler must be wired");

      // Grok reports spawn ACKs as completed tools with running subagents and non-empty prompts.
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-call-generic-1",
          title: "spawn_subagent",
          kind: "other",
          status: "completed",
          rawInput: {
            description: "background subagent",
            prompt: "background subagent",
            subagent_type: "general-purpose",
          },
          rawOutput: {
            type: "Text",
            text: [
              "Subagent started in background.",
              `subagent_id: ${childSessionId}`,
              "type: general-purpose",
              "description: background subagent",
              "",
              `Use get_command_or_subagent_output with task_ids=["${childSessionId}"] and timeout_ms to wait for results.`,
            ].join("\n"),
          },
        },
      });

      subagentPhase = "complete";
      yield* sessionUpdateHandler!({
        sessionId: childSessionId,
        update: {
          sessionUpdate: "tool_call_update" as const,
          toolCallId: "tool-call-generic-1",
          title: "background subagent",
          kind: "other" as const,
          status: "completed" as const,
          rawOutput: { content: "SUB_DONE" },
        },
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      let eagerCompletedUpdates = 0;
      let eagerRunningUpdates = 0;
      let polled = yield* Queue.poll(events);
      while (Option.isSome(polled)) {
        const event = polled.value;
        if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
          if (event.turnItem.status === "completed") eagerCompletedUpdates += 1;
          if (event.turnItem.status === "running") eagerRunningUpdates += 1;
        }
        polled = yield* Queue.poll(events);
      }
      assert.equal(eagerCompletedUpdates, 1, "completed root must project before any attach");
      assert.equal(eagerRunningUpdates, 0);
      assert.lengthOf(continuationRequests, 1);
      assert.isTrue(yield* hasPendingBackgroundWork, "buffered spawn ACK still requires a drain");

      const continuationNow = yield* DateTime.now;
      const continuationInput = makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        now: continuationNow,
        ordinal: 2,
        messageCreatedBy: "agent",
        messageCreationSource: "provider",
        messageText: "Background task completed.",
      });
      yield* runtime.startTurn(continuationInput);
      yield* Effect.yieldNow;
      let replayedLineages = 0;
      let replayedSubagentUpdates = 0;
      let replayedTurnItems = 0;
      polled = yield* Queue.poll(events);
      while (Option.isSome(polled)) {
        const event = polled.value;
        if (event.type === "app_thread.created") {
          replayedLineages += 1;
        }
        if (event.type === "subagent.updated" && event.subagent.runId === continuationInput.runId) {
          replayedSubagentUpdates += 1;
        }
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.runId === continuationInput.runId
        ) {
          replayedTurnItems += 1;
        }
        polled = yield* Queue.poll(events);
      }
      assert.equal(replayedLineages, 0, "buffered spawn ACK must not create a second lineage");
      assert.equal(
        replayedSubagentUpdates,
        0,
        "buffered spawn ACK must not re-open the terminal subagent",
      );
      assert.equal(
        replayedTurnItems,
        0,
        "buffered spawn ACK must not create a continuation-owned turn item",
      );
      assert.isFalse(yield* hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
