import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterEventStreamError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex-restart-test");
const initialSelection = {
  instanceId: providerInstanceId,
  model: "restart-model-a",
} satisfies ModelSelection;
const replacementSelection = {
  instanceId: providerInstanceId,
  model: "restart-model-b",
} satisfies ModelSelection;
const seedSelection = {
  instanceId: providerInstanceId,
  model: "seed-model",
} satisfies ModelSelection;
const handoffDriver = ProviderDriverKind.make("claudeAgent");
const handoffProviderInstanceId = ProviderInstanceId.make("claude-handoff-test");
const handoffSelection = {
  instanceId: handoffProviderInstanceId,
  model: "handoff-model",
} satisfies ModelSelection;
const pooledCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
const exclusiveCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
  },
};

interface ActiveTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
}

interface RestartAdapterState {
  readonly activeTurn: ActiveTurn | null;
  readonly opened: ReadonlyArray<{
    readonly model: string | null;
    readonly cwd: string | null;
  }>;
  readonly started: ReadonlyArray<{
    readonly model: string;
    readonly cwd: string | null;
    readonly attemptId: string;
  }>;
  readonly closedSessionCount: number;
  readonly failedReplacementOpen: boolean;
}

function makeRestartAdapter(
  state: Ref.Ref<RestartAdapterState>,
  sessionCapabilities: OrchestrationV2ProviderCapabilities = pooledCapabilities,
  providerInstanceId = initialSelection.instanceId,
  completeContinuation: Effect.Effect<void> = Effect.void,
): ProviderAdapterV2Shape {
  return {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(sessionCapabilities),
    planSelectionTransition: ({ current, target }) =>
      Effect.succeed(
        current.model === target.model
          ? ({ type: "apply_on_next_turn" } as const)
          : ({ type: "restart_session" } as const),
      ),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const failThisOpen = yield* Ref.modify(state, (current) => {
          const shouldFail =
            sessionInput.modelSelection.model === replacementSelection.model &&
            !current.failedReplacementOpen;
          return [
            shouldFail,
            {
              ...current,
              failedReplacementOpen: current.failedReplacementOpen || shouldFail,
              opened: [
                ...current.opened,
                {
                  model: sessionInput.modelSelection.model,
                  cwd: sessionInput.runtimePolicy.cwd,
                },
              ],
            },
          ] as const;
        });
        if (failThisOpen) {
          return yield* new ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: sessionInput.providerSessionId,
            cause: "simulated replacement open failure",
          });
        }

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
          model: sessionInput.modelSelection.model,
          capabilities: sessionCapabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        yield* Effect.addFinalizer(() =>
          Ref.update(state, (current) => ({
            ...current,
            closedSessionCount: current.closedSessionCount + 1,
          })),
        );

        const publishTerminal = (active: ActiveTurn, status: "completed" | "interrupted") =>
          Effect.gen(function* () {
            const occurredAt = yield* DateTime.now;
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: active.providerTurnId,
                providerThreadId: active.input.providerThread.id,
                nodeId: active.input.rootNodeId,
                runAttemptId: active.input.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${active.providerTurnId}`,
                  strength: "strong",
                },
                ordinal: active.input.providerTurnOrdinal,
                status,
                startedAt: occurredAt,
                completedAt: occurredAt,
              },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: active.input.providerThread.id,
              providerTurnId: active.providerTurnId,
              runOrdinal: active.input.runOrdinal,
              status,
              failure: null,
              threadDisposition: "reusable",
            });
          });

        return {
          instanceId: providerInstanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${threadInput.threadId}`,
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
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(state, (current) => ({
                ...current,
                started: [
                  ...current.started,
                  {
                    model: input.modelSelection.model,
                    cwd: input.runtimePolicy.cwd,
                    attemptId: input.attemptId,
                  },
                ],
              }));
              const active = {
                input,
                providerTurnId: ProviderTurnId.make(`provider-turn:${input.attemptId}`),
              } satisfies ActiveTurn;
              if (
                input.modelSelection.model === initialSelection.model &&
                !input.message.text.endsWith("handoff continuation")
              ) {
                const occurredAt = yield* DateTime.now;
                yield* Ref.update(state, (current) => ({ ...current, activeTurn: active }));
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: active.providerTurnId,
                    providerThreadId: input.providerThread.id,
                    nodeId: input.rootNodeId,
                    runAttemptId: input.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${active.providerTurnId}`,
                      strength: "strong",
                    },
                    ordinal: input.providerTurnOrdinal,
                    status: "running",
                    startedAt: occurredAt,
                    completedAt: null,
                  },
                });
                return;
              }
              if (input.message.text.endsWith("handoff continuation")) {
                const startedAt = yield* DateTime.now;
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: active.providerTurnId,
                    providerThreadId: input.providerThread.id,
                    nodeId: input.rootNodeId,
                    runAttemptId: input.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${active.providerTurnId}`,
                      strength: "strong",
                    },
                    ordinal: input.providerTurnOrdinal,
                    status: "running",
                    startedAt,
                    completedAt: null,
                  },
                });
                yield* completeContinuation;
                const completedAt = yield* DateTime.now;
                yield* Queue.offer(events, {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(`turn-item:${input.attemptId}:result`),
                    threadId: input.threadId,
                    runId: input.runId,
                    nodeId: input.rootNodeId,
                    providerThreadId: input.providerThread.id,
                    providerTurnId: active.providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: input.providerTurnOrdinal * 100 + 2,
                    status: "completed",
                    title: null,
                    startedAt,
                    completedAt,
                    updatedAt: completedAt,
                    type: "assistant_message",
                    messageId: MessageId.make(`message:${input.attemptId}:result`),
                    text: "Completed inside the new worktree",
                    attachments: [],
                    streaming: false,
                  },
                });
                yield* Queue.offer(events, {
                  type: "message.updated",
                  driver,
                  message: {
                    id: MessageId.make(`message:${input.attemptId}:result`),
                    threadId: input.threadId,
                    runId: input.runId,
                    nodeId: input.rootNodeId,
                    role: "assistant",
                    text: "Completed inside the new worktree",
                    attachments: [],
                    streaming: false,
                    createdBy: "agent",
                    creationSource: "provider",
                    createdAt: completedAt,
                    updatedAt: completedAt,
                  },
                });
              }
              yield* publishTerminal(active, "completed");
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            Effect.gen(function* () {
              const active = (yield* Ref.get(state)).activeTurn;
              if (active !== null) {
                const updatedAt = yield* DateTime.now;
                yield* Queue.offer(events, {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...active.input.providerThread,
                    status: "idle",
                    updatedAt,
                  },
                });
                yield* publishTerminal(active, "interrupted");
                yield* Ref.update(state, (current) => ({ ...current, activeTurn: null }));
              }
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

function makeCompletingHandoffAdapter(startCount: Ref.Ref<number>): ProviderAdapterV2Shape {
  return {
    instanceId: handoffProviderInstanceId,
    driver: handoffDriver,
    getCapabilities: () => Effect.succeed(exclusiveCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        return {
          instanceId: handoffProviderInstanceId,
          driver: handoffDriver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver: handoffDriver,
            providerInstanceId: handoffProviderInstanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
            model: sessionInput.modelSelection.model,
            capabilities: exclusiveCapabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:handoff:${threadInput.threadId}`),
                driver: handoffDriver,
                providerInstanceId: handoffProviderInstanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: handoffDriver,
                  nativeId: `native-thread:handoff:${threadInput.threadId}`,
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
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(startCount, (count) => count + 1);
              const occurredAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:handoff:${input.attemptId}`,
              );
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver: handoffDriver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: {
                    driver: handoffDriver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: input.providerTurnOrdinal,
                  status: "completed",
                  startedAt: occurredAt,
                  completedAt: occurredAt,
                },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver: handoffDriver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

it.live("restarts selection as a new attempt and retries after old-session cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("selection-restart-lifecycle");
      const threadId = ThreadId.make("thread:selection-restart-lifecycle");
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: false,
      });
      const registry = ProviderAdapterRegistry.makeSingleLayer(makeRestartAdapter(state));

      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart:create"),
          threadId,
          projectId: ProjectId.make("project:selection-restart"),
          title: "Selection restart",
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart:first"),
          threadId,
          messageId: MessageId.make("message:selection-restart:first"),
          text: "first",
          attachments: [],
          modelSelection: initialSelection,
          dispatchMode: { type: "start_immediately" },
        });
        for (let index = 0; index < 1_000; index += 1) {
          const current = yield* orchestrator.getThreadProjection(threadId);
          if (current.providerTurns.some((turn) => turn.status === "running")) break;
          yield* Effect.sleep("5 millis");
        }
        const activeProjection = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(activeProjection.providerTurns.some((turn) => turn.status === "running"));
        const activeRunId = activeProjection.runs[0]?.id;
        if (activeRunId === undefined) {
          return yield* Effect.die("active restart test run is missing");
        }

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart:second"),
          threadId,
          messageId: MessageId.make("message:selection-restart:second"),
          text: "second",
          attachments: [],
          modelSelection: replacementSelection,
          dispatchMode: { type: "restart_active", targetRunId: activeRunId },
        });
        for (let index = 0; index < 1_000; index += 1) {
          const current = yield* orchestrator.getThreadProjection(threadId);
          if (current.attempts.length === 2 && current.attempts[1]?.status === "completed") {
            const captured = yield* Ref.get(state);
            return { projection: current, captured };
          }
          yield* Effect.sleep("5 millis");
        }
        const current = yield* orchestrator.getThreadProjection(threadId);
        const adapterState = yield* Ref.get(state);
        yield* Effect.logError("selection restart did not complete", {
          runs: current.runs.map((run) => [run.status, run.activeAttemptId]),
          attempts: current.attempts.map((attempt) => [attempt.id, attempt.status]),
          providerTurns: current.providerTurns.map((turn) => [turn.id, turn.status]),
          providerThreads: current.providerThreads.map((thread) => [
            thread.providerSessionId,
            thread.status,
          ]),
          adapterState,
        });
        return yield* Effect.die("selection restart did not complete");
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "selection-restart-lifecycle" },
            registry,
          ),
        ),
      );
      const { projection, captured } = result;

      assert.lengthOf(projection.runs, 1);
      assert.lengthOf(projection.attempts, 2);
      assert.deepEqual(
        projection.attempts.map((attempt) => attempt.status),
        ["superseded", "completed"],
      );
      assert.deepEqual(
        projection.providerTurns.map((turn) => turn.status),
        ["interrupted", "completed"],
      );
      assert.isFalse(
        projection.turnItems.some(
          (item) => item.type === "run_interrupt_request" || item.type === "run_interrupt_result",
        ),
        "selection restart supersede must not project hard-Stop interrupt items",
      );
      assert.equal(projection.runs[0]?.modelSelection.model, replacementSelection.model);
      assert.isTrue(captured.failedReplacementOpen);
      // The old pooled process remains available to its other threads; this
      // thread moved to a freshly allocated replacement session.
      assert.equal(captured.closedSessionCount, 0);
      assert.deepEqual(
        captured.opened.map((open) => [open.model, open.cwd]),
        [
          [initialSelection.model, cwd],
          [replacementSelection.model, cwd],
          [replacementSelection.model, cwd],
        ],
      );
      assert.deepEqual(
        captured.started.map((turn) => [turn.model, turn.cwd]),
        [
          [initialSelection.model, cwd],
          [replacementSelection.model, cwd],
        ],
      );
      assert.notEqual(
        projection.providerSessions[0]?.id,
        projection.providerThreads[0]?.providerSessionId,
      );
      assert.equal(
        projection.providerThreads[0]?.providerSessionId,
        projection.providerSessions.find((session) => session.model === replacementSelection.model)
          ?.id,
      );
    }),
  ),
);

it.live.each(["stopped", "error"] as const)(
  "restarts the live session on a model change when a newer %s session record exists",
  (deadStatus) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `selection-restart-dead-${deadStatus}`;
        const cwd = yield* checkpointWorkspace(name);
        const threadId = ThreadId.make(`thread:${name}`);
        const state = yield* Ref.make<RestartAdapterState>({
          activeTurn: null,
          opened: [],
          started: [],
          closedSessionCount: 0,
          // The dead record is seeded directly, so the adapter's one-shot
          // simulated replacement-open failure is skipped.
          failedReplacementOpen: true,
        });
        const registry = ProviderAdapterRegistry.makeSingleLayer(
          makeRestartAdapter(state, exclusiveCapabilities),
        );

        const result = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const dispatch = (step: string, modelSelection: ModelSelection) =>
            Effect.gen(function* () {
              const terminal = yield* orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (event) => event.type === "run.updated" && event.payload.status === "completed",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`${name}:${step}`),
                threadId,
                messageId: MessageId.make(`${name}:${step}`),
                text: step,
                attachments: [],
                modelSelection,
                dispatchMode: { type: "start_immediately" },
              });
              yield* worker.drain();
              yield* Fiber.join(terminal);
              yield* worker.drain();
              return yield* orchestrator.getThreadProjection(threadId);
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${name}:create`),
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            title: name,
            modelSelection: seedSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          const first = yield* dispatch("first", seedSelection);
          const liveSession = first.providerSessions.find(
            (session) => session.status !== "stopped" && session.status !== "error",
          );
          assert.isDefined(liveSession);

          // Dead session records stay bound in the projection until
          // detachment. A stale stopped/error record written after the
          // live session attached must not hide it.
          const deadAt = yield* DateTime.now;
          const deadSession: OrchestrationV2ProviderSession = {
            id: ProviderSessionId.make(`session:${name}:dead`),
            driver,
            providerInstanceId,
            status: "ready",
            cwd,
            model: seedSelection.model,
            capabilities: exclusiveCapabilities,
            createdAt: deadAt,
            updatedAt: deadAt,
            lastError: null,
          };
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`event:${name}:dead-attached`),
                type: "provider-session.attached",
                threadId,
                driver,
                providerInstanceId,
                occurredAt: deadAt,
                payload: deadSession,
              },
              {
                id: EventId.make(`event:${name}:dead-updated`),
                type: "provider-session.updated",
                threadId,
                driver,
                providerInstanceId,
                occurredAt: deadAt,
                payload: {
                  ...deadSession,
                  status: deadStatus,
                  updatedAt: deadAt,
                  lastError: deadStatus === "error" ? "Simulated session failure." : null,
                },
              },
            ],
          });

          const switchCommandId = CommandId.make(`${name}:switch`);
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: switchCommandId,
            threadId,
            modelSelection: replacementSelection,
          });
          yield* worker.drain();
          const storedSwitchEvents = yield* eventSink
            .readByCommandId({ commandId: switchCommandId })
            .pipe(Stream.runCollect);
          const detachedSessionIds = [...storedSwitchEvents].flatMap((stored) =>
            stored.event.type === "provider-session.detached"
              ? [stored.event.payload.providerSessionId]
              : [],
          );

          const second = yield* dispatch("second", replacementSelection);
          return {
            projection: second,
            captured: yield* Ref.get(state),
            liveSessionId: liveSession.id,
            detachedSessionIds,
          };
        }).pipe(Effect.provide(makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry)));

        const { projection, captured } = result;
        assert.lengthOf(projection.runs, 2);
        assert.equal(projection.runs[1]?.modelSelection.model, replacementSelection.model);
        // The exact released session is the older live one, never the newer
        // dead record.
        assert.deepEqual(result.detachedSessionIds, [result.liveSessionId]);
        assert.equal(captured.closedSessionCount, 1);
        assert.deepEqual(
          captured.opened.map((open) => open.model),
          [seedSelection.model, replacementSelection.model],
        );
        assert.deepEqual(
          captured.started.map((turn) => turn.model),
          [seedSelection.model, replacementSelection.model],
        );
        const servingSession = projection.providerSessions.find(
          (session) =>
            session.id ===
            projection.providerThreads.find(
              (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
            )?.providerSessionId,
        );
        assert.equal(servingSession?.model, replacementSelection.model);
      }),
    ),
);

it.live("detaches the old provider session after an active provider handoff", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("selection-provider-handoff-lifecycle");
      const threadId = ThreadId.make("thread:selection-provider-handoff-lifecycle");
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: false,
      });
      const targetStartCount = yield* Ref.make(0);
      const registry = ProviderAdapterRegistry.makeLayer([
        makeRestartAdapter(state, exclusiveCapabilities),
        makeCompletingHandoffAdapter(targetStartCount),
      ]);

      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-handoff:create"),
          threadId,
          projectId: ProjectId.make("project:selection-handoff"),
          title: "Selection provider handoff",
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-handoff:first"),
          threadId,
          messageId: MessageId.make("message:selection-handoff:first"),
          text: "first",
          attachments: [],
          modelSelection: initialSelection,
          dispatchMode: { type: "start_immediately" },
        });
        let activeRunId: RunId | null = null;
        for (let index = 0; index < 1_000; index += 1) {
          const current = yield* orchestrator.getThreadProjection(threadId);
          if (current.providerTurns.some((turn) => turn.status === "running")) {
            activeRunId = current.runs[0]?.id ?? null;
            break;
          }
          yield* Effect.sleep("5 millis");
        }
        if (activeRunId === null) {
          return yield* Effect.die("active provider-handoff run is missing");
        }

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-handoff:second"),
          threadId,
          messageId: MessageId.make("message:selection-handoff:second"),
          text: "second",
          attachments: [],
          modelSelection: handoffSelection,
          dispatchMode: { type: "restart_active", targetRunId: activeRunId },
        });
        for (let index = 0; index < 1_000; index += 1) {
          const current = yield* orchestrator.getThreadProjection(threadId);
          if (current.attempts.length === 2 && current.attempts[1]?.status === "completed") {
            const captured = yield* Ref.get(state);
            return { projection: current, captured };
          }
          yield* Effect.sleep("5 millis");
        }
        const current = yield* orchestrator.getThreadProjection(threadId);
        const adapterState = yield* Ref.get(state);
        const capturedTargetStartCount = yield* Ref.get(targetStartCount);
        yield* Effect.logError("active provider handoff did not complete", {
          runs: current.runs.map((run) => [run.status, run.activeAttemptId]),
          attempts: current.attempts.map((attempt) => [attempt.id, attempt.status]),
          providerTurns: current.providerTurns.map((turn) => [turn.id, turn.status]),
          providerThreads: current.providerThreads.map((thread) => [
            thread.providerInstanceId,
            thread.providerSessionId,
            thread.status,
          ]),
          targetStartCount: capturedTargetStartCount,
          adapterState,
        });
        return yield* Effect.die("active provider handoff did not complete");
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "selection-provider-handoff-lifecycle" },
            registry,
          ),
        ),
      );

      assert.lengthOf(result.projection.runs, 1);
      assert.lengthOf(result.projection.attempts, 2);
      assert.equal(result.projection.runs[0]?.providerInstanceId, handoffProviderInstanceId);
      assert.equal(result.projection.contextHandoffs.length, 1);
      assert.equal(result.captured.closedSessionCount, 1);
      assert.equal(yield* Ref.get(targetStartCount), 1);
    }),
  ),
);

it.live.each(["active", "idle", "selection-command", "pooled", "separate-home"] as const)(
  "preserves native history only for compatible account switches (%s)",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `shared-home-${mode}`;
        const cwd = yield* checkpointWorkspace(name);
        const threadId = ThreadId.make(`thread:${name}`);
        const targetId = ProviderInstanceId.make("codex-shadow-account");
        const state = yield* Ref.make<RestartAdapterState>({
          activeTurn: null,
          opened: [],
          started: [],
          closedSessionCount: 0,
          failedReplacementOpen: true,
        });
        const resumes: Array<{
          instanceId: ProviderInstanceId;
          nativeId: string | null | undefined;
        }> = [];
        const messages: string[] = [];
        const capabilities = mode === "pooled" ? pooledCapabilities : exclusiveCapabilities;
        const adapters = [providerInstanceId, targetId].map((instanceId) => {
          const base = makeRestartAdapter(state, capabilities, instanceId);
          return {
            ...base,
            openSession: (input) =>
              base.openSession(input).pipe(
                Effect.map((session) => ({
                  ...session,
                  resumeThread: (input) =>
                    Effect.gen(function* () {
                      resumes.push({
                        instanceId,
                        nativeId: input.providerThread.nativeThreadRef?.nativeId,
                      });
                      return yield* session.resumeThread(input);
                    }),
                  startTurn: (input) =>
                    Effect.gen(function* () {
                      messages.push(input.message.text);
                      yield* session.startTurn(input);
                    }),
                })),
              ),
          } satisfies ProviderAdapterV2Shape;
        });
        const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          get: (instanceId) =>
            Effect.succeed(adapters.find((adapter) => adapter.instanceId === instanceId)!),
          list: () => Effect.succeed([providerInstanceId, targetId]),
          getMetadata: (instanceId) =>
            Effect.succeed({
              driver,
              continuationKey:
                mode === "separate-home" ? `codex:home:/${instanceId}` : "codex:home:/shared",
              enabled: true,
              capabilities,
            }),
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const selection = {
            ...initialSelection,
            model: mode === "active" ? initialSelection.model : "complete",
          };
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${name}:create`),
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            title: name,
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const dispatch = (step: string, modelSelection: ModelSelection, targetRunId?: RunId) =>
            Effect.gen(function* () {
              const terminal = yield* orchestrator.streamDomainEvents.pipe(
                Stream.filter((event) =>
                  mode === "active" && step === "first"
                    ? event.type === "provider-turn.updated" && event.payload.status === "running"
                    : event.type === "run.updated" && event.payload.status === "completed",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`${name}:${step}`),
                threadId,
                messageId: MessageId.make(`${name}:${step}`),
                text: step,
                attachments: [],
                modelSelection,
                dispatchMode:
                  targetRunId === undefined
                    ? { type: "start_immediately" }
                    : { type: "restart_active", targetRunId },
                createdBy: "user",
                creationSource: "web",
              });
              yield* worker.drain();
              yield* Fiber.join(terminal);
              yield* worker.drain();
              return yield* orchestrator.getThreadProjection(threadId);
            });
          const first = yield* dispatch("first", selection);
          const originalThread = first.providerThreads.find(
            (thread) => thread.id === first.thread.activeProviderThreadId,
          )!;
          const targetSelection = { instanceId: targetId, model: "complete" };
          if (mode === "selection-command") {
            yield* orchestrator.dispatch({
              type: "provider.switch",
              commandId: CommandId.make(`${name}:switch`),
              threadId,
              modelSelection: targetSelection,
            });
            yield* worker.drain();
          }
          const second = yield* dispatch(
            "second",
            targetSelection,
            mode === "active" ? first.runs[0]!.id : undefined,
          );
          const targetThread = second.providerThreads.find(
            (thread) => thread.id === second.thread.activeProviderThreadId,
          )!;
          if (mode === "separate-home") {
            assert.notEqual(targetThread.id, originalThread.id);
            assert.lengthOf(second.contextHandoffs, 1);
            assert.lengthOf(second.contextTransfers, 1);
            assert.isEmpty(resumes);
            assert.notEqual(messages[1], "second");
            return;
          }
          assert.equal(targetThread.id, originalThread.id);
          assert.deepEqual(targetThread.nativeThreadRef, originalThread.nativeThreadRef);
          assert.equal(targetThread.providerInstanceId, targetId);
          assert.notEqual(targetThread.providerSessionId, originalThread.providerSessionId);
          assert.isEmpty(second.contextHandoffs);
          assert.isEmpty(second.contextTransfers);
          assert.deepEqual(resumes, [
            { instanceId: targetId, nativeId: originalThread.nativeThreadRef?.nativeId },
          ]);
          assert.deepEqual(messages, ["first", "second"]);
          assert.equal((yield* Ref.get(state)).closedSessionCount, mode === "pooled" ? 0 : 1);
          if (mode === "pooled") {
            assert.isFalse(
              second.providerSessions.some(
                (session) => session.id === originalThread.providerSessionId,
              ),
            );
          }
          const third = yield* dispatch("third", { ...selection, model: "complete" });
          const returnedThread = third.providerThreads.find(
            (thread) => thread.id === third.thread.activeProviderThreadId,
          )!;
          assert.equal(returnedThread.id, originalThread.id);
          assert.deepEqual(returnedThread.nativeThreadRef, originalThread.nativeThreadRef);
          assert.equal(returnedThread.providerInstanceId, providerInstanceId);
          assert.isEmpty(third.contextHandoffs);
          assert.deepEqual(messages, ["first", "second", "third"]);
        }).pipe(Effect.provide(makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry)));
      }),
    ),
);

it.live.each(["before-detach", "after-detach"] as const)(
  "starts a workspace handoff continuation %s without holding its queue",
  (continuationOrder) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `workspace-handoff-${continuationOrder}`;
        const sourceCwd = yield* checkpointWorkspace(`${name}-source`);
        const targetCwd = yield* checkpointWorkspace(`${name}-target`);
        const threadId = ThreadId.make(`thread:${name}`);
        const state = yield* Ref.make<RestartAdapterState>({
          activeTurn: null,
          opened: [],
          started: [],
          closedSessionCount: 0,
          failedReplacementOpen: false,
        });
        const registry = ProviderAdapterRegistry.makeSingleLayer(
          makeRestartAdapter(state, exclusiveCapabilities),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make(`${name}:create`),
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            title: name,
            modelSelection: initialSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: sourceCwd,
          });
          const startSequence = yield* sink.latestSequence();
          const started = yield* sink.stream({ afterSequence: startSequence, threadId }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make(`${name}:first`),
            threadId,
            messageId: MessageId.make(`${name}:first`),
            text: "bind my workspace",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          yield* Fiber.join(started);
          const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          const beforeDetach = yield* sink.latestSequence();
          const ended = yield* sink.stream({ afterSequence: beforeDetach, threadId }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === first.id &&
                ["interrupted", "failed", "cancelled", "completed"].includes(
                  stored.event.payload.status,
                ),
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${name}:bind`),
            threadId,
            worktreePath: targetCwd,
          });
          if (continuationOrder === "after-detach") {
            yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
            yield* worker.drain();
            yield* Fiber.join(ended);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
              "interrupted",
            );
          }
          const beforeContinuation = yield* sink.latestSequence();
          const continuation = yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make(`${name}:continue`),
            threadId,
            messageId: MessageId.make(`${name}:continue`),
            text: "handoff continuation",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
          if (continuationOrder === "before-detach") {
            yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
          }
          if (queued.status === "queued") {
            const promoted = yield* sink
              .stream({ afterSequence: beforeContinuation, threadId })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "run.updated" &&
                    stored.event.payload.id === queued.id &&
                    (stored.event.payload.status === "starting" ||
                      stored.event.payload.queueHeld === true),
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
            yield* worker.drain();
            yield* Fiber.join(ended);
            yield* Fiber.join(promoted);
            const progress = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(progress.runs[1]?.queueHeld ?? false, false);
            assert.equal(progress.runs[0]?.status, "interrupted");
          }
          const completed = yield* sink
            .stream({ afterSequence: continuation.sequence, threadId })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === queued.id &&
                  stored.event.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* worker.drain();
          yield* Fiber.join(completed);
          const settled = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            settled.runs.map((run) => run.status),
            ["interrupted", "completed"],
          );
          assert.equal(settled.providerTurns[0]?.status, "interrupted");
          assert.equal(
            settled.turnItems.find((item) => item.type === "run_interrupt_result")?.message,
            "Run interrupted because the workspace changed",
          );
          assert.isFalse(settled.runs.some((run) => run.queueHeld === true));
          assert.isFalse(settled.turnItems.some((item) => item.type === "error"));
          const captured = yield* Ref.get(state);
          assert.deepEqual(
            captured.started.map((turn) => turn.cwd),
            [sourceCwd, targetCwd],
          );
          assert.equal(captured.closedSessionCount, 1);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry, {
              runEffectWorker: false,
            }),
          ),
        );
      }),
    ),
);

it.live("keeps a delegated workspace handoff pending until its atomic continuation completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "delegated-workspace-handoff";
      const sourceCwd = yield* checkpointWorkspace(`${name}-source`);
      const targetCwd = yield* checkpointWorkspace(`${name}-target`);
      const parentId = ThreadId.make(`thread:${name}:parent`);
      const continuationStarted = yield* Deferred.make<void>();
      const finishContinuation = yield* Deferred.make<void>();
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: false,
      });
      const registry = ProviderAdapterRegistry.makeSingleLayer(
        makeRestartAdapter(
          state,
          exclusiveCapabilities,
          providerInstanceId,
          Deferred.succeed(continuationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishContinuation)),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${name}:parent:create`),
          threadId: parentId,
          projectId: ProjectId.make(`project:${name}`),
          title: name,
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: sourceCwd,
        });
        const beforeStart = yield* sink.latestSequence();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${name}:parent:start`),
          threadId: parentId,
          messageId: MessageId.make(`${name}:parent:start`),
          text: "delegate the work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        yield* sink.stream({ afterSequence: beforeStart, threadId: parentId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const parentRun = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
        const delegated = yield* orchestrator.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make(`${name}:delegate`),
          parentThreadId: parentId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "bind my workspace",
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        const task = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!;
        const childId = task.childThreadId!;
        yield* sink.stream({ afterSequence: delegated.sequence, threadId: childId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const binding = {
          type: "thread.metadata.update" as const,
          commandId: CommandId.make(`${name}:bind`),
          threadId: childId,
          worktreePath: targetCwd,
          expectedWorktreePath: sourceCwd,
          worktreeContinuation: {
            messageId: MessageId.make(`${name}:continue`),
            text: "handoff continuation",
          },
        };
        const bound = yield* orchestrator.dispatch(binding);
        assert.lengthOf(
          bound.storedEvents.filter((stored) => stored.event.type === "run.created"),
          1,
        );
        assert.lengthOf(
          bound.storedEvents.filter((stored) => stored.event.type === "message.updated"),
          1,
        );
        // Repeating the exact handoff cannot enqueue another continuation.
        yield* orchestrator.dispatch(binding);
        const unchangedBinding = yield* orchestrator
          .dispatch({
            ...binding,
            commandId: CommandId.make(`${name}:unchanged-bind`),
            expectedWorktreePath: targetCwd,
            worktreeContinuation: {
              messageId: MessageId.make(`${name}:unchanged-continue`),
              text: "unexpected duplicate continuation",
            },
          })
          .pipe(Effect.flip);
        assert.include(String(unchangedBinding.cause), "changed worktree binding");
        yield* Deferred.await(continuationStarted);
        const beforeCompletion = yield* orchestrator.getThreadProjection(parentId);
        assert.isNull(beforeCompletion.subagents[0]?.result);
        assert.isNull(beforeCompletion.subagents[0]?.completionDelivery ?? null);
        assert.isFalse(
          beforeCompletion.contextTransfers.some((transfer) => transfer.type === "subagent_result"),
        );
        const continuing = yield* orchestrator.getThreadProjection(childId);
        assert.deepEqual(
          continuing.runs.map((run) => run.status),
          ["interrupted", "running"],
        );
        assert.isFalse(continuing.runs.some((run) => run.queueHeld));
        const beforeFinish = yield* sink.latestSequence();
        yield* Deferred.succeed(finishContinuation, undefined);
        yield* sink.stream({ afterSequence: beforeFinish, threadId: parentId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === task.id &&
              stored.event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const finished = yield* orchestrator.getThreadProjection(parentId);
        assert.equal(finished.subagents[0]?.status, "completed");
        assert.equal(finished.subagents[0]?.result, "Completed inside the new worktree");
        assert.lengthOf(
          finished.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
          1,
        );
        const childFinished = yield* orchestrator.getThreadProjection(childId);
        assert.deepEqual(
          childFinished.runs.map((run) => run.status),
          ["interrupted", "completed"],
        );
        assert.lengthOf(
          childFinished.messages.filter((message) => message.text === "handoff continuation"),
          1,
        );
        assert.isFalse(
          childFinished.messages.some(
            (message) => message.text === "unexpected duplicate continuation",
          ),
        );
        assert.isFalse(childFinished.turnItems.some((item) => item.type === "error"));
        const assistantItems = childFinished.visibleTurnItems.flatMap((row) =>
          row.item.type === "assistant_message" ? [row.item] : [],
        );
        assert.lengthOf(assistantItems, 1);
        assert.equal(assistantItems[0]?.text, "Completed inside the new worktree");
        const assistantMessage = childFinished.messages.find(
          (message) => message.role === "assistant",
        );
        assert.equal(assistantItems[0]?.messageId, assistantMessage?.id);
        assert.equal(assistantItems[0]?.text, assistantMessage?.text);

        assert.deepEqual(
          (yield* Ref.get(state)).started.map((turn) => turn.cwd),
          [sourceCwd, sourceCwd, targetCwd],
        );
      }).pipe(Effect.provide(makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry)));
    }),
  ),
);

it.live.each(["provider-crash", "explicit-stop"] as const)(
  "preserves real queued input until explicitly resumed after %s",
  (termination) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `queued-control-${termination}`;
        const cwd = yield* checkpointWorkspace(name);
        const threadId = ThreadId.make(`thread:${name}`);
        const crash = yield* Deferred.make<void>();
        const firstSession = yield* Ref.make(true);
        const state = yield* Ref.make<RestartAdapterState>({
          activeTurn: null,
          opened: [],
          started: [],
          closedSessionCount: 0,
          failedReplacementOpen: false,
        });
        const base = makeRestartAdapter(state, exclusiveCapabilities);
        const adapter: ProviderAdapterV2Shape = {
          ...base,
          openSession: (input) =>
            base.openSession(input).pipe(
              Effect.flatMap((session) =>
                Ref.getAndSet(firstSession, false).pipe(
                  Effect.map((isFirst) => ({
                    ...session,
                    events:
                      termination === "explicit-stop" || !isFirst
                        ? session.events
                        : Stream.merge(
                            session.events,
                            Stream.fromEffect(
                              Deferred.await(crash).pipe(
                                Effect.andThen(
                                  Effect.fail(
                                    new ProviderAdapterEventStreamError({
                                      driver,
                                      providerSessionId: input.providerSessionId,
                                      cause: "Simulated provider crash",
                                    }),
                                  ),
                                ),
                              ),
                            ),
                          ),
                  })),
                ),
              ),
            ),
        };
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${name}:create`),
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            title: name,
            modelSelection: initialSelection,
            createdBy: "user",
            creationSource: "web",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          const beforeStart = yield* sink.latestSequence();
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${name}:first`),
            threadId,
            messageId: MessageId.make(`${name}:first`),
            createdBy: "user",
            creationSource: "web",
            text: "keep working",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          yield* sink.stream({ threadId, afterSequence: beforeStart }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          const queuedCommand = {
            type: "message.dispatch" as const,
            commandId: CommandId.make(`${name}:queue`),
            threadId,
            messageId: MessageId.make(`${name}:queue`),
            createdBy: "user" as const,
            creationSource: "web" as const,
            text: "handoff continuation",
            attachments: [],
            dispatchMode: { type: "queue_after_active" as const },
          };
          const queuedReceipt = yield* orchestrator.dispatch(queuedCommand);
          const queuedState = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            queuedState.runs.map((run) => run.status),
            ["running", "queued"],
          );
          const originalRun = queuedState.runs[0]!;
          const queuedRun = queuedState.runs[1]!;
          if (termination === "provider-crash") yield* Deferred.succeed(crash, undefined);
          else
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make(`${name}:stop`),
              threadId,
              runId: originalRun.id,
              holdQueue: true,
            });
          yield* sink.stream({ threadId, afterSequence: queuedReceipt.sequence }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === queuedRun.id &&
                stored.event.payload.queueHeld === true,
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          const held = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(held.runs[1]?.status, "queued");
          assert.equal(
            held.messages.find((message) => message.id === queuedCommand.messageId)?.text,
            queuedCommand.text,
          );
          assert.lengthOf((yield* Ref.get(state)).started, 1);
          const resumed = yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${name}:resume`),
            threadId,
          });
          yield* sink.stream({ threadId, afterSequence: resumed.sequence }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === queuedRun.id &&
                stored.event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          const completed = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            completed.runs.map((run) => run.status),
            [termination === "provider-crash" ? "failed" : "interrupted", "completed"],
          );
          assert.isFalse(completed.runs.some((run) => run.queueHeld));
          assert.lengthOf(
            completed.messages.filter((message) => message.id === queuedCommand.messageId),
            1,
          );
          assert.lengthOf((yield* Ref.get(state)).started, 2);
          assert.equal(
            completed.messages.find((message) => message.role === "assistant")?.text,
            "Completed inside the new worktree",
          );
          if (termination === "provider-crash")
            assert.isTrue(
              completed.turnItems.some(
                (item) => item.type === "error" && item.runId === originalRun.id,
              ),
            );
          else
            assert.equal(
              completed.turnItems.find((item) => item.type === "run_interrupt_result")?.message,
              "Run interrupted by user",
            );
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name },
              ProviderAdapterRegistry.makeSingleLayer(adapter),
            ),
          ),
        );
      }),
    ),
);
