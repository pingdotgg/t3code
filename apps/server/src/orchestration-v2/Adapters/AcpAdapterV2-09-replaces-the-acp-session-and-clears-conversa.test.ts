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
  rawProtocolPromptTextBlocks,
  sessionId,
} from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.effect("replaces the ACP session and clears conversation state on rollback", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("acp-test-rollback-session");
      const rollbackThreadId = ThreadId.make("thread-acp-rollback-session-target");
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-rollback-session-target"),
        threadId: rollbackThreadId,
        providerSessionId: "mcp-session-acp-rollback-session-target",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43124/mcp",
        authorizationHeader: "Bearer rollback-target-token",
        browserToolsAvailable: false,
      });
      const runtimeInputs: Array<AcpAdapterV2RuntimeInput> = [];
      const nativeRuntimes: Array<AcpSessionRuntime.AcpSessionRuntime["Service"]> = [];
      let sessionEventCount = 0;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        environment: { T3_ACP_PROMPT_DELAY_MS: "100" },
        wrapRuntime: (nativeRuntime) => {
          nativeRuntimes.push(nativeRuntime);
          return nativeRuntime;
        },
      });
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (runtimeInput) =>
            Effect.sync(() => runtimeInputs.push(runtimeInput)).pipe(
              Effect.andThen(makeRuntime(runtimeInput)),
            ),
          onSessionEvent: () =>
            Effect.sync(() => {
              sessionEventCount += 1;
            }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-rollback-session");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-rollback-session"),
        modelSelection,
        runtimePolicy,
      });
      assert.isTrue(runtime.providerSession.capabilities.threads.canRollbackThread);
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
      const firstSessionId = providerThread.nativeThreadRef?.nativeId;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const activeRollback = yield* runtime
        .rollbackThread({
          providerThread,
          providerThreadTurns: [],
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint-acp-active-rollback"),
            appRunOrdinal: 0,
          },
        })
        .pipe(Effect.result);
      assert.equal(activeRollback._tag, "Failure");
      if (activeRollback._tag === "Failure") {
        assert.include(String(activeRollback.failure.cause), "while turn");
      }
      const firstProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, `${firstSessionId}:turn:1`),
      });
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) break;
      }
      const snapshotBeforeRollback = yield* runtime.readThreadSnapshot({ providerThread });

      const rolledBack = yield* runtime.rollbackThread({
        providerThread: { ...providerThread, appThreadId: rollbackThreadId },
        providerThreadTurns: snapshotBeforeRollback.providerTurns,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-acp-rollback-session"),
          appRunOrdinal: 0,
        },
      });
      assert.isString(rolledBack.providerThread.nativeThreadRef?.nativeId);
      assert.deepEqual(rolledBack.providerTurns, []);
      assert.equal(
        runtimeInputs[1]?.processEnvironment?.T3_ACP_MCP_AUTHORIZATION,
        "Bearer rollback-target-token",
      );
      const replacementMcpServer = runtimeInputs[1]?.mcpServers[0];
      const replacementMcpEnvironment =
        replacementMcpServer !== undefined &&
        "env" in replacementMcpServer &&
        Array.isArray(replacementMcpServer.env)
          ? replacementMcpServer.env
          : undefined;
      assert.equal(
        replacementMcpEnvironment?.find((variable) => variable.name === "T3_ACP_MCP_AUTHORIZATION")
          ?.value,
        "Bearer rollback-target-token",
      );
      const snapshotAfterRollback = yield* runtime.readThreadSnapshot({
        providerThread: rolledBack.providerThread,
      });
      assert.deepEqual(snapshotAfterRollback.providerTurns, []);
      assert.deepEqual(snapshotAfterRollback.messages, []);
      const sessionEventsBeforeSecondTurn = sessionEventCount;

      yield* runtime.startTurn(
        makeTurnInput({
          threadId: rollbackThreadId,
          providerThread: rolledBack.providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 2,
        }),
      );
      const secondProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(
          instanceId,
          `${rolledBack.providerThread.nativeThreadRef?.nativeId}:turn:2`,
        ),
      });
      let secondStatus: string | null = null;
      while (secondStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
          secondStatus = event.status;
        }
      }
      assert.equal(secondStatus, "completed");
      yield* nativeRuntimes[1]!.drainEvents;
      assert.isAbove(sessionEventCount, sessionEventsBeforeSecondTurn);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("quarantines callbacks from a failed rollback replacement before retrying", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const sessionUpdateHandlers: Array<
        Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined
      > = [];
      const backgroundMutationHandlers: Array<
        AcpAdapterV2ExtensionContext["applyBackgroundTaskMutation"] | undefined
      > = [];
      const availableCommandUpdates: Array<ReadonlyArray<EffectAcpSchema.AvailableCommand>> = [];
      let registeredExtensionOrdinal = 0;
      let runtimeOrdinalSeen = 0;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        wrapRuntime: (runtime, runtimeOrdinal) => {
          runtimeOrdinalSeen = runtimeOrdinal;
          return {
            ...runtime,
            handleSessionUpdate: (handler) =>
              Effect.sync(() => {
                sessionUpdateHandlers[runtimeOrdinal - 1] = handler;
              }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            ...(runtimeOrdinal === 2
              ? {
                  start: () =>
                    Effect.fail(
                      new EffectAcpErrors.AcpTransportError({
                        detail: "Forced first rollback replacement failure",
                        cause: "test",
                      }),
                    ),
                }
              : runtimeOrdinal === 3
                ? {
                    start: () =>
                      Effect.suspend(() => {
                        const stagedSessionUpdate = sessionUpdateHandlers[2];
                        if (stagedSessionUpdate === undefined) {
                          return Effect.die("replacement startup must buffer session updates");
                        }
                        return stagedSessionUpdate({
                          sessionId: "mock-session-3",
                          update: {
                            sessionUpdate: "available_commands_update",
                            availableCommands: [
                              {
                                name: "staged-command",
                                description: "published while the replacement starts",
                              },
                            ],
                          },
                        }).pipe(Effect.andThen(runtime.start()));
                      }),
                  }
                : {}),
          };
        },
      });
      const instanceId = ProviderInstanceId.make("acp-test-rollback-retry-generation");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          onAvailableCommandsUpdate: (commands) =>
            Effect.sync(() => {
              availableCommandUpdates.push(commands);
            }),
          registerExtensions: (context) =>
            Effect.sync(() => {
              backgroundMutationHandlers[registeredExtensionOrdinal] =
                context.applyBackgroundTaskMutation;
              registeredExtensionOrdinal += 1;
            }),
          makeRuntime,
        },
        selfInvocation,
        continuationRequests: { offer: () => Effect.void },
      });
      const threadId = ThreadId.make("thread-acp-rollback-retry-generation");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-rollback-retry-generation"),
        modelSelection,
        runtimePolicy,
      });
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("ACP runtime must expose background work state");
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

      yield* runtime.rollbackThread({
        providerThread,
        providerThreadTurns: [],
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-acp-rollback-retry-generation"),
          appRunOrdinal: 0,
        },
      });

      assert.equal(runtimeOrdinalSeen, 3);
      assert.deepEqual(
        availableCommandUpdates.map((commands) => commands.map((command) => command.name)),
        [["staged-command"]],
      );
      const failedReplacementHandler = sessionUpdateHandlers[1];
      const failedBackgroundMutationHandler = backgroundMutationHandlers[1];
      assert.isDefined(failedReplacementHandler);
      assert.isDefined(failedBackgroundMutationHandler);
      while (Option.isSome(yield* Queue.poll(events))) {}
      yield* failedReplacementHandler!({
        sessionId: "failed-replacement-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "stale failed replacement callback" },
        },
      });
      assert.isTrue(Option.isNone(yield* Queue.poll(events)));
      yield* failedBackgroundMutationHandler!({
        sessionId: "mock-session-3",
        taskId: "stale-failed-replacement-task",
        status: "running",
      });
      assert.isFalse(yield* hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("settles a Grok background command that completed before an ACP v2 idle error", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("grok-idle-error-background");
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
            environment: { T3_ACP_IDLE_ERROR: "grok-background" },
          })(input).pipe(Effect.flatMap(makeXAiPromptCompletionRuntime)),
      });
      const threadId = ThreadId.make("grok-idle-error-background");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-idle-error-background"),
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
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const terminal = events.at(-1);
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "failed");
      const command = events.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "call-idle-error-background",
      );
      assert.equal(
        command?.type === "turn_item.updated" ? command.turnItem.status : undefined,
        "completed",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Oracle: Grok incident frames. Command completion must release the turn even
  // when the CLI keeps the prompt RPC and process alive. Command polls stay visible.
  it.live(
    "completes a structured Grok background command from poll with an unanswered prompt RPC",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("grok-background-completion");
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
              environment: { T3_ACP_GROK_BACKGROUND_TASK_COMPLETION: "poll" },
            })(input).pipe(Effect.flatMap(makeXAiPromptCompletionRuntime)),
        });
        const threadId = ThreadId.make("grok-background-completion");
        const modelSelection = { instanceId, model: "default" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("grok-background-completion"),
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
          (item) => item.nativeItemRef?.nativeId === "call-fb9d0000-0000-0000-0000-000000000026-29",
        );
        assert.equal(command?.type, "command_execution");
        assert.equal(command?.status, "completed");
        assert.isTrue(
          items.some((item) => item.nativeItemRef?.nativeId === "call-background-poll"),
          "command TaskOutput must retain its normal tool frame",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Grok expands only a leading `/name`, so a picked leading `$name`
  // must reach it in that form; anything else keeps the user's text.
  it.live.each([
    { text: "$deploy ship it", sent: "/deploy ship it", native: true },
    { text: "ship $deploy", sent: "ship $deploy", native: false },
    { text: "$other ship it", sent: "$other ship it", native: false },
  ])("Grok sends $text with a picked skill as $sent", ({ text, sent, native }) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const hostPlatform = yield* HostProcess.Platform;
      // Stands in for `grok inspect --json`, the catalog behind the `$` picker.
      const catalog = { skills: [{ name: "deploy", source: { path: "/s/deploy/SKILL.md" } }] };
      const grokPath = writeFakeCli({
        directory: yield* fileSystem.makeTempDirectoryScoped(),
        name: "grok",
        source: `process.stdout.write(${JSON.stringify(`${JSON.stringify(catalog)}\n`)});\n`,
        platform: hostPlatform,
      });
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("grok-skill-mention");
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: { ...DEFAULT_GROK_SETTINGS, binaryPath: grokPath },
        // The fake CLI needs `node` on its PATH.
        environment: { ...process.env },
        hostPlatform,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeMockRuntime({ childProcessSpawner, mockAgentPath, protocolEvents })(input).pipe(
            Effect.flatMap(makeXAiPromptCompletionRuntime),
          ),
      });
      const threadId = ThreadId.make("grok-skill-mention");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-skill-mention"),
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
          messageText: text,
        }),
      );
      const prompt = yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const blocks = rawProtocolPromptTextBlocks(Option.getOrThrow(prompt));
      if (native) {
        // Same shape as a typed native command: one bare text block, no T3 instructions.
        assert.deepEqual(blocks, [{ type: "text", text: sent }]);
      } else {
        assert.isTrue(blocks.some((block) => block.text.includes(sent)));
        assert.isFalse(blocks.some((block) => block.text.trimStart().startsWith("/")));
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Command completion must release the turn even when the CLI keeps the prompt RPC and process
  // alive. Kill calls stay visible.
});
