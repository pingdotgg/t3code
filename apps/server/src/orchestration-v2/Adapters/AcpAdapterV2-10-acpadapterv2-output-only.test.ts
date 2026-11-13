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
  rawProtocolRequestParam,
} from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.live.each([
    { shape: "output_only", expectedCommand: { type: "command_execution", status: "completed" } },
    { shape: "variant_only", expectedCommand: { type: "command_execution", status: "completed" } },
    { shape: "killed", expectedCommand: { type: "command_execution", status: "completed" } },
    {
      shape: "already_exited",
      expectedCommand: { type: "command_execution", status: "completed" },
    },
    {
      shape: "known_failure",
      expectedCommand: { type: "command_execution", status: "failed", output: "known failure\n" },
    },
  ] as const)(
    "completes a Grok KillTask command ($shape) and preserves any known result",
    ({ shape, expectedCommand }) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("grok-kill-completion");
        const adapter = yield* makeGrokAdapterV2({
          instanceId,
          settings: DEFAULT_GROK_SETTINGS,
          environment: {},
          hostPlatform: yield* HostProcess.Platform,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_GROK_KILL_TASK_SHAPE: shape },
            })(input).pipe(Effect.flatMap(makeXAiPromptCompletionRuntime)),
        });
        const threadId = ThreadId.make("grok-kill-completion");
        const modelSelection = { instanceId, model: "default" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("grok-kill-completion"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        );
        const observed = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const allEvents = [...observed];
        let next = yield* Queue.poll(events);
        while (Option.isSome(next)) {
          allEvents.push(next.value);
          next = yield* Queue.poll(events);
        }
        const terminals = allEvents.filter((event) => event.type === "turn.terminal");
        assert.deepEqual(
          terminals.map((event) => event.status),
          ["completed"],
        );
        const items = allEvents.flatMap((event) =>
          event.type === "turn_item.updated" ? [event.turnItem] : [],
        );
        assert.isFalse(items.some((item) => item.type === "subagent"));
        const command = items.findLast(
          (item) => item.nativeItemRef?.nativeId === "kill-target-command",
        );
        assert.deepInclude(command, expectedCommand);
        assert.isTrue(
          items.some((item) => item.nativeItemRef?.nativeId === "kill-command"),
          "KillTask must retain its normal tool frame",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("keeps an agent's empty-valued default choice selectable", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      let agentDescriptor: ProviderOptionDescriptor | undefined;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_EMPTY_DEFAULT_AGENT_OPTION: "1" },
            protocolEvents,
          }),
          onSessionConfigurationUpdate: (configOptions, modeState) =>
            Effect.sync(() => {
              agentDescriptor = acpProviderOptionDescriptors({ configOptions, modeState }).find(
                (descriptor) => descriptor.id === "agent",
              );
            }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-empty-default-agent");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const customAgentSelection = {
        instanceId,
        model: "default",
        options: [{ id: "agent", value: "example" }],
      } satisfies ModelSelection;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-empty-default-agent"),
        modelSelection: customAgentSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: customAgentSelection,
        runtimePolicy,
      });
      assert.deepEqual(agentDescriptor, {
        id: "agent",
        label: "Agent",
        type: "select",
        options: [
          { id: ACP_EMPTY_OPTION_VALUE, label: "Copilot" },
          { id: "example", label: "example" },
        ],
        currentValue: "example",
      });

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          modelSelection: {
            instanceId,
            model: "default",
            options: [{ id: "agent", value: ACP_EMPTY_OPTION_VALUE }],
          },
          now: yield* DateTime.now,
        }),
      );
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );

      assert.equal(
        agentDescriptor?.type === "select" ? agentDescriptor.currentValue : undefined,
        ACP_EMPTY_OPTION_VALUE,
      );
      const sentAgentValues = Array.from(yield* Queue.takeAll(protocolEvents))
        .filter(
          (event) =>
            event.direction === "outgoing" &&
            rawProtocolMethod(event) === "session/set_config_option" &&
            rawProtocolRequestParam(event, "configId") === "agent",
        )
        .map((event) => rawProtocolRequestParam(event, "value"));
      assert.deepEqual(sentAgentValues, ["example", ""]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("terminalizes an empty successful foreground Bash tool when the turn completes", () =>
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
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: (runtimeOrdinal) =>
              runtimeOrdinal === 1 ? { T3_ACP_EMIT_EMPTY_SUCCESSFUL_BASH_THEN_HANG: "1" } : {},
            ownDetachedProcessGroup: true,
            protocolEvents,
          }),
          normalizeToolCall: normalizeXAiAcpToolCallState,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-empty-successful-bash");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-empty-successful-bash"),
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

      const statuses: string[] = [];
      let runningStartedAt: DateTime.Utc | null = null;
      let completedStartedAt: DateTime.Utc | null = null;
      let completedAt: DateTime.Utc | null = null;
      let completedInput: string | null = null;
      let completedOutput: string | null | undefined;
      let completedExitCode: number | null | undefined;
      let runningProjectedExitCode: number | undefined = undefined;
      let terminal = false;
      while (!terminal) {
        const event = yield* Queue.take(events);
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "tool-call-empty-success-1"
        ) {
          statuses.push(event.turnItem.status);
          if (event.turnItem.status === "running") {
            runningStartedAt ??= event.turnItem.startedAt;
            if (event.turnItem.type === "command_execution") {
              runningProjectedExitCode = event.turnItem.exitCode;
            }
          }
          if (event.turnItem.status === "completed") {
            completedStartedAt = event.turnItem.startedAt;
            completedAt = event.turnItem.completedAt;
            if (event.turnItem.type === "command_execution") {
              completedInput = event.turnItem.input;
              completedOutput = event.turnItem.output;
              completedExitCode = event.turnItem.exitCode;
            }
          }
        }
        if (event.type === "turn.terminal") terminal = true;
      }

      assert.deepEqual(statuses, ["running", "running", "completed"]);
      assert.deepEqual(completedStartedAt, runningStartedAt);
      assert.isNotNull(completedAt);
      assert.equal(completedInput, "true");
      assert.equal(completedOutput, undefined);
      assert.equal(
        runningProjectedExitCode,
        undefined,
        "mid-stream exit_code must not project until the tool is terminal",
      );
      assert.equal(completedExitCode, 0);

      yield* Queue.takeAll(protocolEvents);
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const secondProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
      });
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: secondProviderTurnId,
        requestRuntimeRestart: true,
      });
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 3 }),
      );
      const loadAfterRestart = yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/resume",
        ),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(loadAfterRestart));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("drains native ACP cancellation before admitting the next prompt", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const native: { current?: AcpSessionRuntime.AcpSessionRuntime["Service"] } = {};
      const instanceId = ProviderInstanceId.make("acp-native-cancel");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            environment: { T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1" },
            protocolEvents,
            cancelBehavior: "wait-for-prompt",
            wrapRuntime: (runtime) => {
              native.current = runtime;
              return runtime;
            },
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-native-cancel");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-acp-native-cancel"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );
      const started = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === "native-cancel-tool",
          ),
          Stream.runHead,
        ),
      );
      if (
        started.type !== "turn_item.updated" ||
        started.turnItem.providerTurnId === null ||
        native.current === undefined
      ) {
        return yield* Effect.die("Expected the native cancellable command");
      }
      const providerTurnId = started.turnItem.providerTurnId;
      const interrupt = yield* runtime
        .interruptTurn({ providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "incoming" &&
            typeof event.payload === "string" &&
            event.payload.includes("native-cancel-received"),
        ),
        Stream.runHead,
      );
      yield* native.current.request("_test/finish-cancel", {});
      yield* Fiber.join(interrupt);
      const terminal = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) => event.type === "turn.terminal" && event.providerTurnId === providerTurnId,
          ),
          Stream.runHead,
        ),
      );
      assert.equal(terminal.type === "turn.terminal" && terminal.status, "interrupted");
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
      );
      const nextTerminal = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) => event.type === "turn.terminal" && event.providerTurnId !== providerTurnId,
          ),
          Stream.runHead,
        ),
      );
      assert.equal(nextTerminal.type === "turn.terminal" && nextTerminal.status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("cancels pending permission requests while interrupting an ACP turn", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const releaseCancel = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
            wrapCancel: (cancel) => Deferred.await(releaseCancel).pipe(Effect.andThen(cancel)),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-cancel-permission");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-cancel-permission"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );

      const pendingRequest = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pendingRequest.type !== "runtime_request.updated" ||
        pendingRequest.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected a pending ACP permission request with a provider turn");
      }

      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: pendingRequest.runtimeRequest.providerTurnId,
        })
        .pipe(Effect.forkScoped);

      const cancelledRequest = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.id === pendingRequest.runtimeRequest.id &&
              event.runtimeRequest.status === "cancelled",
          ),
          Stream.runHead,
        ),
      );
      assert.equal(cancelledRequest.type, "runtime_request.updated");
      yield* Deferred.succeed(releaseCancel, undefined);
      yield* Fiber.join(interruptFiber);
      const terminal = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        ),
      );
      assert.equal(terminal.type, "turn.terminal");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("keeps hard teardown excluded until a permission response is enqueued", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseEnqueued = yield* Deferred.make<void>();
      const releaseResponseAcknowledgement = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test");
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
              Deferred.succeed(responseEnqueued, undefined).pipe(
                Effect.andThen(Deferred.await(releaseResponseAcknowledgement)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-response-wins-permission");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-response-wins-permission"),
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
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pending.type !== "runtime_request.updated" ||
        pending.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected a pending permission request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(responseEnqueued);
      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: pending.runtimeRequest.providerTurnId,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isUndefined(responseFiber.pollUnsafe());
      assert.isUndefined(interruptFiber.pollUnsafe());

      yield* Deferred.succeed(releaseResponseAcknowledgement, undefined);
      yield* Fiber.join(responseFiber);
      yield* Fiber.join(interruptFiber);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
