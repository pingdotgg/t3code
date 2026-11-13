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
  it.live("reports per-turn usage unavailable on a continuation turn that never prompts", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-usage-continuation");
      const threadId = ThreadId.make("thread-acp-usage-continuation");
      let promptOrdinal = 0;
      const promptUsages = [
        { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
        { inputTokens: 130, outputTokens: 30, totalTokens: 160 },
      ];
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        continuationRequests: { offer: () => Effect.void },
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          enablePostSettleContinuation: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () => {
                promptOrdinal += 1;
                const usage = promptUsages[promptOrdinal - 1];
                if (usage === undefined) return Effect.die("Unexpected prompt");
                return Effect.succeed({ stopReason: "end_turn" as const, usage });
              },
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-usage-continuation"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const completedUsage = (ordinal: number) =>
        Effect.gen(function* () {
          yield* runtime.startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal }),
          );
          const events = Array.from(
            yield* runtime.events.pipe(
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            ),
          );
          const completed = events.find(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
          );
          return completed?.type === "provider_turn.updated"
            ? completed.providerTurn.turnTokenUsage
            : null;
        });
      assert.deepEqual(yield* completedUsage(1), {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 60,
        outputTokens: 15,
      });
      // Continuation attach: drains wake traffic and finalizes without ever
      // dispatching session/prompt, so it must report unavailable usage.
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now,
          ordinal: 2,
          messageCreatedBy: "agent",
          messageCreationSource: "provider",
          messageText: "Background task completed.",
        }),
      );
      const continuationEvents = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const continuation = continuationEvents.find(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.deepEqual(
        continuation?.type === "provider_turn.updated"
          ? continuation.providerTurn.turnTokenUsage
          : null,
        { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
      );
      // The continuation must not disturb the next real prompt's sample.
      assert.deepEqual(yield* completedUsage(3), {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 130,
        outputTokens: 30,
      });
      assert.equal(promptOrdinal, 2, "continuation turn must not dispatch session/prompt");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("fails an end_turn the outcome check rejects and restarts before the next turn", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-prompt-outcome");
      const threadId = ThreadId.make("thread-acp-prompt-outcome");
      const quota = {
        class: "usage_limit",
        message: "Quota reached.",
        code: "RESOURCE_EXHAUSTED",
        retryable: true,
        resetAt: "2030-01-01T00:00:00.000Z",
      } as const;
      // The runtime ordinal of each prompt, and the session each check watched.
      const promptRuntimes: Array<number> = [];
      const watchedSessions: Array<string> = [];
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          watchPromptOutcome: (sessionId) =>
            Effect.sync(() => {
              watchedSessions.push(sessionId);
              const failed = watchedSessions.length === 1;
              return () => Effect.succeed(failed ? quota : undefined);
            }),
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime, runtimeOrdinal) => ({
              ...runtime,
              prompt: () =>
                Effect.sync(() => {
                  promptRuntimes.push(runtimeOrdinal);
                  return { stopReason: "end_turn" as const };
                }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-prompt-outcome"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const runTurn = (ordinal: number) =>
        Effect.gen(function* () {
          yield* runtime.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now: yield* DateTime.now,
              ordinal,
            }),
          );
          const events = yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          return events.at(-1);
        });

      const failed = yield* runTurn(1);
      if (failed?.type !== "turn.terminal" || failed.status !== "failed") {
        return assert.fail("expected a failed terminal");
      }
      assert.deepEqual(failed.failure, quota);
      const completed = yield* runTurn(2);
      assert.equal(completed?.type === "turn.terminal" ? completed.status : null, "completed");
      assert.deepEqual(promptRuntimes, [1, 2], "the next turn runs on a fresh runtime");
      assert.equal(watchedSessions.length, 2);
      assert.equal(watchedSessions[0], watchedSessions[1]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("retains returned usage when Stop finalizes before the prompt callback", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-prompt-usage-stop");
      const threadId = ThreadId.make("thread-acp-prompt-usage-stop");
      const wireSettled = yield* Deferred.make<void>();
      const releaseCompletion = yield* Deferred.make<void>();
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        testHooks: {
          afterPromptWireSettled: () =>
            Deferred.succeed(wireSettled, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCompletion)),
            ),
        },
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          preserveRuntimeOnSettledInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () =>
                Effect.succeed({
                  stopReason: "end_turn" as const,
                  usage: { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
                }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-prompt-usage-stop"),
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
      yield* Deferred.await(wireSettled);
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId });
      const completed = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).find(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "interrupted",
      );
      assert.deepEqual(
        completed?.type === "provider_turn.updated" ? completed.providerTurn.turnTokenUsage : null,
        {
          usageScope: "main_agent",
          usageStatus: "partial",
          hasSubagents: false,
          inputTokens: 60,
          outputTokens: 15,
        },
      );
      yield* Deferred.succeed(releaseCompletion, undefined);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("drops a late prompt response that lands after the turn finalized", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-prompt-usage-late");
      const threadId = ThreadId.make("thread-acp-prompt-usage-late");
      const dispatched = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const wireSettled = yield* Deferred.make<void>();
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        testHooks: {
          afterPromptWireSettled: () =>
            Deferred.succeed(wireSettled, undefined).pipe(Effect.asVoid),
        },
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            ownDetachedProcessGroup: true,
            processGroupTerminationGrace: 0,
            wrapRuntime: (runtime) => ({
              ...runtime,
              // The response only leaves the agent after the turn has been
              // force stopped and finalized: teardown does not interrupt this fiber.
              prompt: () =>
                Deferred.succeed(dispatched, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(
                    Effect.succeed({
                      stopReason: "cancelled" as const,
                      usage: { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
                    }),
                  ),
                ),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-prompt-usage-late"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      let stopCollector = false;
      const events: Array<Record<string, unknown>> = [];
      const usageRecorded = yield* Deferred.make<void>();
      const collector = yield* Stream.runForEach(
        runtime.events.pipe(Stream.takeUntil(() => stopCollector)),
        (event) =>
          Effect.suspend(() => {
            const record = event as Record<string, unknown>;
            events.push(record);
            return record.type === "provider_turn.updated" &&
              (record.providerTurn as Record<string, unknown>).turnTokenUsage !== undefined
              ? Deferred.succeed(usageRecorded, undefined)
              : Effect.void;
          }),
      ).pipe(Effect.forkScoped);
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          messageText: "Say hi.",
        }),
      );
      yield* Deferred.await(dispatched);
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      // Force stop finalizes the turn without waiting for the gated prompt response.
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId,
        requestRuntimeRestart: true,
      });
      yield* Deferred.await(usageRecorded);
      const usageAt = () => {
        const turns = events.filter(
          (event) =>
            event.type === "provider_turn.updated" &&
            (event.providerTurn as Record<string, unknown>).turnTokenUsage !== undefined,
        );
        const last = turns[turns.length - 1] as
          | { providerTurn: Record<string, unknown> }
          | undefined;
        return last?.providerTurn.turnTokenUsage as Record<string, unknown>;
      };
      assert.deepEqual(usageAt(), {
        usageScope: "main_agent",
        usageStatus: "unavailable",
        hasSubagents: false,
      });
      // The response lands now; the finalized turn must not adopt its counters.
      yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(wireSettled);
      assert.deepEqual(usageAt(), {
        usageScope: "main_agent",
        usageStatus: "unavailable",
        hasSubagents: false,
      });
      stopCollector = true;
      yield* Fiber.interrupt(collector);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("passes per-turn usage samples through", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-per-turn-usage");
      const threadId = ThreadId.make("thread-acp-per-turn-usage");
      let promptOrdinal = 0;
      // Fixture shaped after the live glm-acp-agent probe: three sequential
      // prompts whose inputTokens grow by tens, not by a context per turn.
      // GLM never sends cachedWriteTokens; those values are added here to
      // exercise the clamp path.
      const promptUsages = [
        {
          inputTokens: 2432,
          outputTokens: 3,
          totalTokens: 2435,
          cachedReadTokens: 1024,
          cachedWriteTokens: 64,
          thoughtTokens: 2,
        },
        {
          inputTokens: 2453,
          outputTokens: 4,
          totalTokens: 2457,
          cachedReadTokens: 1045,
          cachedWriteTokens: 85,
          thoughtTokens: 3,
        },
        {
          inputTokens: 2475,
          outputTokens: 25,
          totalTokens: 2500,
          cachedReadTokens: 1067,
          cachedWriteTokens: 107,
          thoughtTokens: 20,
        },
      ];
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () => {
                const usage = promptUsages[promptOrdinal++];
                if (usage === undefined) return Effect.die("Unexpected prompt");
                return Effect.succeed({ stopReason: "end_turn" as const, usage });
              },
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-per-turn-usage"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      for (const [index, sample] of promptUsages.entries()) {
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: index + 1,
          }),
        );
        const events = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const completed = events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        // Per-turn: each response's own sample maps straight onto its turn.
        assert.deepEqual(
          completed?.type === "provider_turn.updated"
            ? completed.providerTurn.turnTokenUsage
            : null,
          {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: sample.inputTokens,
            outputTokens: sample.outputTokens,
            cachedInputTokens: sample.cachedReadTokens,
            cacheCreationTokens: sample.cachedWriteTokens,
            reasoningTokens: sample.thoughtTokens,
          },
        );
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("clamps per-turn subsets that exceed their parent counters", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-per-turn-clamp");
      const threadId = ThreadId.make("thread-acp-per-turn-clamp");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () =>
                Effect.succeed({
                  stopReason: "end_turn" as const,
                  usage: {
                    inputTokens: 100,
                    outputTokens: 10,
                    totalTokens: 110,
                    cachedReadTokens: 150,
                    cachedWriteTokens: 120,
                    thoughtTokens: 30,
                  },
                }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-per-turn-clamp"),
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
      const completed = events.find(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      // TurnTokenUsage contract: input includes cache read + write and
      // reasoning is a subset of output. Reads clamp to input, writes clamp
      // to what reads leave of it (100 - 100 = 0 here).
      assert.deepEqual(
        completed?.type === "provider_turn.updated" ? completed.providerTurn.turnTokenUsage : null,
        {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 100,
          cacheCreationTokens: 0,
          reasoningTokens: 10,
        },
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
