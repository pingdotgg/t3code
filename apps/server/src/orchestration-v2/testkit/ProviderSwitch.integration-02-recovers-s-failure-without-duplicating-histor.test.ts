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
    "turn-start",
    "injection",
    "large-missed-request",
    "exhausted-target-retry",
  ] as const)(
    "recovers %s failure without duplicating history in the same native thread",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(`handoff-retry-${failure}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const failOnce = yield* Ref.make(true);
          const generation = yield* Ref.make(0);
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
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
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
            if (failure === "exhausted-target-retry") {
              const target = failed.providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* (yield* EventSink.EventSinkV2).write({
                events: [
                  {
                    id: EventId.make("exhausted-retry-usage"),
                    type: "provider-thread.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: { ...target, contextUsage: { usedTokens: 30_000, maxTokens: 32_000 } },
                  },
                ],
              });
            }
            const retryText =
              failure === "large-missed-request" ? "y".repeat(10_000) : "Retry target request";
            yield* dispatch(3, retryText, CLAUDE_MODEL_SELECTION);
            yield* wait(3, "completed");
            const retried = yield* orchestrator.getThreadProjection(threadId);
            const lastTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
            assert.equal(lastTurn.text, retryText);
            if (failure !== "injection" && failure !== "exhausted-target-retry") {
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
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: `handoff-retry-${failure}`,
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

  it.live.each(["native", "legacy"] as const)(
    "starts a replacement native thread as new after the resume fallback with %s attempts",
    (attempts) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("resume-fallback-native-turns");
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const failResumeOnce = yield* Ref.make(false);
          const generation = yield* Ref.make(0);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              failResumeOnce,
              nativeThreadGeneration: generation,
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const runToCompletion = Effect.fn("runToCompletion")(function* (ordinal: number) {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`resume-fallback:${ordinal}`),
                threadId,
                messageId: MessageId.make(`resume-fallback:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text: `Request ${ordinal}`,
                attachments: [],
                modelSelection: CLAUDE_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              });
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
              );
              yield* worker.drain();
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                "completed",
              );
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("resume-fallback:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Resume fallback",
              modelSelection: CLAUDE_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* runToCompletion(1);
            const providerThread = (yield* orchestrator.getThreadProjection(
              threadId,
            )).providerThreads.at(0);
            if (providerThread === undefined || providerThread.providerSessionId === null) {
              return yield* Effect.die("Expected a provider session after the first turn.");
            }
            yield* orchestrator.dispatch({
              type: "provider-session.detach",
              commandId: CommandId.make("resume-fallback:detach"),
              threadId,
              providerSessionId: providerThread.providerSessionId,
            });
            yield* worker.drain();
            if (attempts === "legacy") {
              const existing = yield* orchestrator.getThreadProjection(threadId);
              yield* (yield* EventSink.EventSinkV2).write({
                events: existing.attempts.map(
                  ({ nativeThreadId: _nativeThreadId, ...legacy }, index) => ({
                    id: EventId.make(`resume-fallback-legacy-attempt:${index}`),
                    type: "run-attempt.updated" as const,
                    threadId,
                    occurredAt: existing.thread.createdAt,
                    payload: legacy,
                  }),
                ),
              });
            }
            yield* Ref.set(failResumeOnce, true);
            yield* runToCompletion(2);
            yield* runToCompletion(3);

            const turns = yield* Ref.get(capturedTurns);
            assert.equal(turns.length, 3);
            assert.equal(yield* Ref.get(generation), 2);
            assert.notEqual(turns[1]?.nativeThreadId, turns[0]?.nativeThreadId);
            assert.isAbove(turns[1]?.providerTurnOrdinal ?? 0, 1);
            assert.isFalse(turns[1]?.nativeThreadHasTurns);
            assert.equal(turns[2]?.nativeThreadId, turns[1]?.nativeThreadId);
            assert.isTrue(turns[2]?.nativeThreadHasTurns);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: "resume-fallback-native-turns",
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

  it.live.each(["an older handoff", "a missed request"] as const)(
    "keeps the latest turn when a resume fallback also delivers %s",
    (older) =>
      Effect.scoped(
        Effect.gen(function* () {
          // A run that fails before its provider turn starts is retried as a missed request.
          const missed = older === "a missed request";
          const name = `resume-fallback-handoff-order${missed ? "-missed" : ""}`;
          const cwd = yield* checkpointWorkspace(name);
          const failStartOnce = yield* Ref.make(false);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const oldResult = `old result ${"o".repeat(2_500)}`;
          const latestResult = `latest result ${"l".repeat(2_500)}`;
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: { 1: oldResult, 3: latestResult },
              capturedTurns,
              injectedHistory,
              failResume: true,
              ...(missed ? { failStartOnce } : { failedRunOrdinals: new Set([2]) }),
              nativeThreadGeneration: yield* Ref.make(0),
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const runAfterDetach = Effect.fn("runAfterDetach")(function* (
              ordinal: number,
              text: string,
            ) {
              const providerSessionId = (yield* orchestrator.getThreadProjection(threadId))
                .providerThreads[0]?.providerSessionId;
              if (providerSessionId != null) {
                yield* orchestrator.dispatch({
                  type: "provider-session.detach",
                  commandId: CommandId.make(`handoff-order:detach:${ordinal}`),
                  threadId,
                  providerSessionId,
                });
                yield* worker.drain();
              }
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`handoff-order:${ordinal}`),
                threadId,
                messageId: MessageId.make(`handoff-order:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments: [],
                modelSelection: CLAUDE_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              });
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
              );
              yield* worker.drain();
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("handoff-order:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Resume fallback handoff order",
              modelSelection: CLAUDE_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* runAfterDetach(1, `Original brief ${"b".repeat(9_000)}`);
            yield* Ref.set(failStartOnce, missed);
            yield* runAfterDetach(2, missed ? `Request 2 ${"r".repeat(6_000)}` : "Request 2");
            yield* runAfterDetach(3, "Request 3");
            const historyBeforeRun4 = (yield* Ref.get(injectedHistory)).length;
            yield* runAfterDetach(4, "Request 4");

            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              projection.runs.map((run) => run.status),
              ["completed", "failed", "completed", "completed"],
            );
            const run4NativeThreadId = (yield* Ref.get(capturedTurns)).at(-1)?.nativeThreadId;
            assert.equal(
              projection.contextHandoffs.find(
                (handoff) => handoff.targetRunId === projection.runs[1]?.id,
              )?.delivery?.nativeThreadId,
              run4NativeThreadId,
            );
            const run4History = yield* encodeJson(
              (yield* Ref.get(injectedHistory)).slice(historyBeforeRun4),
            );
            assert.include(run4History, "Original brief");
            assert.include(run4History, latestResult);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name,
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

  it.live.each([
    ["background work", new ClaudeBackgroundWorkBlocksQueryReplacementError()],
    ["an unreadable append file", new ClaudeAppendSystemPromptFileError({ path: "missing.md" })],
    [
      "an MCP registration timeout",
      new ClaudeAgentSdkQueryRunnerError({
        method: "setMcpServers",
        cause: new ClaudeMcpRegistrationTimeoutError(),
      }),
    ],
  ] as const)("keeps the native session after turns refused for %s", ([, refusalCause]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("refused-start-keeps-native");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const refuseStarts = yield* Ref.make(0);
        const generation = yield* Ref.make(0);
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            refuseStarts,
            refusalCause,
            nativeThreadGeneration: generation,
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const run = Effect.fn("run")(function* (ordinal: number) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`refused-start:${ordinal}`),
              threadId,
              messageId: MessageId.make(`refused-start:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text: `Request ${ordinal}`,
              attachments: [],
              modelSelection: CLAUDE_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            });
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
            return (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status;
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("refused-start:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Refused start",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          assert.equal(yield* run(1), "completed");
          yield* Ref.set(refuseStarts, 2);
          assert.equal(yield* run(2), "failed");
          assert.equal(yield* run(3), "failed");
          assert.equal(yield* run(4), "completed");

          const turns = yield* Ref.get(capturedTurns);
          assert.equal(turns.length, 2);
          assert.equal(yield* Ref.get(generation), 1);
          assert.equal(turns[1]?.nativeThreadId, turns[0]?.nativeThreadId);
          assert.include(turns[1]?.text, "Request 2");
          assert.include(turns[1]?.text, "Request 3");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "refused-start-keeps-native",
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
});
