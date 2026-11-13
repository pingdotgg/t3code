import { vi } from "vite-plus/test";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
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
  type OrchestrationV2ThreadProjection,
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
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CommandPolicyCapabilityUnsupportedError } from "../CommandPolicy.ts";
import {
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAppendSystemPromptFileError,
  ClaudeBackgroundWorkBlocksQueryReplacementError,
  ClaudeProviderCapabilitiesV2,
} from "../Adapters/ClaudeAdapterV2.ts";
import {
  CodexProviderCapabilitiesV2,
  canReuseCodexContextUsage,
} from "../Adapters/CodexAdapterV2.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "../legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as ProjectionReplay from "./ProjectionReplay.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  GROK_MODEL_SELECTION,
} from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  CLAUDE_DRIVER,
  CODEX_DRIVER,
  ClaudeMcpRegistrationTimeoutError,
  GROK_DRIVER,
  encodeJson,
  makeTestAdapter,
  projectId,
  threadId,
  unimplemented,
  waitForIdle,
} from "./ProviderSwitch.integration-fixtures.testkit.ts";
import type { CapturedTurn } from "./ProviderSwitch.integration-fixtures.testkit.ts";

describe("orchestration v2 provider switching", () => {
  it.live.each([
    "compact-native",
    "compact-legacy",
    "large-current-input",
    "screenshot-fallback",
    "screenshot-reported-capacity-native",
    "screenshot-option-change-retry-native",
    "screenshot-exhausted-target-native",
    "screenshot-exhausted-target-fallback",
    "screenshot-exhausted-target-estimate-native",
    "screenshot-exhausted-target-oversized-native",
    "screenshot-exhausted-target-tight-native",
    "screenshot-exhausted-target-background-native",
    "screenshot-exhausted-target-subagent-native",
    "prior-images-reasoning-change-replacement-small-native",
    "imported-prior-images-fallback",
    "prior-images-telemetry-native",
    "prior-images-unsent-native",
    "prior-images-legacy-replacement-native",
    "delivery-write-failure",
  ] as const)("preserves handoffs through %s", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`handoff-${scenario}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const reasoningScenario = scenario.includes("reasoning-change");
        const turnUsageScenario = reasoningScenario || scenario.includes("turn-usage");
        const modelScenario =
          scenario.includes("model") || scenario.includes("option-change") || reasoningScenario;
        const failStartOnce = yield* Ref.make(false);
        const failResumeOnce = yield* Ref.make(false);
        const generation = yield* Ref.make(0);
        const pendingBackgroundWork = yield* Ref.make(false);
        const priorImages = scenario.includes("prior-images");
        const exhaustedTarget = scenario.includes("exhausted-target");
        const replaceNative = scenario.includes("replacement");
        const capacityScenario = modelScenario || scenario.includes("reported-capacity");
        const returning =
          scenario === "large-current-input" ||
          scenario.includes("-change-") ||
          priorImages ||
          exhaustedTarget;
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
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
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
            responseByRunOrdinal: scenario.includes("target-estimate")
              ? { 2: "x".repeat(10_000) }
              : {},
            capturedTurns,
            ...(scenario.includes("retry") || scenario.includes("unsent") ? { failStartOnce } : {}),
            ...(replaceNative ? { failResumeOnce, nativeThreadGeneration: generation } : {}),
            ...(exhaustedTarget ? { nativeThreadGeneration: generation } : {}),
            ...(scenario.includes("target-background") || scenario.includes("target-subagent")
              ? {
                  pendingBackgroundWork,
                  subagentOnlyBackgroundWork: scenario.includes("target-subagent"),
                }
              : {}),
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
                : scenario === "large-current-input" || priorImages || exhaustedTarget
                  ? {
                      getModelContextWindow: () =>
                        scenario.includes("target-tight") ? 25_121 : 32_000,
                    }
                  : {}),
            ...(scenario.endsWith("-native") || scenario === "large-current-input"
              ? { injectedHistory }
              : {}),
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
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
                    : scenario.startsWith("screenshot") &&
                        ordinal >= targetOrdinal &&
                        (!exhaustedTarget || ordinal === targetOrdinal)
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
                        new EventSink.EventSinkWriteError({
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
            : scenario.includes("target-oversized")
              ? "x".repeat(40_000)
              : capacityScenario && !turnUsageScenario
                ? "x".repeat(70_000)
                : scenario === "large-current-input"
                  ? "x".repeat(9_000)
                  : "Continue work";
          if (returning) {
            if (scenario.includes("unsent")) yield* Ref.set(failStartOnce, true);
            yield* dispatch(
              2,
              turnUsageScenario
                ? "x".repeat(27_460)
                : scenario.includes("target-estimate")
                  ? "x".repeat(12_000)
                  : "Establish target",
              CLAUDE_MODEL_SELECTION,
            );
            yield* wait(2);
            if (exhaustedTarget) {
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                "completed",
              );
            }
            if (exhaustedTarget && !scenario.includes("target-estimate")) {
              const target = (yield* orchestrator.getThreadProjection(
                threadId,
              )).providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("exhausted-target-usage"),
                    type: "provider-thread.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: { ...target, contextUsage: { usedTokens: 30_000, maxTokens: 32_000 } },
                  },
                ],
              });
            }
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
            // Switching back to Codex already released Claude's session.
            yield* Ref.set(failResumeOnce, true);
          }
          if (scenario.includes("retry")) yield* Ref.set(failStartOnce, true);
          if (scenario.includes("target-background") || scenario.includes("target-subagent"))
            yield* Ref.set(pendingBackgroundWork, true);
          yield* dispatch(targetOrdinal, current, targetSelection);
          yield* wait(targetOrdinal);
          if (scenario.includes("retry")) {
            const failed = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(failed.runs.at(-1)?.status, "failed");
            const failedUsage = failed.providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!.contextUsage;
            if (reasoningScenario || scenario.includes("turn-usage")) {
              assert.deepEqual(failedUsage, { usedTokens: 37_321, maxTokens: 258_400 });
            } else {
              assert.deepEqual(failedUsage, { usedTokens: 30_000, maxTokens: 1_000_000 });
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
          if (
            scenario.includes("target-oversized") ||
            scenario.includes("target-tight") ||
            scenario.includes("target-background") ||
            scenario.includes("target-subagent")
          ) {
            assert.equal(projection.runs.at(-1)?.status, "failed");
            assert.equal(yield* Ref.get(generation), 1);
            assert.equal(projection.messages.at(-1)!.text, current);
            assert.deepEqual(projection.messages.at(-1)!.attachments, screenshots);
            if (scenario.includes("target-background") || scenario.includes("target-subagent")) {
              assert.isTrue(yield* Ref.get(pendingBackgroundWork));
              const failure = projection.turnItems.findLast((item) => item.type === "error");
              assert.equal(
                failure?.type === "error" ? failure.failure.message : null,
                "The target provider still has background work running. Wait for it to finish or stop it before retrying the handoff.",
              );
            }
            return;
          }
          assert.equal(projection.runs.at(-1)?.status, "completed");
          if (exhaustedTarget) {
            assert.equal(yield* Ref.get(generation), 2);
            const turns = (yield* Ref.get(capturedTurns)).filter(
              (turn) => turn.driver === CLAUDE_DRIVER,
            );
            assert.notEqual(turns[0]!.nativeThreadId, turns[1]!.nativeThreadId);
            const latestRun = projection.runs.at(-1)!;
            assert.equal(
              projection.attempts.find((attempt) => attempt.id === latestRun.activeAttemptId)!
                .nativeThreadId,
              turns[1]!.nativeThreadId,
            );
            const context = scenario.endsWith("-native")
              ? yield* encodeJson(yield* Ref.get(injectedHistory))
              : turns[1]!.text;
            assert.include(context, "Original request with constraints");
            assert.include(context, "Original partial work");
            assert.include(context, "New source constraint");
            assert.include(turns[1]!.text, current);
            assert.deepEqual(turns[1]!.attachments, screenshots);
            const historyBeforeFollowup = yield* Ref.get(injectedHistory);
            yield* dispatch(5, "Continue after automatic recovery", CLAUDE_MODEL_SELECTION);
            yield* wait(5);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
              "completed",
            );
            assert.equal(yield* Ref.get(generation), 2);
            assert.equal(
              (yield* Ref.get(capturedTurns)).at(-1)!.text,
              "Continue after automatic recovery",
            );
            assert.deepEqual(yield* Ref.get(injectedHistory), historyBeforeFollowup);
            if (scenario.includes("target-estimate")) {
              yield* dispatch(6, "Another source turn", CODEX_MODEL_SELECTION);
              yield* wait(6);
              yield* dispatch(7, "Return after recovery", CLAUDE_MODEL_SELECTION);
              yield* wait(7);
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                "completed",
              );
              assert.equal(yield* Ref.get(generation), 2);
            }
            return;
          }
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
                      (scenario.includes("retry")
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
            ProviderReplayHarness.layerWithRegistry(
              {
                name: `handoff-${scenario}`,
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              layerRegistry,
            ),
          ),
        );
      }),
    ),
  );
});
