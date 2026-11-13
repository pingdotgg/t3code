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
  DEFAULT_GROK_SETTINGS,
  layerTest,
  ACP_TEST_DRIVER,
  makeMockRuntime,
  rawProtocolMethod,
  pollProtocolMethods,
  sessionId,
} from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.effect("a wake names work that ended while the previous wake was queued", () =>
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
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      let applyMutation: AcpAdapterV2ExtensionContext["applyBackgroundTaskMutation"] | undefined;
      const promptGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          deferFinalizeForBackgroundWork: true,
          registerExtensions: (context) =>
            Effect.sync(() => {
              applyMutation = context.applyBackgroundTaskMutation;
            }),
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
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
      const threadId = ThreadId.make("thread-acp-wake-report-while-queued");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-wake-report-while-queued"),
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
      const awaitTerminal = (ordinal: number) =>
        Effect.gen(function* () {
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ACP_TEST_DRIVER,
            nativeTurnId: acpScopedNativeId(instanceId, `mock-session-1:turn:${ordinal}`),
          });
          while (true) {
            const event = yield* Queue.take(events);
            if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
              return event.status;
            }
          }
        });
      yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(promptGate, { stopReason: "end_turn" });
      assert.equal(yield* awaitTerminal(1), "completed");
      if (applyMutation === undefined || sessionUpdateHandler === undefined) {
        return yield* Effect.die("extensions and session handler must be wired");
      }
      const endCommand = (taskId: string, label: string) =>
        applyMutation!({
          sessionId: "mock-session-1",
          taskId,
          status: "completed",
          report: { kind: "command", label },
        });
      const agentText = (text: string) =>
        sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });

      yield* endCommand("task-a", "sleep a");
      yield* agentText("A_DONE");
      assert.lengthOf(continuationRequests, 1);
      assert.equal(continuationRequests[0]?.notification?.summary, 'Command "sleep a" finished');
      yield* endCommand("task-b", "sleep b");
      assert.lengthOf(continuationRequests, 1);

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 2,
          messageCreatedBy: "agent",
          messageCreationSource: "provider",
          messageText: "Background task completed.",
        }),
      );
      yield* TestClock.adjust("3 seconds");
      assert.equal(yield* awaitTerminal(2), "completed");

      yield* agentText("B_DONE");
      assert.lengthOf(continuationRequests, 2);
      assert.deepEqual(continuationRequests[1]?.notification, {
        source: { kind: "command" },
        outcome: "completed",
        summary: 'Command "sleep b" finished',
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect.each([
    { status: "completed" as const, exitCode: 0 },
    { status: "failed" as const, exitCode: 1 },
  ])(
    "retains early Grok $status command completion across sparse notifications and replayed ACKs",
    ({ status, exitCode }) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        let taskCompleted:
          | ((payload: unknown) => Effect.Effect<void, EffectAcpErrors.AcpError>)
          | undefined;
        const promptStarted = yield* Deferred.make<void>();
        const promptGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
        const promptHeld = yield* Deferred.make<void>();
        const finalizeScheduled = yield* Deferred.make<Duration.Input>();
        const continuationOffered = yield* Deferred.make<void>();
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        const instanceId = ProviderInstanceId.make("acp-test");
        const grokFlavor = makeGrokAcpAdapterFlavor(
          {
            instanceId,
            settings: DEFAULT_GROK_SETTINGS,
            environment: {},
            hostPlatform: yield* HostProcess.Platform,
            selfInvocation,
          },
          yield* HostProcess.HomeDirectory,
        );
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation,
          testHooks: {
            afterPromptSettledWithBackgroundWork: () =>
              Deferred.succeed(promptHeld, undefined).pipe(Effect.asVoid),
            onDeferredFinalizeScheduled: (debounce) =>
              Deferred.succeed(finalizeScheduled, debounce).pipe(Effect.asVoid),
          },
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            deferFinalizeForBackgroundWork: true,
            normalizeToolCall: grokFlavor.normalizeToolCall!,
            extractBackgroundTaskId: grokFlavor.extractBackgroundTaskId!,
            isBackgroundCommandTool: grokFlavor.isBackgroundCommandTool!,
            registerExtensions: ({ runtime, applyBackgroundTaskMutation }) =>
              registerXAiBackgroundTaskTracking(runtime, applyBackgroundTaskMutation),
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdateHandler = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                handleExtNotification: (method, schema, handler) =>
                  Effect.sync(() => {
                    if (method === "x.ai/task_completed") {
                      taskCompleted = (payload) =>
                        handler(Schema.decodeUnknownSync(schema)(payload));
                    }
                  }).pipe(Effect.andThen(runtime.handleExtNotification(method, schema, handler))),
                prompt: () =>
                  Deferred.succeed(promptStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(promptGate)),
                  ),
              }),
            }),
          },
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => continuationRequests.push(request)).pipe(
                Effect.andThen(Deferred.succeed(continuationOffered, undefined)),
                Effect.asVoid,
              ),
          },
        });
        const threadId = ThreadId.make("thread-acp-early-command");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-early-command"),
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
        yield* Deferred.await(promptStarted);
        assert.isDefined(sessionUpdateHandler);
        assert.isDefined(taskCompleted);
        const update = (update: EffectAcpSchema.SessionUpdate) =>
          sessionUpdateHandler!({ sessionId: "mock-session-1", update });
        const complete = (taskId: string, snapshot?: { output?: string; exit_code?: number }) =>
          taskCompleted!({
            sessionId: "mock-session-1",
            update: { sessionUpdate: "task_completed", task_id: taskId, task_snapshot: snapshot },
          });
        for (const taskId of ["early", "blocker"]) {
          yield* update({
            sessionUpdate: "tool_call",
            toolCallId: taskId,
            title: `Run ${taskId}`,
            kind: "execute",
            status: "completed",
            rawInput: { command: `echo ${taskId}` },
            rawOutput: { type: "BackgroundTaskStarted", task_id: taskId },
          });
        }
        // Progress removes the ACK carrying the task identity before a reportless completion.
        yield* update({
          sessionUpdate: "tool_call_update",
          toolCallId: "early",
          status: "in_progress",
          rawOutput: { type: "Text", text: "Command progress" },
        });
        yield* complete("early", { exit_code: exitCode, output: "EARLY_BG_DONE\n" });
        // The real decoder treats this exit-code-free duplicate as completed, even after failure.
        yield* complete("early");
        assert.lengthOf(continuationRequests, 0);

        let backgroundItem: ProviderAdapter.ProviderAdapterV2Event | undefined;
        let checkpoint = 0;
        const assertCommand = Effect.fnUntraced(function* (expectedStatus: string, output: string) {
          const title = `Checkpoint ${++checkpoint}`;
          // A later tool event fences the emitted updates without waiting for a terminal that may never come.
          yield* update({ sessionUpdate: "tool_call_update", toolCallId: "blocker", title });
          while (true) {
            const event = yield* Queue.take(events);
            if (event.type !== "turn_item.updated") continue;
            if (event.turnItem.nativeItemRef?.nativeId === "early") backgroundItem = event;
            if (
              event.turnItem.nativeItemRef?.nativeId === "blocker" &&
              event.turnItem.title === title
            )
              break;
          }
          assert.equal(backgroundItem?.type, "turn_item.updated");
          if (backgroundItem?.type !== "turn_item.updated") return;
          assert.equal(backgroundItem.turnItem.status, expectedStatus);
          assert.equal(backgroundItem.turnItem.type, "command_execution");
          if (backgroundItem.turnItem.type === "command_execution") {
            assert.equal(backgroundItem.turnItem.output ?? "", output);
          }
        });
        yield* Deferred.succeed(promptGate, { stopReason: "end_turn" });
        yield* Deferred.await(promptHeld);
        yield* assertCommand(status, "EARLY_BG_DONE\n");
        assert.lengthOf(continuationRequests, 0, "the other command still holds the root open");

        const replayAck = () =>
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "early",
            status: "completed",
            rawOutput: { type: "BackgroundTaskStarted", task_id: "early" },
          });
        yield* replayAck();
        yield* assertCommand(status, "EARLY_BG_DONE\n");
        // Sparse ACP updates must retain the command result after projection replaces the ACK.
        for (const sparseStatus of ["completed", "in_progress"] as const) {
          yield* update({
            sessionUpdate: "tool_call_update",
            toolCallId: "early",
            status: sparseStatus,
          });
          yield* assertCommand(status, "EARLY_BG_DONE\n");
        }
        if (status === "completed") {
          for (const output of ["", "UPDATED_OUTPUT\n"]) {
            yield* complete("early", { output });
            yield* replayAck();
            yield* assertCommand(status, output);
          }
        }
        yield* complete("blocker", { exit_code: 0, output: "BLOCKER_DONE\n" });
        yield* TestClock.adjust(yield* Deferred.await(finalizeScheduled));
        while (true) {
          const event = yield* Queue.take(events);
          if (event.type !== "turn.terminal") continue;
          assert.equal(event.status, "completed");
          break;
        }
        yield* Deferred.await(continuationOffered);
        yield* complete("early");
        yield* complete("blocker");
        assert.lengthOf(
          continuationRequests,
          1,
          "duplicate completions must not offer another continuation",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("durably poisons start and resume when required hard teardown is unavailable", () =>
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
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-missing-hard-teardown");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-missing-hard-teardown"),
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
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.exit);
      if (Exit.isSuccess(interruptExit)) assert.fail("missing hard teardown must fail interrupt");
      assert.include(Cause.pretty(interruptExit.cause), "session is poisoned");

      const startExit = yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.exit);
      if (Exit.isSuccess(startExit)) assert.fail("poisoned session must reject startTurn");
      assert.include(Cause.pretty(startExit.cause), "session is poisoned");
      const resumeExit = yield* runtime
        .resumeThread({ providerThread, modelSelection, runtimePolicy })
        .pipe(Effect.exit);
      if (Exit.isSuccess(resumeExit)) assert.fail("poisoned session must reject resumeThread");
      assert.include(Cause.pretty(resumeExit.cause), "session is poisoned");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("holds concurrent startTurn behind successful hard teardown and reloads once", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const teardownStarted = yield* Deferred.make<void>();
      const releaseTeardown = yield* Deferred.make<void>();
      let runtimeOrdinalSeen = 0;
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: () =>
              Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTeardown)),
              ),
            environment: (runtimeOrdinal) => {
              runtimeOrdinalSeen = runtimeOrdinal;
              return runtimeOrdinal === 1 ? { T3_ACP_HANG_PROMPT_FOREVER: "1" } : {};
            },
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-concurrent-hard-teardown");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-concurrent-hard-teardown"),
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
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* pollProtocolMethods(protocolEvents);
      const interruptFiber = yield* runtime
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(teardownStarted);
      const startFiber = yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isUndefined(startFiber.pollUnsafe());
      assert.equal(runtimeOrdinalSeen, 1);
      const methodsDuringTeardown = yield* pollProtocolMethods(protocolEvents);
      assert.notInclude(methodsDuringTeardown, "session/resume");
      assert.notInclude(methodsDuringTeardown, "session/prompt");

      yield* Deferred.succeed(releaseTeardown, undefined);
      yield* Fiber.join(interruptFiber);
      yield* Fiber.join(startFiber);
      assert.equal(runtimeOrdinalSeen, 2);
      const replacementMethods = yield* pollProtocolMethods(protocolEvents);
      assert.equal(replacementMethods.filter((method) => method === "session/resume").length, 1);
      if (!replacementMethods.includes("session/prompt")) {
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
          ),
          Stream.runHead,
        );
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("lets a caller abandon Stop while hard teardown stalls, and finishes the teardown", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const teardownStarted = yield* Deferred.make<void>();
      const releaseTeardown = yield* Deferred.make<void>();
      let runtimeOrdinalSeen = 0;
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: () =>
              Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTeardown)),
              ),
            environment: (runtimeOrdinal) => {
              runtimeOrdinalSeen = runtimeOrdinal;
              return runtimeOrdinal === 1 ? { T3_ACP_HANG_PROMPT_FOREVER: "1" } : {};
            },
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-abandoned-hard-teardown");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-abandoned-hard-teardown"),
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
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* pollProtocolMethods(protocolEvents);
      const interruptFiber = yield* runtime
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(teardownStarted);

      // The session manager's Stop timeout interrupts this call; it must not wait for teardown.
      yield* Fiber.interrupt(interruptFiber);

      const startFiber = yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseTeardown, undefined);
      yield* Fiber.join(startFiber);
      assert.equal(runtimeOrdinalSeen, 2);
      const replacementMethods = yield* pollProtocolMethods(protocolEvents);
      assert.equal(replacementMethods.filter((method) => method === "session/resume").length, 1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
