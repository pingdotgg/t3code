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
  it.live.each(
    (
      [
        ["failed", false, false, false],
        ["failed", true, true, true],
        ["interrupted", false, true, false],
        ["interrupted", true, false, true],
      ] as const
    ).map(
      ([status, queued, returning, native]) =>
        [
          `${status} context ${queued ? "through the queue" : "immediately"} to ${returning ? "a returning" : "a new"} provider via ${native ? "native history" : "text"}`,
          { status, queued, returning, native },
        ] as const,
    ),
  )("hands off %s", ([, { status, queued, returning, native }]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`handoff-${status}-${queued}-${returning}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const sourceOrdinal = returning ? 2 : 1;
        const sourceSelection = returning ? CLAUDE_MODEL_SELECTION : CODEX_MODEL_SELECTION;
        const targetSelection = returning ? CODEX_MODEL_SELECTION : CLAUDE_MODEL_SELECTION;
        const originalPrompt = "Keep the release marker violet and preserve the existing API.";
        const partialResponse = "I checked the API and found the release configuration.";
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
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
                    failedRunOrdinals: new Set(status === "failed" ? [sourceOrdinal] : []),
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
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
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
            yield* dispatch("initial", "Earlier successful request.", CODEX_MODEL_SELECTION);
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
          yield* dispatch("back", "Finish the remaining work", sourceSelection);
          yield* waitForRun(sourceOrdinal + 2, "completed");
          const back = (yield* Ref.get(capturedTurns)).at(-1)!;
          assert.notInclude(back.text, originalPrompt);
          assert.notInclude(back.text, partialResponse);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
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
              layerRegistry,
            ),
          ),
        );
      }),
    ),
  );

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
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
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
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
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
              assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
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
              ProviderReplayHarness.layerWithRegistry(
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
                layerRegistry,
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
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
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
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
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
            ProviderReplayHarness.layerWithRegistry(
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
              layerRegistry,
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
});
