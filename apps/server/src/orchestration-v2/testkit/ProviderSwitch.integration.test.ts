import { vi } from "vite-plus/test";
import { historyResponseItems } from "../ContextHandoffBudget.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ChatAttachment,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurnTokenUsage,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { CommandPolicyCapabilityUnsupportedError } from "../CommandPolicy.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import {
  CodexProviderCapabilitiesV2,
  canReuseCodexContextUsage,
} from "../Adapters/CodexAdapterV2.ts";
import { AcpProviderCapabilitiesV2 } from "../Adapters/AcpAdapterV2.ts";
import { CursorProviderCapabilitiesV2 } from "../Adapters/CursorAdapterV2.ts";
import { layer as eventSinkLayer } from "../EventSink.ts";
import { EventSinkV2, EventSinkWriteError } from "../EventSink.ts";
import { layer as eventStoreLayer } from "../EventStore.ts";
import {
  LegacyV1ThreadImporter,
  layer as legacyV1ThreadImporterLayer,
} from "../LegacyV1ThreadImporter.ts";
import { OrchestratorDispatchError, OrchestratorV2 } from "../Orchestrator.ts";
import { OrchestrationEffectWorkerV2 } from "../EffectWorker.ts";
import { EffectOutboxV2, layer as effectOutboxLayer } from "../EffectOutbox.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "../ProjectionMaintenance.ts";
import { layer as projectionStoreLayer } from "../ProjectionStore.ts";
import {
  type ProviderAdapterV2Event,
  type ProviderAdapterV2HistoricalContext,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../ProviderAdapterRegistry.ts";
import {
  ProviderAdapterRegistryLookupError,
  ProviderAdapterRegistryV2,
} from "../ProviderAdapterRegistry.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  CURSOR_MODEL_SELECTION,
  GROK_MODEL_SELECTION,
} from "./fixtures/shared.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const threadId = ThreadId.make("thread:provider-switch");
const projectId = ProjectId.make("project:provider-switch");
const firstPrompt = "Respond with exactly: codex before switch";
const claudePrompt = "Respond with exactly: claude switched response";
const returnPrompt = "Respond with exactly: codex after return";
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const GROK_DRIVER = ProviderDriverKind.make("acp");

interface CapturedTurn {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

function unimplemented(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapterProtocolError({ driver, detail }));
}

function makeTestAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly modelSelection: ModelSelection;
  readonly responseByRunOrdinal: Readonly<Record<number, string>>;
  readonly responseByThreadId?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly injectedHistory?: Ref.Ref<ReadonlyArray<unknown>>;
  readonly failStartOnce?: Ref.Ref<boolean>;
  readonly failInjectionOnce?: Ref.Ref<boolean>;
  readonly nativeThreadGeneration?: Ref.Ref<number>;
  readonly failResume?: boolean;
  readonly failResumeOnce?: Ref.Ref<boolean>;
  readonly initialContextUsage?: OrchestrationV2ProviderThread["contextUsage"];
  readonly getModelContextWindow?: (selection: ModelSelection) => number | undefined;
  readonly canReuseContextUsage?: ProviderAdapterV2SessionRuntime["canReuseContextUsage"];
  readonly tokenUsageByRunOrdinal?: Readonly<
    Record<number, Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt">>
  >;
  readonly failedRunOrdinals?: ReadonlySet<number>;
  readonly interruptedRunOrdinals?: ReadonlySet<number>;
  readonly holdRunOrdinal?: number;
  readonly holdFirstTurn?: Deferred.Deferred<void>;
  readonly releaseFirstTurn?: Deferred.Deferred<void>;
}): ProviderAdapterV2Shape {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ...(input.getModelContextWindow === undefined
            ? {}
            : { getModelContextWindow: input.getModelContextWindow }),
          ...(input.canReuseContextUsage === undefined
            ? {}
            : { canReuseContextUsage: input.canReuseContextUsage }),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const generation =
                input.nativeThreadGeneration === undefined
                  ? ""
                  : `:${yield* Ref.getAndUpdate(input.nativeThreadGeneration, (value) => value + 1)}`;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}${generation}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: input.initialContextUsage ?? null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            Effect.gen(function* () {
              if (
                input.failResume ||
                (input.failResumeOnce !== undefined &&
                  (yield* Ref.getAndSet(input.failResumeOnce, false)))
              )
                return yield* unimplemented(input.driver, "simulated native resume failure");
              return providerThread;
            }),
          ...(input.injectedHistory === undefined
            ? {}
            : {
                injectHistory: (history: ProviderAdapterV2HistoricalContext) =>
                  Ref.update(input.injectedHistory!, (current) => [
                    ...current,
                    ...historyResponseItems(history.messages, history.context),
                  ]).pipe(
                    Effect.andThen(
                      Effect.gen(function* () {
                        if (
                          input.failInjectionOnce !== undefined &&
                          (yield* Ref.getAndSet(input.failInjectionOnce, false))
                        )
                          return yield* unimplemented(
                            input.driver,
                            "lost injection acknowledgement",
                          );
                        return true;
                      }),
                    ),
                  ),
              }),
          compactThread: (turnInput) => runtime.startTurn(turnInput),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              if (
                input.failStartOnce !== undefined &&
                (yield* Ref.getAndSet(input.failStartOnce, false))
              )
                return yield* unimplemented(input.driver, "turn start failed after injection");
              yield* Effect.yieldNow;
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  text: turnInput.message.text,
                  attachments: turnInput.message.attachments,
                },
              ]);
              if (
                turnInput.runOrdinal === (input.holdRunOrdinal ?? 1) &&
                input.holdFirstTurn !== undefined
              ) {
                yield* Deferred.succeed(input.holdFirstTurn, undefined);
                if (input.releaseFirstTurn === undefined) return;
                yield* Deferred.await(input.releaseFirstTurn);
              }
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const terminalStatus = input.failedRunOrdinals?.has(turnInput.runOrdinal)
                ? "failed"
                : input.interruptedRunOrdinals?.has(turnInput.runOrdinal)
                  ? "interrupted"
                  : "completed";
              const response =
                input.responseByThreadId?.[turnInput.threadId]?.[turnInput.runOrdinal] ??
                input.responseByRunOrdinal[turnInput.runOrdinal] ??
                `${input.driver} response for run ${turnInput.runOrdinal}`;
              const providerEvents: ReadonlyArray<ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: terminalStatus,
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: terminalStatus,
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  ...(terminalStatus === "failed"
                    ? {
                        status: terminalStatus,
                        failureItemOrdinal: turnInput.runOrdinal * 100 + 2,
                        failure: makeProviderFailure({
                          message: "Simulated provider failure.",
                          code: "simulated_failure",
                          class: "provider_error",
                        }),
                      }
                    : { status: terminalStatus, failure: null }),
                  threadDisposition: "reusable",
                },
              ];
              const reportedUsage = input.tokenUsageByRunOrdinal?.[turnInput.runOrdinal];
              const turnEvent = providerEvents[0];
              if (reportedUsage && turnEvent?.type === "provider_turn.updated") {
                yield* PubSub.publish(events, {
                  ...turnEvent,
                  providerTurn: {
                    ...turnEvent.providerTurn,
                    status: "running",
                    completedAt: null,
                    tokenUsage: { ...reportedUsage, updatedAt: DateTime.formatIso(eventTime) },
                  },
                });
              }
              for (const event of providerEvents) {
                yield* PubSub.publish(events, event);
              }
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unimplemented(input.driver, "readThreadSnapshot unused in provider switch test"),
          rollbackThread: () =>
            unimplemented(input.driver, "rollbackThread unused in provider switch test"),
          forkThread: () =>
            unimplemented(input.driver, "forkThread unused in provider switch test"),
        };
        return runtime;
      }),
  };
}

const waitForIdle = Effect.fn("ProviderSwitchTest.waitForIdle")(function* (
  targetThreadId: ThreadId,
) {
  const orchestrator = yield* OrchestratorV2;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(targetThreadId);
    if (
      projection.runs.every(
        (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
      )
    ) {
      return projection;
    }
    yield* Effect.sleep("5 millis");
  }
  return yield* Effect.die(new Error("Provider switch test timed out waiting for idle"));
});

describe("orchestration v2 provider switching", () => {
  for (const scenario of [
    "compact-native",
    "compact-fallback",
    "compact-legacy",
    "large-current-input",
    "screenshot-native",
    "screenshot-fallback",
    "screenshot-pair-native",
    "screenshot-pair-fallback",
    "screenshot-eight-native",
    "screenshot-eight-fallback",
    "screenshot-large-model-native",
    "screenshot-reported-capacity-native",
    "screenshot-model-change-native",
    "screenshot-option-change-native",
    "screenshot-model-change-retry-native",
    "screenshot-option-change-retry-native",
    "prior-images-reasoning-change-replacement-native",
    "prior-images-reasoning-change-replacement-small-native",
    "prior-images-reasoning-change-native",
    "prior-images-turn-usage-native",
    "prior-images-turn-usage-replacement-native",
    "prior-images-turn-usage-model-change-native",
    "prior-images-turn-usage-option-change-retry-native",
    "prior-images-reasoning-change-retry-native",
    "prior-images-native",
    "prior-images-fallback",
    "imported-prior-images-native",
    "imported-prior-images-fallback",
    "prior-images-telemetry-native",
    "prior-images-unsent-native",
    "prior-images-replacement-native",
    "prior-images-legacy-replacement-native",
    "delivery-write-failure",
  ] as const) {
    it.live(`preserves handoffs through ${scenario}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(`handoff-${scenario}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const reasoningScenario = scenario.includes("reasoning-change");
          const turnUsageScenario = reasoningScenario || scenario.includes("turn-usage");
          const incompatibleTurnUsage =
            scenario.includes("turn-usage") && scenario.includes("-change-");
          const modelScenario =
            scenario.includes("model") || scenario.includes("option-change") || reasoningScenario;
          const failStartOnce = yield* Ref.make(false);
          const failResumeOnce = yield* Ref.make(false);
          const generation = yield* Ref.make(0);
          const priorImages = scenario.includes("prior-images");
          const replaceNative = scenario.includes("replacement");
          const capacityScenario = modelScenario || scenario.includes("reported-capacity");
          const returning =
            scenario === "large-current-input" || scenario.includes("-change-") || priorImages;
          const targetSelection: ModelSelection = !modelScenario
            ? CLAUDE_MODEL_SELECTION
            : {
                ...CLAUDE_MODEL_SELECTION,
                ...(reasoningScenario
                  ? { options: [{ id: "reasoningEffort", value: "low" }] }
                  : scenario.includes("option-change")
                    ? { options: [{ id: "contextWindow", value: "1m" }] }
                    : { model: `${CLAUDE_MODEL_SELECTION.model}-large` }),
              };
          const registry = makeProviderAdapterRegistryLayer([
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: CodexProviderCapabilitiesV2,
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: { 1: "Original partial work" },
              capturedTurns,
            }),
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              ...(scenario.includes("retry") || scenario.includes("unsent")
                ? { failStartOnce }
                : {}),
              ...(replaceNative ? { failResumeOnce, nativeThreadGeneration: generation } : {}),
              ...(scenario.includes("reported-capacity")
                ? { initialContextUsage: { usedTokens: 999_999, maxTokens: 1_000_000 } }
                : {}),
              ...(turnUsageScenario
                ? {
                    canReuseContextUsage: canReuseCodexContextUsage,
                    tokenUsageByRunOrdinal: {
                      2: {
                        usedTokens: replaceNative ? 30_000 : 37_321,
                        maxTokens: replaceNative
                          ? scenario.includes("small")
                            ? 32_000
                            : 64_000
                          : 258_400,
                      },
                    },
                  }
                : modelScenario
                  ? {
                      getModelContextWindow: (selection: ModelSelection) =>
                        selection.model.endsWith("-large") ||
                        selection.options?.some(
                          (option) => option.id === "contextWindow" && option.value === "1m",
                        )
                          ? 1_000_000
                          : 32_000,
                    }
                  : scenario === "large-current-input" || priorImages
                    ? { getModelContextWindow: () => 32_000 }
                    : {}),
              ...(scenario.endsWith("-native") || scenario === "large-current-input"
                ? { injectedHistory }
                : {}),
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            const eventSink = yield* EventSinkV2;
            const screenshot: ChatAttachment = {
              type: "image",
              id: "screenshot",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 100_000,
            };
            const screenshots = Array.from(
              {
                length:
                  scenario.includes("eight") || capacityScenario
                    ? 8
                    : scenario.includes("pair")
                      ? 2
                      : 1,
              },
              (_, index) => ({ ...screenshot, id: `screenshot-${index}` }),
            );
            const targetOrdinal = returning ? 4 : 2;
            const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`regression:${ordinal}`),
                threadId,
                messageId: MessageId.make(`regression:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments:
                  turnUsageScenario && ordinal === 2
                    ? Array.from({ length: 8 }, (_, index) => ({
                        ...screenshot,
                        id: `prior-${index}`,
                      }))
                    : turnUsageScenario && ordinal >= targetOrdinal
                      ? [screenshot, { ...screenshot, id: "current-2" }]
                      : scenario.startsWith("screenshot") && ordinal >= targetOrdinal
                        ? screenshots
                        : priorImages && ordinal === (scenario.startsWith("imported") ? 1 : 2)
                          ? [screenshot]
                          : [],
                modelSelection: selection,
                dispatchMode: { type: "start_immediately" },
              });
            const wait = (ordinal: number) =>
              orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
                Effect.andThen(worker.drain()),
              );
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("regression:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Handoff regression",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* dispatch(1, "Original request with constraints", CODEX_MODEL_SELECTION);
            yield* wait(1);
            const write = eventSink.write;
            const spy =
              scenario === "delivery-write-failure"
                ? vi.spyOn(eventSink, "write").mockImplementation((input) =>
                    input.events.some(
                      (event) =>
                        event.type === "context-handoff.updated" &&
                        event.payload.delivery?.status === "inline",
                    )
                      ? Effect.fail(
                          new EventSinkWriteError({
                            eventCount: input.events.length,
                            cause: "bookkeeping unavailable",
                          }),
                        )
                      : write(input),
                  )
                : undefined;
            yield* Effect.addFinalizer(() => Effect.sync(() => spy?.mockRestore()));
            const current = scenario.startsWith("compact")
              ? "/compact"
              : capacityScenario && !turnUsageScenario
                ? "x".repeat(70_000)
                : scenario === "large-current-input"
                  ? "x".repeat(9_000)
                  : "Continue work";
            // First establish the returning native thread: the current request must
            // not be charged as existing context on the subsequent handoff.
            if (returning) {
              if (scenario.includes("unsent")) yield* Ref.set(failStartOnce, true);
              yield* dispatch(
                2,
                turnUsageScenario ? "x".repeat(27_460) : "Establish target",
                CLAUDE_MODEL_SELECTION,
              );
              yield* wait(2);
              if (modelScenario && !turnUsageScenario) {
                const target = (yield* orchestrator.getThreadProjection(
                  threadId,
                )).providerThreads.find(
                  (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
                )!;
                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make("old-model-usage"),
                      type: "provider-thread.updated",
                      threadId,
                      occurredAt: yield* DateTime.now,
                      payload: {
                        ...target,
                        contextUsage: {
                          usedTokens: 30_000,
                          maxTokens: 32_000,
                          autoCompactThreshold: 31_000,
                        },
                      },
                    },
                  ],
                });
              }
              if (scenario.includes("legacy-replacement")) {
                const existing = yield* orchestrator.getThreadProjection(threadId);
                yield* eventSink.write({
                  events: existing.attempts.map(
                    ({ nativeThreadId: _nativeThreadId, ...legacy }, index) => ({
                      id: EventId.make(`legacy-attempt:${index}`),
                      type: "run-attempt.updated" as const,
                      threadId,
                      occurredAt: existing.thread.createdAt,
                      payload: legacy,
                    }),
                  ),
                });
              }
              if (scenario.includes("telemetry")) {
                const target = (yield* orchestrator.getThreadProjection(
                  threadId,
                )).providerThreads.find(
                  (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
                )!;
                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make("compacted-context-usage"),
                      type: "provider-thread.updated",
                      threadId,
                      occurredAt: yield* DateTime.now,
                      payload: { ...target, contextUsage: { usedTokens: 100, maxTokens: 32_000 } },
                    },
                  ],
                });
              }
              yield* dispatch(
                3,
                priorImages && !replaceNative
                  ? "New source constraint " + "q".repeat(9_000)
                  : "New source constraint",
                CODEX_MODEL_SELECTION,
              );
              yield* wait(3);
            }
            if (replaceNative) {
              const target = (yield* orchestrator.getThreadProjection(
                threadId,
              )).providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* orchestrator.dispatch({
                type: "provider-session.detach",
                commandId: CommandId.make("detach-for-native-replacement"),
                threadId,
                providerSessionId: target.providerSessionId!,
              });
              yield* worker.drain();
              yield* Ref.set(failResumeOnce, true);
            }
            if (scenario.includes("retry")) yield* Ref.set(failStartOnce, true);
            yield* dispatch(targetOrdinal, current, targetSelection);
            yield* wait(targetOrdinal);
            if (scenario.includes("retry")) {
              const failed = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(failed.runs.at(-1)?.status, "failed");
              const failedUsage = failed.providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!.contextUsage;
              if (reasoningScenario) {
                assert.deepEqual(failedUsage, { usedTokens: 37_321, maxTokens: 258_400 });
              } else {
                assert.isNull(failedUsage);
              }
              if (reasoningScenario) {
                const target = failed.providerThreads.find(
                  (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
                )!;
                yield* orchestrator.dispatch({
                  type: "provider-session.detach",
                  commandId: CommandId.make("detach-before-reasoning-retry"),
                  threadId,
                  providerSessionId: target.providerSessionId!,
                });
                yield* worker.drain();
              }
              yield* dispatch(targetOrdinal + 1, current, targetSelection);
              yield* wait(targetOrdinal + 1);
            }
            if (incompatibleTurnUsage) {
              const invalidated = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(invalidated.runs.at(-1)?.status, "failed");
              assert.isNull(
                invalidated.providerThreads.find(
                  (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
                )!.contextUsage,
              );
              assert.equal((yield* Ref.get(capturedTurns)).at(-1)!.driver, CODEX_DRIVER);
              return;
            }
            if (reasoningScenario && replaceNative) {
              const replaced = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(
                replaced.runs.at(-1)?.status,
                scenario.includes("small") ? "failed" : "completed",
              );
              const target = replaced.providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              assert.isNull(target.contextUsage);
              assert.equal(yield* Ref.get(generation), 2);
              assert.equal(
                (yield* Ref.get(capturedTurns)).at(-1)!.driver,
                scenario.includes("small") ? CODEX_DRIVER : CLAUDE_DRIVER,
              );
              return;
            }
            if (replaceNative) {
              if (scenario.includes("legacy-replacement")) {
                const recovered = yield* orchestrator.getThreadProjection(threadId);
                const handoff = recovered.contextHandoffs.at(-1)!;
                const { history: _history, ...legacyHandoff } = handoff;
                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make("legacy-replacement-handoff"),
                      type: "context-handoff.updated",
                      threadId,
                      occurredAt: yield* DateTime.now,
                      payload: {
                        ...legacyHandoff,
                        delivery: {
                          nativeThreadId: handoff.delivery!.nativeThreadId,
                          status: handoff.delivery!.status,
                          itemIds: [],
                        },
                      },
                    },
                  ],
                });
              }
              yield* dispatch(
                targetOrdinal + 1,
                "Continue after native replacement",
                CLAUDE_MODEL_SELECTION,
              );
              yield* wait(targetOrdinal + 1);
              yield* dispatch(
                targetOrdinal + 2,
                "Another source constraint " + "q".repeat(9_000),
                CODEX_MODEL_SELECTION,
              );
              yield* wait(targetOrdinal + 2);
              yield* dispatch(targetOrdinal + 3, current, CLAUDE_MODEL_SELECTION);
              yield* wait(targetOrdinal + 3);
            }
            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(projection.runs.at(-1)?.status, "completed");
            if (priorImages) {
              const handoff = projection.contextHandoffs.at(-1)!;
              const context = scenario.endsWith("-native")
                ? yield* encodeJson(yield* Ref.get(injectedHistory))
                : (yield* Ref.get(capturedTurns)).at(-1)!.text;
              const shouldFit =
                turnUsageScenario ||
                scenario.startsWith("imported") ||
                scenario.includes("telemetry") ||
                scenario.includes("unsent") ||
                replaceNative;
              const sourceText =
                `${replaceNative ? "Another" : "New"} source constraint ` + "q".repeat(9_000);
              const sourceItem = projection.turnItems.find(
                (item) => item.type === "user_message" && item.text === sourceText,
              )!;
              assert.isDefined(sourceItem);
              if (shouldFit) {
                assert.include(context, sourceText);
                assert.include(
                  projection.contextHandoffs
                    .filter(
                      (record) =>
                        record.targetRunId ===
                        (reasoningScenario && scenario.includes("retry")
                          ? projection.runs.find((run) => run.ordinal === targetOrdinal)!.id
                          : projection.runs.at(-1)!.id),
                    )
                    .flatMap((record) => record.delivery?.itemIds ?? []),
                  sourceItem.id,
                );
              } else {
                assert.notInclude(context, "q".repeat(9_000));
                assert.isAbove(handoff.delivery!.omittedItemIds!.length, 0);
              }
              const latestRun = projection.runs.at(-1)!;
              const latestAttempt = projection.attempts.find(
                (attempt) => attempt.id === latestRun.activeAttemptId,
              )!;
              const target = projection.providerThreads.find(
                (thread) => thread.id === latestAttempt.providerThreadId,
              )!;
              assert.equal(latestAttempt.nativeThreadId, target.nativeThreadRef!.nativeId);
              if (turnUsageScenario) {
                if (replaceNative) assert.isNull(target.contextUsage);
                else
                  assert.deepEqual(target.contextUsage, { usedTokens: 37_321, maxTokens: 258_400 });
                assert.lengthOf((yield* Ref.get(capturedTurns)).at(-1)!.attachments, 2);
              }
              if (replaceNative) assert.equal(yield* Ref.get(generation), 2);
              return;
            }
            const handoff = projection.contextHandoffs.at(-1)!;
            if (scenario.startsWith("screenshot")) {
              assert.deepEqual((yield* Ref.get(capturedTurns)).at(-1)!.attachments, screenshots);
            }
            if (scenario === "compact-fallback" || scenario === "compact-legacy") {
              if (scenario === "compact-legacy") {
                const { history: _history, ...legacyHandoff } = handoff;
                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make("legacy-handoff-shape"),
                      type: "context-handoff.updated",
                      threadId,
                      runId: handoff.targetRunId,
                      occurredAt: yield* DateTime.now,
                      payload: legacyHandoff,
                    },
                  ],
                });
              }
              assert.isUndefined(handoff.delivery);
              yield* dispatch(3, "Continue after compact", CLAUDE_MODEL_SELECTION);
              yield* wait(3);
              assert.include(
                (yield* Ref.get(capturedTurns)).at(-1)!.text,
                "Original request with constraints",
              );
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.at(-1)?.delivery
                  ?.status,
                "inline",
              );
            } else if (
              scenario === "delivery-write-failure" ||
              (scenario.startsWith("screenshot") && scenario.endsWith("fallback"))
            ) {
              assert.equal(
                handoff.delivery?.status,
                scenario.startsWith("screenshot") ? "inline" : "pending",
              );
              assert.include(
                (yield* Ref.get(capturedTurns)).at(-1)!.text,
                "Original request with constraints",
              );
            } else {
              assert.equal(handoff.delivery?.status, "injected");
              assert.equal((yield* Ref.get(capturedTurns)).at(-1)!.text, current);
              assert.include(
                yield* encodeJson(yield* Ref.get(injectedHistory)),
                "Original request with constraints",
              );
            }
          }).pipe(
            Effect.provide(
              makeOrchestratorV2ReplayLayerWithRegistry(
                {
                  name: `handoff-${scenario}`,
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: { type: "readOnly" },
                  },
                },
                registry,
              ),
            ),
          );
        }),
      ),
    );
  }
  for (const failure of ["turn-start", "injection", "large-missed-request"] as const) {
    it.live(
      `recovers ${failure} failure without duplicating history in the same native thread`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const cwd = yield* checkpointWorkspace(`handoff-retry-${failure}`);
            const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
            const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
            const failOnce = yield* Ref.make(true);
            const generation = yield* Ref.make(0);
            const registry = makeProviderAdapterRegistryLayer([
              makeTestAdapter({
                instanceId: CODEX_MODEL_SELECTION.instanceId,
                driver: CODEX_DRIVER,
                capabilities: CodexProviderCapabilitiesV2,
                modelSelection: CODEX_MODEL_SELECTION,
                responseByRunOrdinal: { 1: "Original partial work" },
                capturedTurns,
              }),
              makeTestAdapter({
                instanceId: CLAUDE_MODEL_SELECTION.instanceId,
                driver: CLAUDE_DRIVER,
                capabilities: ClaudeProviderCapabilitiesV2,
                modelSelection: CLAUDE_MODEL_SELECTION,
                responseByRunOrdinal: {},
                capturedTurns,
                injectedHistory,
                nativeThreadGeneration: generation,
                getModelContextWindow: () => 32_000,
                ...(failure !== "injection"
                  ? { failStartOnce: failOnce }
                  : { failInjectionOnce: failOnce }),
              }),
            ]);
            yield* Effect.gen(function* () {
              const orchestrator = yield* OrchestratorV2;
              const worker = yield* OrchestrationEffectWorkerV2;
              const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
                orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make(`retry:${ordinal}`),
                  threadId,
                  messageId: MessageId.make(`retry:${ordinal}`),
                  createdBy: "user",
                  creationSource: "web",
                  text,
                  attachments: [],
                  modelSelection: selection,
                  dispatchMode: { type: "start_immediately" },
                });
              const wait = (ordinal: number, status: "failed" | "completed") =>
                orchestrator.streamStoredEvents.pipe(
                  Stream.filter(
                    ({ event }) =>
                      event.type === "run.updated" &&
                      event.payload.ordinal === ordinal &&
                      (event.payload.status === "completed" || event.payload.status === "failed"),
                  ),
                  Stream.runHead,
                  Effect.andThen(worker.drain()),
                  Effect.andThen(
                    Effect.gen(function* () {
                      assert.equal(
                        (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                        status,
                      );
                    }),
                  ),
                );
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make("retry:create"),
                threadId,
                projectId,
                createdBy: "user",
                creationSource: "web",
                title: "Handoff retry",
                modelSelection: CODEX_MODEL_SELECTION,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
              });
              yield* dispatch(1, "Original request with constraints", CODEX_MODEL_SELECTION);
              yield* wait(1, "completed");
              yield* dispatch(
                2,
                failure === "large-missed-request" ? "x".repeat(7_000) : "First target request",
                CLAUDE_MODEL_SELECTION,
              );
              yield* wait(2, "failed");
              const failed = yield* orchestrator.getThreadProjection(threadId);
              const failedHandoff = failed.contextHandoffs.at(-1)!;
              assert.equal(
                failedHandoff.delivery?.status,
                failure !== "injection" ? "injected" : "pending",
              );
              const historyBeforeRetry = (yield* Ref.get(injectedHistory)).length;
              const retryText =
                failure === "large-missed-request" ? "y".repeat(10_000) : "Retry target request";
              yield* dispatch(3, retryText, CLAUDE_MODEL_SELECTION);
              yield* wait(3, "completed");
              const retried = yield* orchestrator.getThreadProjection(threadId);
              const lastTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
              assert.equal(lastTurn.text, retryText);
              if (failure !== "injection") {
                const delta = yield* encodeJson(
                  (yield* Ref.get(injectedHistory)).slice(historyBeforeRetry),
                );
                if (failure === "large-missed-request") {
                  assert.include(delta, "omitted 1 items");
                  const missedRequest = retried.turnItems.find(
                    (item) => item.type === "user_message" && item.text === "x".repeat(7_000),
                  )!;
                  const delivery = retried.contextHandoffs.at(-1)!.delivery!;
                  assert.include(delivery.omittedItemIds ?? [], missedRequest.id);
                  assert.notInclude(delivery.itemIds, missedRequest.id);
                } else assert.include(delta, "First target request");
                assert.notInclude(delta, "Original request with constraints");
                assert.notInclude(delta, "Original partial work");
                assert.equal(yield* Ref.get(generation), 1);
              } else {
                assert.equal(yield* Ref.get(generation), 2);
                assert.notEqual(
                  retried.contextHandoffs.at(-1)?.delivery?.nativeThreadId,
                  failedHandoff.delivery?.nativeThreadId,
                );
                const newHistory = yield* encodeJson(
                  (yield* Ref.get(injectedHistory)).slice(historyBeforeRetry),
                );
                assert.include(newHistory, "Original request with constraints");
                assert.include(newHistory, "Original partial work");
                assert.notInclude(newHistory, "Retry target request");
              }
              const beforeFollowup = yield* Ref.get(injectedHistory);
              const followup = "z".repeat(6_000);
              yield* dispatch(4, followup, CLAUDE_MODEL_SELECTION);
              yield* wait(4, "completed");
              assert.equal((yield* Ref.get(capturedTurns)).at(-1)!.text, followup);
              assert.deepEqual(yield* Ref.get(injectedHistory), beforeFollowup);
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.length,
                retried.contextHandoffs.length,
              );
            }).pipe(
              Effect.provide(
                makeOrchestratorV2ReplayLayerWithRegistry(
                  {
                    name: `handoff-retry-${failure}`,
                    runtimePolicyOverride: {
                      cwd,
                      approvalPolicy: "never",
                      sandboxPolicy: { type: "readOnly" },
                    },
                  },
                  registry,
                ),
              ),
            );
          }),
        ),
    );
  }

  for (const status of ["failed", "interrupted"] as const) {
    for (const queued of [false, true]) {
      for (const returning of [false, true]) {
        for (const native of [false, true]) {
          it.live(
            `hands off ${status} context ${queued ? "through the queue" : "immediately"} to ${returning ? "a returning" : "a new"} provider via ${native ? "native history" : "text"}`,
            () =>
              Effect.scoped(
                Effect.gen(function* () {
                  const cwd = yield* checkpointWorkspace(
                    `handoff-${status}-${queued}-${returning}`,
                  );
                  const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
                  const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
                  const started = yield* Deferred.make<void>();
                  const release = yield* Deferred.make<void>();
                  const sourceOrdinal = returning ? 2 : 1;
                  const sourceSelection = returning
                    ? CLAUDE_MODEL_SELECTION
                    : CODEX_MODEL_SELECTION;
                  const targetSelection = returning
                    ? CODEX_MODEL_SELECTION
                    : CLAUDE_MODEL_SELECTION;
                  const originalPrompt =
                    "Keep the release marker violet and preserve the existing API.";
                  const partialResponse = "I checked the API and found the release configuration.";
                  const registryLayer = makeProviderAdapterRegistryLayer(
                    (
                      [
                        [CODEX_MODEL_SELECTION, CODEX_DRIVER, CodexProviderCapabilitiesV2],
                        [CLAUDE_MODEL_SELECTION, CLAUDE_DRIVER, ClaudeProviderCapabilitiesV2],
                      ] as const
                    ).map(([modelSelection, driver, capabilities]) =>
                      makeTestAdapter({
                        instanceId: modelSelection.instanceId,
                        driver,
                        capabilities,
                        modelSelection,
                        responseByRunOrdinal: { [sourceOrdinal]: partialResponse },
                        capturedTurns,
                        ...(native && modelSelection.instanceId === targetSelection.instanceId
                          ? { injectedHistory }
                          : {}),
                        ...(modelSelection.instanceId === sourceSelection.instanceId
                          ? {
                              failedRunOrdinals: new Set(
                                status === "failed" ? [sourceOrdinal] : [],
                              ),
                              interruptedRunOrdinals: new Set(
                                status === "interrupted" ? [sourceOrdinal] : [],
                              ),
                              holdRunOrdinal: sourceOrdinal,
                              holdFirstTurn: started,
                              releaseFirstTurn: release,
                            }
                          : {}),
                      }),
                    ),
                  );
                  yield* Effect.gen(function* () {
                    const orchestrator = yield* OrchestratorV2;
                    const worker = yield* OrchestrationEffectWorkerV2;
                    const waitForRun = (
                      ordinal: number,
                      expectedStatus: "completed" | "failed" | "interrupted",
                    ) =>
                      orchestrator.streamStoredEvents.pipe(
                        Stream.filter(
                          ({ event }) =>
                            event.type === "run.updated" &&
                            event.threadId === threadId &&
                            event.payload.ordinal === ordinal &&
                            event.payload.status === expectedStatus,
                        ),
                        Stream.runHead,
                        Effect.andThen(worker.drain()),
                      );
                    const dispatch = (
                      key: string,
                      text: string,
                      modelSelection: ModelSelection,
                      queue = false,
                    ) =>
                      orchestrator.dispatch({
                        type: "message.dispatch",
                        commandId: CommandId.make(`command:handoff:${key}`),
                        threadId,
                        messageId: MessageId.make(`message:handoff:${key}`),
                        createdBy: "user",
                        creationSource: "web",
                        text,
                        attachments: [],
                        modelSelection,
                        dispatchMode: { type: queue ? "queue_after_active" : "start_immediately" },
                      });
                    yield* orchestrator.dispatch({
                      type: "thread.create",
                      commandId: CommandId.make("command:handoff:create"),
                      threadId,
                      projectId,
                      createdBy: "user",
                      creationSource: "web",
                      title: "Interrupted provider handoff",
                      modelSelection: CODEX_MODEL_SELECTION,
                      runtimeMode: "full-access",
                      interactionMode: "default",
                      branch: null,
                      worktreePath: null,
                    });
                    if (returning) {
                      yield* dispatch(
                        "initial",
                        "Earlier successful request.",
                        CODEX_MODEL_SELECTION,
                      );
                      yield* waitForRun(1, "completed");
                    }
                    yield* dispatch("source", originalPrompt, sourceSelection);
                    yield* Deferred.await(started);
                    if (queued) {
                      yield* dispatch("target", "Continue", targetSelection, true);
                      assert.equal(
                        (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                        "queued",
                      );
                    }
                    yield* Deferred.succeed(release, undefined);
                    yield* waitForRun(sourceOrdinal, status);
                    if (!queued) {
                      yield* dispatch("target", "Continue", targetSelection);
                    }
                    yield* waitForRun(sourceOrdinal + 1, "completed");
                    const projection = yield* orchestrator.getThreadProjection(threadId);
                    const targetRun = projection.runs.at(-1)!;
                    const handoff = projection.contextHandoffs.find(
                      (candidate) => candidate.id === targetRun.contextHandoffId,
                    );
                    assert.isDefined(handoff);
                    assert.equal(
                      handoff?.strategy,
                      returning ? "delta_since_target_last_seen" : "full_thread_summary",
                    );
                    assert.deepEqual(handoff?.coveredRunOrdinals, {
                      from: sourceOrdinal,
                      to: sourceOrdinal,
                    });
                    const delivered = (yield* Ref.get(capturedTurns)).at(-1)!;
                    const history = yield* Ref.get(injectedHistory);
                    const deliveredHistory = native ? yield* encodeJson(history) : delivered.text;
                    assert.include(deliveredHistory, originalPrompt);
                    assert.include(deliveredHistory, partialResponse);
                    assert.include(deliveredHistory, `run-status=${status}`);
                    if (native) {
                      assert.equal(delivered.text, "Continue");
                      assert.notInclude(deliveredHistory, '"text":"Continue"');
                      assert.include(deliveredHistory, '"role":"assistant"');
                      assert.include(deliveredHistory, '"role":"user"');
                      assert.equal(handoff?.delivery?.status, "injected");
                    } else {
                      assert.include(delivered.text, "User message:\nContinue");
                      assert.equal(handoff?.delivery?.status, "inline");
                    }
                    assert.notInclude(deliveredHistory, "Earlier successful request.");
                    // The returning source already has its own failed/interrupted native turn.
                    yield* dispatch("back", "Finish the remaining work", sourceSelection);
                    yield* waitForRun(sourceOrdinal + 2, "completed");
                    const back = (yield* Ref.get(capturedTurns)).at(-1)!;
                    assert.notInclude(back.text, originalPrompt);
                    assert.notInclude(back.text, partialResponse);
                  }).pipe(
                    Effect.provide(
                      makeOrchestratorV2ReplayLayerWithRegistry(
                        {
                          name: `handoff-${status}-${queued}-${returning}`,
                          runtimePolicyOverride: {
                            cwd,
                            approvalPolicy: "never",
                            sandboxPolicy: {
                              type: "readOnly",
                              access: { type: "fullAccess" },
                              networkAccess: false,
                            },
                          },
                        },
                        registryLayer,
                      ),
                    ),
                  );
                }),
              ),
          );
        }
      }
    }
  }

  it.live("checks the queued provider's capability while the current provider stays running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const scenario of [
          { activeSupportsQueue: false, selectedSupportsQueue: true },
          { activeSupportsQueue: true, selectedSupportsQueue: false },
        ]) {
          const key = `active-${scenario.activeSupportsQueue}-selected-${scenario.selectedSupportsQueue}`;
          const cwd = yield* checkpointWorkspace(`queued-capability-${key}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const started = yield* Deferred.make<void>();
          const scenarioThreadId = ThreadId.make(`thread:queued-capability:${key}`);
          const registryLayer = makeProviderAdapterRegistryLayer([
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: {
                ...CodexProviderCapabilitiesV2,
                turns: {
                  ...CodexProviderCapabilitiesV2.turns,
                  supportsQueuedMessages: scenario.activeSupportsQueue,
                },
              },
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              holdFirstTurn: started,
            }),
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: {
                ...ClaudeProviderCapabilitiesV2,
                turns: {
                  ...ClaudeProviderCapabilitiesV2.turns,
                  supportsQueuedMessages: scenario.selectedSupportsQueue,
                },
              },
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-capability:create:${key}`),
              threadId: scenarioThreadId,
              projectId: ProjectId.make(`project:queued-capability:${key}`),
              title: "Queued capability",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-capability:first:${key}`),
              threadId: scenarioThreadId,
              messageId: MessageId.make(`message:queued-capability:first:${key}`),
              text: "Current Codex turn",
              attachments: [],
              modelSelection: CODEX_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            });
            yield* Deferred.await(started);
            yield* worker.drain();
            const queue = orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-capability:claude:${key}`),
              threadId: scenarioThreadId,
              messageId: MessageId.make(`message:queued-capability:claude:${key}`),
              text: "Queued Claude turn",
              attachments: [],
              modelSelection: CLAUDE_MODEL_SELECTION,
              dispatchMode: { type: "queue_after_active" },
            });
            if (scenario.selectedSupportsQueue) {
              yield* queue;
            } else {
              const error = yield* queue.pipe(Effect.flip);
              assert.instanceOf(error, OrchestratorDispatchError);
              assert.instanceOf(error.cause, CommandPolicyCapabilityUnsupportedError);
              assert.equal(error.cause.capability, "queued_messages");
            }
            const projection = yield* orchestrator.getThreadProjection(scenarioThreadId);
            assert.deepEqual(
              projection.runs.map((run) => run.status),
              scenario.selectedSupportsQueue ? ["running", "queued"] : ["running"],
            );
            assert.deepEqual(projection.thread.modelSelection, CODEX_MODEL_SELECTION);
          }).pipe(
            Effect.provide(
              makeOrchestratorV2ReplayLayerWithRegistry(
                {
                  name: `queued-capability-${key}`,
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: {
                      type: "readOnly",
                      access: { type: "fullAccess" },
                      networkAccess: false,
                    },
                  },
                },
                registryLayer,
              ),
            ),
          );
        }
      }),
    ),
  );

  it.live("hands completed Grok steering context to earlier queued Codex and later Claude", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-steer-provider-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const registryLayer = makeProviderAdapterRegistryLayer([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 2: "Codex queued response" },
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 3: "Claude queued response" },
            capturedTurns,
          }),
          makeTestAdapter({
            instanceId: GROK_MODEL_SELECTION.instanceId,
            driver: GROK_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            modelSelection: GROK_MODEL_SELECTION,
            responseByRunOrdinal: { 1: "Grok steered response" },
            capturedTurns,
          }),
        ]);
        const queuedThreadId = ThreadId.make("thread:queued-steer-provider-switch");
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSinkV2;
          const dispatch = (
            key: string,
            modelSelection: ModelSelection,
            dispatchMode: Extract<
              OrchestrationV2Command,
              { readonly type: "message.dispatch" }
            >["dispatchMode"],
          ) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-steer-provider-switch:${key}`),
              threadId: queuedThreadId,
              messageId: MessageId.make(`message:queued-steer-provider-switch:${key}`),
              text: `Prompt ${key}`,
              attachments: [],
              modelSelection,
              dispatchMode,
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-steer-provider-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-steer-provider-switch"),
            title: "Queued steer provider switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* dispatch("first", CODEX_MODEL_SELECTION, { type: "start_immediately" });
          yield* Deferred.await(started);
          yield* worker.drain();
          yield* dispatch("codex-queued", CODEX_MODEL_SELECTION, { type: "queue_after_active" });
          yield* dispatch("claude-queued", CLAUDE_MODEL_SELECTION, { type: "queue_after_active" });
          const beforeSteer = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            beforeSteer.runs.map((run) => run.status),
            ["running", "queued", "queued"],
          );
          assert.equal(beforeSteer.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          assert.lengthOf(beforeSteer.contextHandoffs, 0);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-steer-provider-switch:first-turn-running"),
                type: "provider-turn.updated",
                threadId: queuedThreadId,
                runId: beforeSteer.runs[0]!.id,
                nodeId: beforeSteer.runs[0]!.rootNodeId!,
                driver: CODEX_DRIVER,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make("provider-turn:queued-steer-provider-switch:first"),
                  providerThreadId: beforeSteer.runs[0]!.providerThreadId!,
                  nodeId: beforeSteer.runs[0]!.rootNodeId!,
                  runAttemptId: beforeSteer.runs[0]!.activeAttemptId!,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              },
            ],
          });
          const queuedClaudeCompleted = yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === beforeSteer.runs[2]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
          yield* dispatch("grok-steer", GROK_MODEL_SELECTION, {
            type: "steer_active",
            targetRunId: beforeSteer.runs[0]!.id,
          });
          const afterSteer = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(afterSteer.thread.modelSelection, GROK_MODEL_SELECTION);
          const interruptedTurn = afterSteer.providerTurns.find(
            (turn) => turn.runAttemptId === beforeSteer.runs[0]?.activeAttemptId,
          )!;
          const interruptedAttempt = afterSteer.attempts.find(
            (attempt) => attempt.id === beforeSteer.runs[0]?.activeAttemptId,
          )!;
          const interruptedAt = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-steer-provider-switch:first-turn-interrupted"),
                type: "provider-turn.updated",
                threadId: queuedThreadId,
                runId: beforeSteer.runs[0]!.id,
                nodeId: beforeSteer.runs[0]!.rootNodeId!,
                driver: CODEX_DRIVER,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: interruptedAt,
                payload: {
                  ...interruptedTurn,
                  status: "interrupted",
                  completedAt: interruptedAt,
                },
              },
              {
                id: EventId.make("event:queued-steer-provider-switch:first-attempt-interrupted"),
                type: "run-attempt.updated",
                threadId: queuedThreadId,
                runId: beforeSteer.runs[0]!.id,
                nodeId: beforeSteer.runs[0]!.rootNodeId!,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: interruptedAt,
                payload: {
                  ...interruptedAttempt,
                  status: "interrupted",
                  completedAt: interruptedAt,
                },
              },
            ],
          });
          yield* worker.drain();
          yield* Fiber.join(queuedClaudeCompleted);
          return yield* orchestrator.getThreadProjection(queuedThreadId);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "queued-steer-provider-switch",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              registryLayer,
            ),
          ),
        );
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [GROK_MODEL_SELECTION.instanceId, "completed"],
            [CODEX_MODEL_SELECTION.instanceId, "completed"],
            [CLAUDE_MODEL_SELECTION.instanceId, "completed"],
          ],
        );
        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          turns.map((turn) => turn.driver),
          [CODEX_DRIVER, GROK_DRIVER, CODEX_DRIVER, CLAUDE_DRIVER],
        );
        assert.include(turns[2]?.text ?? "", "Grok steered response");
        assert.include(turns[3]?.text ?? "", "Grok steered response");
        assert.include(turns[3]?.text ?? "", "Codex queued response");
        assert.deepEqual(
          projection.contextHandoffs.map((handoff) => handoff.targetRunId),
          [projection.runs[0]?.id, projection.runs[1]?.id, projection.runs[2]?.id],
        );
      }),
    ),
  );

  it.live("resumes a queued account switch without requiring a portable handoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-account-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const alternateSelection: ModelSelection = {
          ...CODEX_MODEL_SELECTION,
          instanceId: ProviderInstanceId.make("codex-alternate"),
        };
        const alternateCapabilities = {
          ...CodexProviderCapabilitiesV2,
          canConsumeHandoffSummaries: false,
        };
        const adapters = [
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: alternateSelection.instanceId,
            driver: CODEX_DRIVER,
            capabilities: alternateCapabilities,
            modelSelection: alternateSelection,
            responseByRunOrdinal: { 2: "Alternate account complete" },
            capturedTurns,
          }),
        ];
        const registryLayer = Layer.succeed(
          ProviderAdapterRegistryV2,
          ProviderAdapterRegistryV2.of({
            get: (instanceId) => {
              const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
              return adapter === undefined
                ? Effect.fail(new ProviderAdapterRegistryLookupError({ instanceId }))
                : Effect.succeed(adapter);
            },
            list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
            getMetadata: (instanceId) => {
              const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
              return adapter === undefined
                ? Effect.fail(new ProviderAdapterRegistryLookupError({ instanceId }))
                : Effect.succeed({
                    driver: CODEX_DRIVER,
                    continuationKey: "codex:shared-native-account-history",
                    enabled: true,
                    capabilities:
                      instanceId === alternateSelection.instanceId
                        ? alternateCapabilities
                        : CodexProviderCapabilitiesV2,
                  });
            },
          }),
        );
        const queuedThreadId = ThreadId.make("thread:queued-account-switch");
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const eventSink = yield* EventSinkV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-account-switch"),
            title: "Queued account switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:first"),
            threadId: queuedThreadId,
            messageId: MessageId.make("message:queued-account-switch:first"),
            text: "First account turn",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Deferred.await(started);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:second"),
            threadId: queuedThreadId,
            messageId: MessageId.make("message:queued-account-switch:second"),
            text: "Alternate account turn",
            attachments: [],
            modelSelection: alternateSelection,
            dispatchMode: { type: "queue_after_active" },
          });
          const queued = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued"],
          );
          assert.equal(queued.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          const sourceNativeRef = queued.providerThreads.find(
            (providerThread) => providerThread.id === queued.runs[0]?.providerThreadId,
          )?.nativeThreadRef;
          assert.isNotNull(sourceNativeRef);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-account-switch:first-complete"),
                type: "run.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[1]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const delivered = yield* orchestrator.getThreadProjection(queuedThreadId);
          const targetNativeRef = delivered.providerThreads.find(
            (providerThread) => providerThread.id === delivered.runs[1]?.providerThreadId,
          )?.nativeThreadRef;
          assert.deepEqual(targetNativeRef, sourceNativeRef);
          return delivered;
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "queued-account-switch",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              registryLayer,
            ),
          ),
        );
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [CODEX_MODEL_SELECTION.instanceId, "completed"],
            [alternateSelection.instanceId, "completed"],
          ],
        );
        assert.lengthOf(projection.contextHandoffs, 0);
        assert.deepEqual(
          (yield* Ref.get(capturedTurns)).map((turn) => turn.text),
          ["First account turn", "Alternate account turn"],
        );
      }),
    ),
  );

  it.live("finishes earlier queued Codex turns before handing context to queued Claude", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-provider-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const registryLayer = makeProviderAdapterRegistryLayer([
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("codex"),
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {
              1: "Codex current turn complete",
              2: "Codex first queued turn complete",
              3: "Codex second queued turn complete",
            },
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 4: "Claude turn complete" },
            capturedTurns,
          }),
        ]);
        const queuedThreadId = ThreadId.make("thread:queued-provider-switch");
        const databaseLayer = SqlitePersistenceMemory;
        const outboxProvided = effectOutboxLayer.pipe(Layer.provide(databaseLayer));
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSinkV2;
          const effectOutbox = yield* EffectOutboxV2;
          const dispatch = (ordinal: number, modelSelection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-provider-switch:${ordinal}`),
              threadId: queuedThreadId,
              messageId: MessageId.make(`message:queued-provider-switch:${ordinal}`),
              text: `Prompt ${ordinal}`,
              attachments: [],
              modelSelection,
              dispatchMode: {
                type: ordinal === 1 ? "start_immediately" : "queue_after_active",
              },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-provider-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-provider-switch"),
            title: "Queued provider switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* dispatch(1, CODEX_MODEL_SELECTION);
          yield* Deferred.await(started);
          yield* dispatch(2, CODEX_MODEL_SELECTION);
          yield* dispatch(3, CODEX_MODEL_SELECTION);
          yield* dispatch(4, CLAUDE_MODEL_SELECTION);
          const queued = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued", "queued", "queued"],
          );
          assert.equal(queued.thread.activeProviderThreadId, queued.runs[0]?.providerThreadId);
          assert.equal(queued.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          assert.lengthOf(queued.contextHandoffs, 0);
          const activeSession = queued.providerSessions.find(
            (session) => session.providerInstanceId === CODEX_MODEL_SELECTION.instanceId,
          );
          assert.isDefined(activeSession);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              ...(["stopped", "error"] as const).map((status) => ({
                id: EventId.make(`event:queued-provider-switch:dead-session:${status}`),
                type: "provider-session.updated" as const,
                threadId: queuedThreadId,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  ...activeSession!,
                  id: ProviderSessionId.make(`provider-session:queued-provider-switch:${status}`),
                  status,
                },
              })),
              {
                id: EventId.make("event:queued-provider-switch:first-response"),
                type: "turn-item.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                nodeId: queued.runs[0]!.rootNodeId!,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("turn-item:queued-provider-switch:first-response"),
                  threadId: queuedThreadId,
                  runId: queued.runs[0]!.id,
                  nodeId: queued.runs[0]!.rootNodeId!,
                  providerThreadId: queued.runs[0]!.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 101,
                  status: "completed",
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "assistant_message",
                  messageId: MessageId.make("message:queued-provider-switch:first-response"),
                  text: "Codex current turn complete",
                  streaming: false,
                },
              },
              {
                id: EventId.make("event:queued-provider-switch:first-complete"),
                type: "run.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[3]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const detachEvents = yield* eventSink.stream({ threadId: queuedThreadId }).pipe(
            Stream.filter((stored) => stored.event.type === "provider-session.detached"),
            Stream.take(1),
            Stream.runCollect,
          );
          assert.equal(
            detachEvents[0]?.event.type === "provider-session.detached"
              ? detachEvents[0].event.payload.providerSessionId
              : null,
            activeSession?.id,
          );
          const startCommandId = CommandId.make(
            `command:system:start-queued:${queued.runs[3]!.id}`,
          );
          const detachEffects = (yield* effectOutbox.listByCommandId(startCommandId)).filter(
            (effect) => effect.request.type === "provider-session.detach",
          );
          assert.deepEqual(
            detachEffects.map((effect) =>
              effect.request.type === "provider-session.detach"
                ? effect.request.providerSessionId
                : null,
            ),
            [activeSession?.id],
          );
          return yield* orchestrator.getThreadProjection(queuedThreadId);
        }).pipe(
          Effect.provide(
            Layer.merge(
              makeOrchestratorV2ReplayLayerWithRegistry(
                {
                  name: "queued-provider-switch",
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: {
                      type: "readOnly",
                      access: { type: "fullAccess" },
                      networkAccess: false,
                    },
                  },
                },
                registryLayer,
                { databaseLayer },
              ),
              outboxProvided,
            ),
          ),
        );
        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            ["codex", "completed"],
            ["codex", "completed"],
            ["codex", "completed"],
            ["claudeAgent", "completed"],
          ],
        );
        assert.deepEqual(
          turns.map((turn) => [turn.driver, turn.text.includes("Prompt 4")]),
          [
            ["codex", false],
            ["codex", false],
            ["codex", false],
            ["claudeAgent", true],
          ],
        );
        assert.lengthOf(projection.contextHandoffs, 1);
        assert.equal(projection.contextHandoffs[0]?.targetRunId, projection.runs[3]?.id);
        const handoffItem = projection.turnItems.find(
          (item) => item.type === "handoff" && item.runId === projection.runs[3]?.id,
        );
        assert.equal(
          handoffItem?.type === "handoff" ? handoffItem.contextHandoffId : null,
          projection.contextHandoffs[0]?.id,
        );
        const queuedUserItem = projection.turnItems.find(
          (item) => item.type === "user_message" && item.runId === projection.runs[3]?.id,
        );
        assert.isBelow(handoffItem?.ordinal ?? Infinity, queuedUserItem?.ordinal ?? -Infinity);
        assert.include(
          handoffItem?.type === "handoff" ? handoffItem.summary : "",
          "Codex second queued turn complete",
        );
        assert.include(turns[3]?.text ?? "", "Codex current turn complete");
        assert.include(turns[3]?.text ?? "", "Codex first queued turn complete");
        assert.include(turns[3]?.text ?? "", "Codex second queued turn complete");
      }),
    ),
  );

  it.live("fails an unsupported queued handoff and advances to the next queued provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-handoff-rejection");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const rejectedThreadId = ThreadId.make("thread:queued-handoff-rejection");
        const rejectedMessageId = MessageId.make("message:queued-handoff-rejection:claude");
        const unsupportedClaudeCapabilities = {
          ...ClaudeProviderCapabilitiesV2,
          context: {
            ...ClaudeProviderCapabilitiesV2.context,
            canConsumeHandoffSummaries: false,
          },
        };
        const registryLayer = makeProviderAdapterRegistryLayer([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 3: "Later Codex queued turn complete" },
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: unsupportedClaudeCapabilities,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
          }),
        ]);
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const eventSink = yield* EventSinkV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:create"),
            threadId: rejectedThreadId,
            projectId: ProjectId.make("project:queued-handoff-rejection"),
            title: "Queued handoff rejection",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:first"),
            threadId: rejectedThreadId,
            messageId: MessageId.make("message:queued-handoff-rejection:first"),
            text: "First Codex turn",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Deferred.await(started);
          const active = yield* orchestrator.getThreadProjection(rejectedThreadId);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-handoff-rejection:existing-item"),
                type: "turn-item.updated",
                threadId: rejectedThreadId,
                runId: active.runs[0]!.id,
                nodeId: active.runs[0]!.rootNodeId!,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("turn-item:queued-handoff-rejection:existing-item"),
                  threadId: rejectedThreadId,
                  runId: active.runs[0]!.id,
                  nodeId: active.runs[0]!.rootNodeId!,
                  providerThreadId: active.runs[0]!.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 150,
                  status: "completed",
                  title: null,
                  inputIntent: "turn_start",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "user_message",
                  messageId: rejectedMessageId,
                  text: "Unsupported Claude turn",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:claude"),
            threadId: rejectedThreadId,
            messageId: rejectedMessageId,
            text: "Unsupported Claude turn",
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "queue_after_active" },
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:later"),
            threadId: rejectedThreadId,
            messageId: MessageId.make("message:queued-handoff-rejection:later"),
            text: "Later Codex turn",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "queue_after_active" },
          });
          const queued = yield* orchestrator.getThreadProjection(rejectedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued", "queued"],
          );
          const queuedItem = queued.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === rejectedMessageId,
          );
          assert.equal(queuedItem?.runId, queued.runs[1]?.id);
          assert.equal(queuedItem?.providerThreadId, queued.runs[1]?.providerThreadId);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-handoff-rejection:first-complete"),
                type: "run.updated",
                threadId: rejectedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[2]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          return yield* orchestrator.getThreadProjection(rejectedThreadId);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "queued-handoff-rejection",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              registryLayer,
            ),
          ),
        );
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed", "failed", "completed"],
        );
        assert.equal(projection.runs[1]?.queuePosition, null);
        assert.equal(
          projection.attempts.find((attempt) => attempt.runId === projection.runs[1]?.id)?.status,
          "failed",
        );
        assert.equal(
          projection.nodes.find((node) => node.runId === projection.runs[1]?.id)?.status,
          "failed",
        );
        assert.equal(projection.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
        assert.lengthOf(projection.contextHandoffs, 1);
        assert.include((yield* Ref.get(capturedTurns)).at(-1)!.text, "Unsupported Claude turn");
        const failureItem = projection.turnItems.find(
          (item) => item.type === "error" && item.runId === projection.runs[1]?.id,
        );
        assert.equal(
          failureItem?.type === "error" ? failureItem.failure.code : null,
          "context_handoff_unsupported",
        );
        assert.deepEqual(
          (yield* Ref.get(capturedTurns)).map((turn) => turn.driver),
          [CODEX_DRIVER, CODEX_DRIVER],
        );
      }),
    ),
  );

  const importedFailureScenario = (queueBeforeFailure: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const importedThreadId = ThreadId.make("thread:provider-switch:legacy-import");
        const importedProjectId = ProjectId.make("project:provider-switch:legacy-import");
        const failedPrompt = "This first provider attempt should fail.";
        const recoveryPrompt = "What was the imported release marker?";
        const cwd = yield* checkpointWorkspace("provider-switch-legacy-import");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const firstTurnStarted = yield* Deferred.make<void>();
        const releaseFirstTurn = yield* Deferred.make<void>();
        const registryLayer = makeProviderAdapterRegistryLayer([
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("codex"),
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            failedRunOrdinals: new Set([1]),
            ...(queueBeforeFailure ? { holdFirstTurn: firstTurnStarted, releaseFirstTurn } : {}),
          }),
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 2: "The imported release marker is violet." },
            capturedTurns,
          }),
        ]);
        const databaseLayer = SqlitePersistenceMemory;
        const eventStoreProvided = eventStoreLayer.pipe(Layer.provideMerge(databaseLayer));
        const projectionStoreProvided = projectionStoreLayer.pipe(
          Layer.provideMerge(databaseLayer),
        );
        const storesProvided = Layer.mergeAll(
          databaseLayer,
          eventStoreProvided,
          projectionStoreProvided,
        );
        const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesProvided));
        const importerProvided = legacyV1ThreadImporterLayer.pipe(
          Layer.provide(Layer.mergeAll(storesProvided, eventSinkProvided)),
        );
        const maintenanceProvided = projectionMaintenanceLayer.pipe(Layer.provide(storesProvided));
        const orchestratorProvided = makeOrchestratorV2ReplayLayerWithRegistry(
          {
            name: "provider-switch-legacy-import",
            runtimePolicyOverride: {
              cwd,
              approvalPolicy: "never",
              sandboxPolicy: {
                type: "readOnly",
                access: { type: "fullAccess" },
                networkAccess: false,
              },
            },
          },
          registryLayer,
          { databaseLayer },
        );
        const testLayer = Layer.mergeAll(
          storesProvided,
          importerProvided,
          maintenanceProvided,
          orchestratorProvided,
        );

        const projection = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const importer = yield* LegacyV1ThreadImporter;
          const maintenance = yield* ProjectionMaintenanceV2;
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;

          yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${importedProjectId},
          'Imported provider switch project',
          ${cwd},
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;
          yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        ) VALUES (
          ${importedThreadId},
          ${importedProjectId},
          'Imported provider switch thread',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          'main',
          ${cwd},
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          NULL
        )
      `;
          yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:provider-switch:legacy-import:user',
            ${importedThreadId},
            NULL,
            'user',
            'Remember that the imported release marker is violet.',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:provider-switch:legacy-import:assistant',
            ${importedThreadId},
            NULL,
            'assistant',
            'I will remember violet.',
            '[]',
            0,
            '2026-01-01T01:01:00.000Z',
            '2026-01-01T01:01:00.000Z'
          )
      `;

          yield* importer.reconcileShells;
          yield* maintenance.rebuild;
          yield* importer.ensureTranscript(importedThreadId);

          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:provider-switch:legacy-import:failed"),
            threadId: importedThreadId,
            messageId: MessageId.make("message:provider-switch:legacy-import:failed"),
            text: failedPrompt,
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          if (queueBeforeFailure) {
            yield* Deferred.await(firstTurnStarted);
          } else {
            yield* waitForIdle(importedThreadId);
          }
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:provider-switch:legacy-import:recovery"),
            threadId: importedThreadId,
            messageId: MessageId.make("message:provider-switch:legacy-import:recovery"),
            text: recoveryPrompt,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: {
              type: queueBeforeFailure ? "queue_after_active" : "start_immediately",
            },
          });
          if (queueBeforeFailure) {
            const queued = yield* orchestrator.getThreadProjection(importedThreadId);
            assert.deepEqual(
              queued.runs.map((run) => run.status),
              ["running", "queued"],
            );
            assert.deepEqual(
              queued.contextHandoffs.map((handoff) => handoff.targetRunId),
              [queued.runs[0]?.id],
            );
            yield* Deferred.succeed(releaseFirstTurn, undefined);
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                (event) =>
                  event.event.type === "run.updated" &&
                  event.event.runId === queued.runs[1]?.id &&
                  event.event.payload.status === "completed",
              ),
              Stream.runHead,
            );
            yield* worker.drain();
          } else {
            yield* waitForIdle(importedThreadId);
          }
          const beforeRebuild = yield* orchestrator.getThreadProjection(importedThreadId);
          for (const attempt of beforeRebuild.attempts) {
            const nativeId = beforeRebuild.providerThreads.find(
              (thread) => thread.id === attempt.providerThreadId,
            )?.nativeThreadRef?.nativeId;
            assert.isDefined(nativeId);
            assert.equal(attempt.nativeThreadId, nativeId);
          }
          yield* maintenance.rebuild;
          const rebuilt = yield* orchestrator.getThreadProjection(importedThreadId);
          assert.deepEqual(rebuilt.attempts, beforeRebuild.attempts);
          return rebuilt;
        }).pipe(Effect.provide(testLayer));

        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            ["codex", "failed"],
            ["claudeAgent", "completed"],
          ],
        );
        assert.sameDeepMembers(
          projection.contextHandoffs.map((handoff) => [
            handoff.targetRunId,
            handoff.strategy,
            handoff.status,
          ]),
          [
            [projection.runs[0]?.id, "manual_context", "ready"],
            [projection.runs[1]?.id, "manual_context", "ready"],
            [projection.runs[1]?.id, "full_thread_summary", "ready"],
          ],
        );
        const recoveryHandoff = projection.contextHandoffs.find(
          (handoff) => handoff.id === projection.runs[1]?.contextHandoffId,
        );
        assert.equal(recoveryHandoff?.strategy, "full_thread_summary");
        assert.include(recoveryHandoff?.summaryText ?? "", failedPrompt);
        if (queueBeforeFailure) {
          const handoffItem = projection.turnItems.find(
            (item) => item.type === "handoff" && item.runId === projection.runs[1]?.id,
          );
          assert.equal(
            handoffItem?.type === "handoff" ? handoffItem.contextHandoffId : null,
            recoveryHandoff?.id,
          );
        }
        assert.include(turns[1]?.text ?? "", "Context handoff (manual_context):");
        assert.include(turns[1]?.text ?? "", "imported release marker is violet");
        assert.include(turns[1]?.text ?? "", "I will remember violet.");
        assert.include(turns[1]?.text ?? "", recoveryPrompt);
        assert.include(turns[1]?.text ?? "", failedPrompt);
      }),
    );

  it.live("reissues imported v1 context when switching after the first provider fails", () =>
    importedFailureScenario(false),
  );
  it.live(
    "reissues imported v1 context when a queued provider starts after the first provider fails",
    () => importedFailureScenario(true),
  );

  it.live("uses portable fallback when native resume fails after a provider switch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("provider-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const codexNativeThreadGeneration = yield* Ref.make(0);
        const registryLayer = makeProviderAdapterRegistryLayer([
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("codex"),
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {
              1: "codex before switch",
              3: "codex after return",
            },
            capturedTurns,
            failResume: true,
            nativeThreadGeneration: codexNativeThreadGeneration,
          }),
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 2: "claude switched response" },
            capturedTurns,
          }),
        ]);
        const commands = [
          {
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:provider-switch:create"),
            threadId,
            projectId,
            title: "Provider switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:provider-switch:codex"),
            threadId,
            messageId: MessageId.make("message:provider-switch:codex"),
            text: firstPrompt,
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:provider-switch:claude"),
            threadId,
            messageId: MessageId.make("message:provider-switch:claude"),
            text: claudePrompt,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:provider-switch:return"),
            threadId,
            messageId: MessageId.make("message:provider-switch:return"),
            text: returnPrompt,
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
        ] satisfies ReadonlyArray<OrchestrationV2Command>;

        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          yield* orchestrator.dispatch(commands[0]!);
          yield* orchestrator.dispatch(commands[1]!);
          yield* waitForIdle(threadId);
          yield* orchestrator.dispatch(commands[2]!);
          assert.deepEqual(
            (yield* orchestrator.getThreadProjection(threadId)).thread.modelSelection,
            CLAUDE_MODEL_SELECTION,
          );
          yield* waitForIdle(threadId);
          // Stopping the shared Codex process drops its loaded native thread, so
          // returning to Codex has to resume it (and fall back when that fails).
          const codexSession = (yield* orchestrator.getThreadProjection(
            threadId,
          )).providerSessions.find(
            (session) => session.providerInstanceId === CODEX_MODEL_SELECTION.instanceId,
          )!;
          yield* orchestrator.dispatch({
            type: "provider-session.detach",
            commandId: CommandId.make("command:provider-switch:stop-codex"),
            threadId,
            providerSessionId: codexSession.id,
          });
          yield* (yield* OrchestrationEffectWorkerV2).drain();
          yield* orchestrator.dispatch(commands[3]!);
          assert.deepEqual(
            (yield* orchestrator.getThreadProjection(threadId)).thread.modelSelection,
            CODEX_MODEL_SELECTION,
          );
          return yield* waitForIdle(threadId);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "provider-switch",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              registryLayer,
            ),
          ),
        );
        const turns = yield* Ref.get(capturedTurns);

        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            ["codex", "completed"],
            ["claudeAgent", "completed"],
            ["codex", "completed"],
          ],
        );
        assert.lengthOf(projection.providerThreads, 2);
        assert.equal(projection.runs[0]?.providerThreadId, projection.runs[2]?.providerThreadId);
        assert.notEqual(projection.runs[0]?.providerThreadId, projection.runs[1]?.providerThreadId);
        // The failed resume bound a fresh native Codex thread to the same row.
        assert.equal(yield* Ref.get(codexNativeThreadGeneration), 2);
        const codexThread = projection.providerThreads.find(
          (providerThread) => providerThread.id === projection.runs[2]?.providerThreadId,
        );
        assert.equal(codexThread?.nativeThreadRef?.nativeId, `codex:${threadId}:1`);
        assert.deepEqual(
          projection.contextHandoffs.map((handoff) => [
            handoff.strategy,
            handoff.coveredRunOrdinals,
            handoff.delivery?.status,
            handoff.delivery?.nativeThreadId,
          ]),
          [
            ["full_thread_summary", { from: 1, to: 1 }, "inline", `claudeAgent:${threadId}`],
            ["delta_since_target_last_seen", { from: 2, to: 2 }, "inline", `codex:${threadId}:1`],
            ["full_thread_summary", { from: 1, to: 2 }, "inline", `codex:${threadId}:1`],
          ],
        );
        assert.deepEqual(
          projection.contextTransfers.map((transfer) => [
            transfer.type,
            transfer.status,
            transfer.resolution?.strategy,
          ]),
          [
            ["provider_handoff", "consumed", "portable_context"],
            ["provider_handoff", "consumed", "delta_context"],
            ["provider_handoff", "resolved_portable", "portable_context"],
          ],
        );
        assert.deepEqual(
          projection.turnItems
            .filter((item) => item.type === "user_message")
            .map((item) => item.text),
          [firstPrompt, claudePrompt, returnPrompt],
        );
        assert.deepEqual(
          projection.providerThreads.map((providerThread) => [
            providerThread.driver,
            providerThread.status,
            providerThread.handoffIds.length,
          ]),
          [
            ["codex", "idle", 1],
            ["claudeAgent", "idle", 1],
          ],
        );
        assert.equal(turns[0]?.text, firstPrompt);
        assert.include(turns[1]?.text ?? "", "Context handoff (full_thread_summary):");
        assert.include(turns[1]?.text ?? "", "codex before switch");
        assert.include(turns[1]?.text ?? "", claudePrompt);
        // The fresh native thread has none of the earlier Codex turn, so the
        // portable fallback re-sends it alongside the Claude delta.
        assert.include(turns[2]?.text ?? "", "Context handoff (full_thread_summary):");
        assert.include(turns[2]?.text ?? "", "Context handoff (delta_since_target_last_seen):");
        assert.include(turns[2]?.text ?? "", "codex before switch");
        assert.include(turns[2]?.text ?? "", "claude switched response");
        assert.include(turns[2]?.text ?? "", returnPrompt);
        assert.equal(turns[0]?.providerThreadId, turns[2]?.providerThreadId);
      }),
    ),
  );

  it.live("resolves a Claude fork into portable Codex context on first dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sourceThreadId = ThreadId.make("thread:cross-provider-fork:source");
        const targetThreadId = ThreadId.make("thread:cross-provider-fork:target");
        const sourcePrompt = "Remember that the release color is violet.";
        const targetPrompt = "What release color did we choose?";
        const cwd = yield* checkpointWorkspace("cross-provider-fork");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const registryLayer = makeProviderAdapterRegistryLayer([
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("codex"),
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 1: "The release color is violet." },
            capturedTurns,
          }),
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 1: "I will remember violet." },
            capturedTurns,
          }),
        ]);
        const commands = [
          {
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cross-provider-fork:create"),
            threadId: sourceThreadId,
            projectId,
            title: "Cross-provider fork source",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cross-provider-fork:source"),
            threadId: sourceThreadId,
            messageId: MessageId.make("message:cross-provider-fork:source"),
            text: sourcePrompt,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cross-provider-fork:fork"),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "latest_stable" },
            title: "Cross-provider fork target",
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cross-provider-fork:target"),
            threadId: targetThreadId,
            messageId: MessageId.make("message:cross-provider-fork:target"),
            text: targetPrompt,
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
        ] satisfies ReadonlyArray<OrchestrationV2Command>;

        const targetProjection = yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          yield* orchestrator.dispatch(commands[0]!);
          yield* orchestrator.dispatch(commands[1]!);
          yield* waitForIdle(sourceThreadId);
          yield* orchestrator.dispatch(commands[2]!);
          yield* orchestrator.dispatch(commands[3]!);
          return yield* waitForIdle(targetThreadId);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "cross-provider-fork",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              registryLayer,
            ),
          ),
        );
        const turns = yield* Ref.get(capturedTurns);
        const targetTurn = turns.find((turn) => turn.threadId === targetThreadId);

        assert.deepEqual(
          targetProjection.runs.map((run) => [run.providerInstanceId, run.status]),
          [["codex", "completed"]],
        );
        assert.lengthOf(targetProjection.providerThreads, 1);
        assert.equal(targetProjection.providerThreads[0]?.driver, "codex");
        assert.isNull(targetProjection.providerThreads[0]?.forkedFrom);
        assert.deepEqual(
          targetProjection.contextTransfers.map((transfer) => [
            transfer.type,
            transfer.status,
            transfer.resolution?.strategy,
          ]),
          [["fork", "consumed", "portable_context"]],
        );
        assert.deepEqual(
          targetProjection.contextHandoffs.map((handoff) => handoff.strategy),
          ["full_thread_summary"],
        );
        assert.equal(
          targetProjection.runs[0]?.contextHandoffId,
          targetProjection.contextHandoffs[0]?.id,
        );
        assert.include(targetTurn?.text ?? "", "Context handoff (full_thread_summary):");
        assert.include(targetTurn?.text ?? "", sourcePrompt);
        assert.include(targetTurn?.text ?? "", "I will remember violet.");
        assert.include(targetTurn?.text ?? "", targetPrompt);
      }),
    ),
  );

  it.live("resolves a same-provider Cursor fork with portable context", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sourceThreadId = ThreadId.make("thread:cursor-portable-fork:source");
        const targetThreadId = ThreadId.make("thread:cursor-portable-fork:target");
        const sourcePrompt = "Remember that the deployment marker is indigo.";
        const sourceResponse = "I will remember indigo.";
        const targetPrompt = "What deployment marker did we choose?";
        const cwd = yield* checkpointWorkspace("cursor-portable-fork");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const registryLayer = makeProviderAdapterRegistryLayer([
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("cursor"),
            driver: CURSOR_DRIVER,
            capabilities: CursorProviderCapabilitiesV2,
            modelSelection: CURSOR_MODEL_SELECTION,
            responseByRunOrdinal: {},
            responseByThreadId: {
              [sourceThreadId]: { 1: sourceResponse },
              [targetThreadId]: { 1: "The deployment marker is indigo." },
            },
            capturedTurns,
          }),
        ]);
        const commands = [
          {
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cursor-portable-fork:create"),
            threadId: sourceThreadId,
            projectId,
            title: "Cursor portable fork source",
            modelSelection: CURSOR_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cursor-portable-fork:source"),
            threadId: sourceThreadId,
            messageId: MessageId.make("message:cursor-portable-fork:source"),
            text: sourcePrompt,
            attachments: [],
            modelSelection: CURSOR_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cursor-portable-fork:fork"),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "latest_stable" },
            title: "Cursor portable fork target",
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cursor-portable-fork:target"),
            threadId: targetThreadId,
            messageId: MessageId.make("message:cursor-portable-fork:target"),
            text: targetPrompt,
            attachments: [],
            modelSelection: CURSOR_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
        ] satisfies ReadonlyArray<OrchestrationV2Command>;

        const targetProjection = yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          yield* orchestrator.dispatch(commands[0]!);
          yield* orchestrator.dispatch(commands[1]!);
          yield* waitForIdle(sourceThreadId);
          yield* orchestrator.dispatch(commands[2]!);
          yield* orchestrator.dispatch(commands[3]!);
          return yield* waitForIdle(targetThreadId);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "cursor-portable-fork",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              registryLayer,
            ),
          ),
        );
        const turns = yield* Ref.get(capturedTurns);
        const targetTurn = turns.find((turn) => turn.threadId === targetThreadId);

        assert.deepEqual(
          targetProjection.runs.map((run) => [run.providerInstanceId, run.status]),
          [["cursor", "completed"]],
        );
        assert.lengthOf(targetProjection.providerThreads, 1);
        assert.equal(targetProjection.providerThreads[0]?.driver, "cursor");
        assert.isNull(targetProjection.providerThreads[0]?.forkedFrom);
        assert.deepEqual(
          targetProjection.contextTransfers.map((transfer) => [
            transfer.type,
            transfer.status,
            transfer.resolution?.strategy,
          ]),
          [["fork", "consumed", "portable_context"]],
        );
        assert.deepEqual(
          targetProjection.contextHandoffs.map((handoff) => handoff.strategy),
          ["full_thread_summary"],
        );
        assert.include(targetTurn?.text ?? "", "Context handoff (full_thread_summary):");
        assert.include(targetTurn?.text ?? "", sourcePrompt);
        assert.include(targetTurn?.text ?? "", sourceResponse);
        assert.include(targetTurn?.text ?? "", targetPrompt);
      }),
    ),
  );

  for (const failResume of [false, true]) {
    it.live(
      `switches providers while consuming a pending cross-provider merge-back (resume failure: ${failResume})`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const sourceThreadId = ThreadId.make("thread:cross-provider-merge:source");
            const forkThreadId = ThreadId.make("thread:cross-provider-merge:fork");
            const firstSourcePrompt = "Remember that the first source marker is amber.";
            const secondSourcePrompt = "Remember that the second source marker is violet.";
            const forkPrompt = "Remember that the fork marker is cobalt.";
            const mergePrompt = "Report all three remembered markers.";
            const cwd = yield* checkpointWorkspace("cross-provider-merge");
            const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
            const registryLayer = makeProviderAdapterRegistryLayer([
              makeTestAdapter({
                instanceId: ProviderInstanceId.make("codex"),
                driver: CODEX_DRIVER,
                capabilities: CodexProviderCapabilitiesV2,
                modelSelection: CODEX_MODEL_SELECTION,
                responseByRunOrdinal: {},
                responseByThreadId: {
                  [sourceThreadId]: {
                    1: "I will remember amber.",
                    3: "The markers are amber, violet, and cobalt.",
                  },
                  [forkThreadId]: {
                    1: "I will remember cobalt.",
                  },
                },
                capturedTurns,
                failResume,
              }),
              makeTestAdapter({
                instanceId: ProviderInstanceId.make("claudeAgent"),
                driver: CLAUDE_DRIVER,
                capabilities: ClaudeProviderCapabilitiesV2,
                modelSelection: CLAUDE_MODEL_SELECTION,
                responseByRunOrdinal: { 2: "I will remember violet." },
                capturedTurns,
              }),
            ]);
            const commands = [
              {
                type: "thread.create",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cross-provider-merge:create"),
                threadId: sourceThreadId,
                projectId,
                title: "Cross-provider merge source",
                modelSelection: CODEX_MODEL_SELECTION,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
              },
              {
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cross-provider-merge:first-source"),
                threadId: sourceThreadId,
                messageId: MessageId.make("message:cross-provider-merge:first-source"),
                text: firstSourcePrompt,
                attachments: [],
                modelSelection: CODEX_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              },
              {
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cross-provider-merge:second-source"),
                threadId: sourceThreadId,
                messageId: MessageId.make("message:cross-provider-merge:second-source"),
                text: secondSourcePrompt,
                attachments: [],
                modelSelection: CLAUDE_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              },
              {
                type: "thread.fork",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cross-provider-merge:fork"),
                sourceThreadId,
                targetThreadId: forkThreadId,
                sourcePoint: { type: "latest_stable" },
                title: "Cross-provider merge fork",
              },
              {
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cross-provider-merge:fork-turn"),
                threadId: forkThreadId,
                messageId: MessageId.make("message:cross-provider-merge:fork-turn"),
                text: forkPrompt,
                attachments: [],
                modelSelection: CODEX_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              },
              {
                type: "thread.merge_back",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cross-provider-merge:merge"),
                sourceThreadId: forkThreadId,
                targetThreadId: sourceThreadId,
                sourcePoint: { type: "latest_stable" },
              },
              {
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cross-provider-merge:consume"),
                threadId: sourceThreadId,
                messageId: MessageId.make("message:cross-provider-merge:consume"),
                text: mergePrompt,
                attachments: [],
                modelSelection: CODEX_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              },
            ] satisfies ReadonlyArray<OrchestrationV2Command>;

            const projection = yield* Effect.gen(function* () {
              const orchestrator = yield* OrchestratorV2;
              yield* orchestrator.dispatch(commands[0]!);
              yield* orchestrator.dispatch(commands[1]!);
              yield* waitForIdle(sourceThreadId);
              yield* orchestrator.dispatch(commands[2]!);
              yield* waitForIdle(sourceThreadId);
              yield* orchestrator.dispatch(commands[3]!);
              yield* orchestrator.dispatch(commands[4]!);
              yield* waitForIdle(forkThreadId);
              yield* orchestrator.dispatch(commands[5]!);
              if (failResume) {
                // A persisted native ref that is not loaded in this process must
                // exercise resume rather than the session manager's warm cache.
                const beforeResume = yield* orchestrator.getThreadProjection(sourceThreadId);
                const codexThread = beforeResume.providerThreads.find(
                  (thread) => thread.id === beforeResume.runs[0]?.providerThreadId,
                )!;
                yield* (yield* EventSinkV2).write({
                  events: [
                    {
                      id: EventId.make("unloaded-merge-target"),
                      type: "provider-thread.updated",
                      threadId: sourceThreadId,
                      occurredAt: yield* DateTime.now,
                      payload: {
                        ...codexThread,
                        nativeThreadRef: {
                          ...codexThread.nativeThreadRef!,
                          nativeId: "unloaded-native-merge-target",
                        },
                      },
                    },
                  ],
                });
              }
              yield* orchestrator.dispatch(commands[6]!);
              return yield* waitForIdle(sourceThreadId);
            }).pipe(
              Effect.provide(
                makeOrchestratorV2ReplayLayerWithRegistry(
                  {
                    name: "cross-provider-merge",
                    runtimePolicyOverride: {
                      cwd,
                      approvalPolicy: "never",
                      sandboxPolicy: {
                        type: "readOnly",
                        access: { type: "fullAccess" },
                        networkAccess: false,
                      },
                    },
                  },
                  registryLayer,
                ),
              ),
            );
            const turns = yield* Ref.get(capturedTurns);
            const mergedTurn = turns.findLast(
              (turn) => turn.threadId === sourceThreadId && turn.driver === "codex",
            );
            const mergeTransfer = projection.contextTransfers.find(
              (transfer) => transfer.type === "merge_back",
            );

            if (failResume)
              assert.isAtLeast(
                projection.contextHandoffs.filter(
                  (handoff) => handoff.targetRunId === projection.runs.at(-1)?.id,
                ).length,
                2,
              );
            assert.isDefined(mergedTurn);
            if (failResume)
              assert.notEqual(
                projection.providerThreads.find(
                  (thread) => thread.id === mergedTurn.providerThreadId,
                )?.nativeThreadRef?.nativeId,
                "unloaded-native-merge-target",
              );
            assert.include(mergedTurn.text, "Context handoff (full_thread_summary):");
            assert.include(mergedTurn.text, firstSourcePrompt);
            assert.include(mergedTurn.text, "I will remember amber.");
            assert.include(mergedTurn.text, secondSourcePrompt);
            assert.include(mergedTurn.text, "I will remember violet.");
            assert.include(mergedTurn.text, "Context handoff (merge_back / fork_delta_summary):");
            assert.include(mergedTurn.text, forkPrompt);
            assert.include(mergedTurn.text, "I will remember cobalt.");
            assert.include(mergedTurn.text, mergePrompt);
            assert.isDefined(mergeTransfer);
            assert.equal(mergeTransfer.status, "consumed");
            assert.equal(mergeTransfer.targetProviderInstanceId, "codex");
            assert.equal(mergeTransfer.resolution?.strategy, "fork_delta_context");
          }),
        ),
    );
  }

  it.live("routes two custom instances of the same driver independently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const personalThreadId = ThreadId.make("thread:custom-codex-personal");
        const workThreadId = ThreadId.make("thread:custom-codex-work");
        const personalSelection = {
          instanceId: ProviderInstanceId.make("codex_personal"),
          model: "gpt-5.4",
        } satisfies ModelSelection;
        const workSelection = {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5.4",
        } satisfies ModelSelection;
        const cwd = yield* checkpointWorkspace("custom-codex-instances");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const registryLayer = makeProviderAdapterRegistryLayer([
          makeTestAdapter({
            instanceId: personalSelection.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: personalSelection,
            responseByRunOrdinal: { 1: "personal response" },
            capturedTurns,
          }),
          makeTestAdapter({
            instanceId: workSelection.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: workSelection,
            responseByRunOrdinal: { 1: "work response" },
            capturedTurns,
          }),
        ]);

        const [personal, work] = yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          for (const [targetThreadId, selection, suffix] of [
            [personalThreadId, personalSelection, "personal"],
            [workThreadId, workSelection, "work"],
          ] as const) {
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:custom-codex:${suffix}:create`),
              threadId: targetThreadId,
              projectId,
              title: `Custom Codex ${suffix}`,
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:custom-codex:${suffix}:message`),
              threadId: targetThreadId,
              messageId: MessageId.make(`message:custom-codex:${suffix}`),
              text: `${suffix} prompt`,
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
            });
            yield* waitForIdle(targetThreadId);
          }
          return yield* Effect.all([
            orchestrator.getThreadProjection(personalThreadId),
            orchestrator.getThreadProjection(workThreadId),
          ]);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "custom-codex-instances",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              registryLayer,
            ),
          ),
        );

        assert.equal(personal.runs[0]?.providerInstanceId, personalSelection.instanceId);
        assert.equal(
          personal.providerSessions[0]?.providerInstanceId,
          personalSelection.instanceId,
        );
        assert.equal(work.runs[0]?.providerInstanceId, workSelection.instanceId);
        assert.equal(work.providerSessions[0]?.providerInstanceId, workSelection.instanceId);
        assert.notEqual(personal.providerSessions[0]?.id, work.providerSessions[0]?.id);
        assert.deepEqual(
          (yield* Ref.get(capturedTurns)).map((turn) => [turn.threadId, turn.text]),
          [
            [personalThreadId, "personal prompt"],
            [workThreadId, "work prompt"],
          ],
        );
      }),
    ),
  );
});
