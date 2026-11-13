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
    ["automatic", "Claude"],
    ["queue.resume", "compatible Codex"],
  ] as const)(
    "delivers a queued PR update on the current provider through %s (%s)",
    ([delivery, target]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(`pr-wake-${delivery}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const compatible = target === "compatible Codex";
          const selection = {
            ...(compatible
              ? { ...CODEX_MODEL_SELECTION, instanceId: ProviderInstanceId.make("codex-alternate") }
              : CLAUDE_MODEL_SELECTION),
            options: [{ id: "reasoningEffort", value: "low" }],
          };
          const targetCapabilities = compatible
            ? {
                ...CodexProviderCapabilitiesV2,
                context: {
                  ...CodexProviderCapabilitiesV2.context,
                  canConsumeHandoffSummaries: false,
                },
              }
            : ClaudeProviderCapabilitiesV2;
          const adapters = [
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: CodexProviderCapabilitiesV2,
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              holdFirstTurn: started,
              releaseFirstTurn: release,
              failedRunOrdinals: new Set([1]),
              failure: makeProviderFailure({
                message: "Usage limit reached",
                class: "usage_limit",
                code: "usage_limit",
              }),
            }),
            makeTestAdapter({
              instanceId: selection.instanceId,
              driver: compatible ? CODEX_DRIVER : CLAUDE_DRIVER,
              capabilities: targetCapabilities,
              modelSelection: selection,
              responseByRunOrdinal: {},
              capturedTurns,
            }),
          ];
          const layerRegistry = compatible
            ? Layer.succeed(
                ProviderAdapterRegistry.ProviderAdapterRegistryV2,
                ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
                  get: (instanceId) => {
                    const adapter = adapters.find(
                      (candidate) => candidate.instanceId === instanceId,
                    );
                    return adapter === undefined
                      ? Effect.fail(
                          new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({
                            instanceId,
                          }),
                        )
                      : Effect.succeed(adapter);
                  },
                  list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
                  getMetadata: (instanceId) =>
                    Effect.succeed({
                      driver: CODEX_DRIVER,
                      continuationKey: "codex:shared-native-account-history",
                      enabled: true,
                      capabilities:
                        instanceId === selection.instanceId
                          ? targetCapabilities
                          : CodexProviderCapabilitiesV2,
                    }),
                }),
              )
            : ProviderAdapterRegistry.layerFromAdapters(adapters);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const dispatch = (text: string, modelSelection: ModelSelection) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(text),
                messageId: MessageId.make(text),
                threadId,
                text,
                modelSelection,
                attachments: [],
                createdBy: "user",
                creationSource: "web",
                dispatchMode: { type: "start_immediately" },
              });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "PR wake",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* dispatch("Original work", CODEX_MODEL_SELECTION);
            yield* Deferred.await(started);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("wake"),
              messageId: MessageId.make("wake"),
              threadId,
              text: "Review the new PR comments",
              attachments: [],
              createdBy: "agent",
              creationSource: "server",
              dispatchMode: { type: "queue_after_active" },
              notification: {
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "New PR comments",
              },
            });
            const [active, wake] = (yield* orchestrator.getThreadProjection(threadId)).runs;
            assert.isDefined(active);
            assert.isDefined(wake);
            assert.equal(wake.status, "queued");
            yield* Deferred.succeed(release, undefined);
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.runId === active.id &&
                  event.payload.status === "failed",
              ),
              Stream.runHead,
            );
            yield* worker.drain();

            if (delivery === "automatic") {
              yield* dispatch("Take over the work", selection);
            } else {
              yield* orchestrator.dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make("select"),
                threadId,
                modelSelection: selection,
              });
              yield* orchestrator.dispatch({
                type: "queue.resume",
                commandId: CommandId.make("resume"),
                threadId,
              });
            }
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.runId === wake.id &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
            const after = yield* orchestrator.getThreadProjection(threadId);
            const turns = yield* Ref.get(capturedTurns);
            assert.lengthOf(turns, delivery === "automatic" ? 3 : 2);
            const executed = turns.at(-1)!;
            assert.equal(executed.driver, compatible ? CODEX_DRIVER : CLAUDE_DRIVER);
            assert.include(executed.text, "Review the new PR comments");
            assert.deepEqual(executed.modelSelection, selection);
            assert.deepEqual(after.thread.modelSelection, selection);
            const delivered = after.runs.find((run) => run.id === wake.id)!;
            assert.equal(delivered.status, "completed");
            assert.deepEqual(delivered.modelSelection, selection);
            assert.equal(delivered.providerInstanceId, selection.instanceId);
            assert.equal(delivered.providerThreadId, executed.providerThreadId);
            assert.equal(after.thread.activeProviderThreadId, delivered.providerThreadId);
            if (delivery === "automatic") {
              assert.equal(executed.providerThreadId, turns[1]!.providerThreadId);
              assert.equal(executed.nativeThreadId, turns[1]!.nativeThreadId);
            }
            if (compatible) {
              assert.equal(executed.nativeThreadId, turns[0]!.nativeThreadId);
              assert.isEmpty(after.contextHandoffs);
            }
            assert.equal(
              after.providerThreads.find((entry) => entry.id === delivered.providerThreadId)
                ?.providerInstanceId,
              selection.instanceId,
            );
            assert.equal(
              after.turnItems.find(
                (entry) => entry.type === "notification" && entry.runId === wake.id,
              )?.providerThreadId,
              delivered.providerThreadId,
            );
            const attempt = after.attempts.find((entry) => entry.id === delivered.activeAttemptId);
            const root = after.nodes.find((entry) => entry.id === delivered.rootNodeId);
            assert.equal(attempt?.providerInstanceId, selection.instanceId);
            assert.equal(attempt?.providerThreadId, delivered.providerThreadId);
            assert.equal(root?.providerThreadId, delivered.providerThreadId);
            assert.equal(
              after.checkpointScopes.find((entry) => entry.id === root?.checkpointScopeId)
                ?.providerThreadId,
              delivered.providerThreadId,
            );
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                { name: `pr-wake-${delivery}`, runtimePolicyOverride: { cwd } },
                layerRegistry,
              ),
            ),
          );
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
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
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
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
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
            ProviderReplayHarness.layerWithRegistry(
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
              layerRegistry,
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
});
