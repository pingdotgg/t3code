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
} from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.live("auto-approves tagged MCP elicitations under full-access policy", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("acp-test-mcp-approval-elicitation");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_MCP_TOOL_APPROVAL_ELICITATION: "1" },
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-mcp-approval-elicitation");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-mcp-approval-elicitation"),
        modelSelection,
        runtimePolicy,
      });
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
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );

      assert.isFalse(events.some((event) => event.type === "runtime_request.updated"));
      assert.isTrue(events.some((event) => event.type === "turn.terminal"));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("fails a held native response acknowledgement before normal session close", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseWritten = yield* Deferred.make<void>();
      const releaseResponseAcknowledgement = yield* Deferred.make<void>();
      const responseLifecycle: Array<string> = [];
      const responseFailed = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test-normal-close-held-response");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
            wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
              Deferred.succeed(responseWritten, undefined).pipe(
                Effect.andThen(Deferred.await(releaseResponseAcknowledgement)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        selfInvocation,
        testHooks: {
          onNativeResponseLifecycle: (event) =>
            Effect.sync(() => {
              responseLifecycle.push(event.type);
              if (event.type === "failed") Deferred.doneUnsafe(responseFailed, Effect.void);
            }),
        },
      });
      const threadId = ThreadId.make("thread-acp-normal-close-held-response");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const sessionScope = yield* Scope.make();
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-normal-close-held-response",
          ),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
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
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (pending.type !== "runtime_request.updated") {
        return yield* Effect.die("Expected a pending permission request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(responseWritten);

      const closeFiber = yield* Scope.close(sessionScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(responseFailed);
      const responseExit = yield* Fiber.join(responseFiber);
      if (Exit.isSuccess(responseExit)) {
        assert.fail("normal close must fail a response whose transport acknowledgement is held");
      }
      assert.include(Cause.pretty(responseExit.cause), "ACP session transport closed");
      assert.include(responseLifecycle, "removed");
      assert.include(responseLifecycle, "failed");
      yield* Deferred.succeed(releaseResponseAcknowledgement, undefined);
      yield* Fiber.join(closeFiber);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("treats a second hard Stop as success when the turn is already gone", () =>
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
          interruptPromptOnCancel: false,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-double-stop");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-double-stop"),
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
        .startTurn(makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }))
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
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId,
        requestRuntimeRestart: true,
      });
      const second = yield* Effect.exit(
        runtime.interruptTurn({
          providerThread,
          providerTurnId,
          requestRuntimeRestart: true,
        }),
      );
      assert.isTrue(Exit.isSuccess(second), "duplicate hard Stop must be idempotent");
      let terminal: string | null = null;
      while (terminal === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
          terminal = event.status;
        }
      }
      assert.equal(terminal, "interrupted");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("finalizes a settled turn held open for background work when interrupted", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("acp-test");
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
          extractSubagentUpdate: (toolCall) =>
            toolCall.toolCallId === "tool-call-generic-1"
              ? {
                  nativeTaskId: "task-generic-1",
                  prompt: "background subagent",
                  title: "background subagent",
                  model: null,
                  status: "running",
                  childSessionId: null,
                  result: null,
                }
              : undefined,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-interrupt-background-hold");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-interrupt-background"),
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

      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId });

      let terminalStatus: string | null = null;
      while (terminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
          terminalStatus = event.status;
        }
      }
      assert.equal(terminalStatus, "interrupted");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect(
    "carries a live subagent lineage across an interrupt so the next turn can complete it",
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
            }),
          },
          selfInvocation,
        });
        const threadId = ThreadId.make("thread-acp-subagent-carryover");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-subagent-carryover"),
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
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
