import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { CommandPolicyCapabilityUnsupportedError } from "../CommandPolicy.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { AcpProviderCapabilitiesV2 } from "../Adapters/AcpAdapterV2.ts";
import { CursorProviderCapabilitiesV2 } from "../Adapters/CursorAdapterV2.ts";
import { layer as eventSinkLayer } from "../EventSink.ts";
import { EventSinkV2 } from "../EventSink.ts";
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
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Shape,
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
  readonly failResume?: boolean;
  readonly failedRunOrdinals?: ReadonlySet<number>;
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

        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
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
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            input.failResume
              ? unimplemented(input.driver, "simulated native resume failure")
              : Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Effect.yieldNow;
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  text: turnInput.message.text,
                },
              ]);
              if (turnInput.runOrdinal === 1 && input.holdFirstTurn !== undefined) {
                yield* Deferred.succeed(input.holdFirstTurn, undefined);
                if (input.releaseFirstTurn === undefined) return;
                yield* Deferred.await(input.releaseFirstTurn);
              }
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              if (input.failedRunOrdinals?.has(turnInput.runOrdinal) === true) {
                yield* PubSub.publish(events, {
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
                    status: "failed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                });
                yield* PubSub.publish(events, {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  failureItemOrdinal: turnInput.runOrdinal * 100 + 1,
                  status: "failed",
                  failure: makeProviderFailure({
                    message: "Simulated provider failure.",
                    code: "simulated_failure",
                    class: "provider_error",
                  }),
                  threadDisposition: "reusable",
                });
                return;
              }
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
                    status: "completed",
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
                    status: "completed",
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
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ];
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
        assert.lengthOf(projection.contextHandoffs, 0);
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
            return yield* orchestrator.getThreadProjection(importedThreadId);
          }
          return yield* waitForIdle(importedThreadId);
        }).pipe(Effect.provide(testLayer));

        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            ["codex", "failed"],
            ["claudeAgent", "completed"],
          ],
        );
        assert.deepEqual(
          projection.contextHandoffs.map((handoff) => [
            handoff.targetRunId,
            handoff.strategy,
            handoff.status,
          ]),
          [
            [projection.runs[0]?.id, "manual_context", "ready"],
            [projection.runs[1]?.id, "manual_context", "ready"],
          ],
        );
        assert.equal(projection.runs[1]?.contextHandoffId, projection.contextHandoffs[1]?.id);
        if (queueBeforeFailure) {
          const handoffItem = projection.turnItems.find(
            (item) => item.type === "handoff" && item.runId === projection.runs[1]?.id,
          );
          assert.equal(
            handoffItem?.type === "handoff" ? handoffItem.contextHandoffId : null,
            projection.contextHandoffs[1]?.id,
          );
          assert.include(
            handoffItem?.type === "handoff" ? handoffItem.summary : "",
            "imported release marker is violet",
          );
        }
        assert.include(turns[1]?.text ?? "", "Context handoff (manual_context):");
        assert.include(turns[1]?.text ?? "", "imported release marker is violet");
        assert.include(turns[1]?.text ?? "", "I will remember violet.");
        assert.include(turns[1]?.text ?? "", recoveryPrompt);
        assert.notInclude(turns[1]?.text ?? "", failedPrompt);
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
        assert.deepEqual(
          projection.contextHandoffs.map((handoff) => handoff.strategy),
          ["full_thread_summary", "delta_since_target_last_seen"],
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
        assert.include(turns[2]?.text ?? "", "Context handoff (delta_since_target_last_seen):");
        assert.include(turns[2]?.text ?? "", "claude switched response");
        assert.include(turns[2]?.text ?? "", returnPrompt);
        assert.notInclude(turns[2]?.text ?? "", "codex before switch");
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

  it.live("switches providers while consuming a pending cross-provider merge-back", () =>
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

        assert.isDefined(mergedTurn);
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
