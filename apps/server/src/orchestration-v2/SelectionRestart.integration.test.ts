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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

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
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
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
  beforeTurn?: (
    input: ProviderAdapter.ProviderAdapterV2TurnInput,
    publish: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>,
  ) => Effect.Effect<boolean>,
): ProviderAdapter.ProviderAdapterV2["Service"] {
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
          return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: sessionInput.providerSessionId,
            cause: "simulated replacement open failure",
          });
        }

        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
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
              if (
                beforeTurn !== undefined &&
                (yield* beforeTurn(input, (event) =>
                  Queue.offer(events, event).pipe(Effect.asVoid),
                ))
              )
                return;
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

function makeCompletingHandoffAdapter(
  startCount: Ref.Ref<number>,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: handoffProviderInstanceId,
    driver: handoffDriver,
    getCapabilities: () => Effect.succeed(exclusiveCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
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

it.live("retries a failed selection restart session open before completing", () =>
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
      const layerRegistry = ProviderAdapterRegistry.layerSingle(makeRestartAdapter(state));

      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;

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
        const running = yield* eventSink
          .stream({
            threadId,
            afterSequence: yield* eventSink.latestSequence({ threadId }),
          })
          .pipe(
            Stream.map((stored) => stored.event),
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
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
        yield* Fiber.join(running);
        yield* worker.drain();
        const activeProjection = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(activeProjection.providerTurns.some((turn) => turn.status === "running"));
        const activeRunId = activeProjection.runs[0]?.id;
        if (activeRunId === undefined) {
          return yield* Effect.die("active restart test run is missing");
        }

        const completed = yield* eventSink
          .stream({
            threadId,
            afterSequence: yield* eventSink.latestSequence({ threadId }),
          })
          .pipe(
            Stream.map((stored) => stored.event),
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
          commandId: CommandId.make("command:selection-restart:second"),
          threadId,
          messageId: MessageId.make("message:selection-restart:second"),
          text: "second",
          attachments: [],
          modelSelection: replacementSelection,
          dispatchMode: { type: "restart_active", targetRunId: activeRunId },
        });
        yield* Fiber.join(completed);
        yield* worker.drain();
        return {
          projection: yield* orchestrator.getThreadProjection(threadId),
          captured: yield* Ref.get(state),
        };
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "selection-restart-lifecycle" },
            layerRegistry,
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
      assert.equal(projection.runs.at(-1)?.modelSelection.model, replacementSelection.model);
      assert.equal(projection.runs.at(-1)?.status, "completed");
      assert.isTrue(captured.failedReplacementOpen);
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
          failedReplacementOpen: true,
        });
        const layerRegistry = ProviderAdapterRegistry.layerSingle(
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
        }).pipe(Effect.provide(ProviderReplayHarness.layerWithRegistry({ name }, layerRegistry)));

        const { projection, captured } = result;
        assert.lengthOf(projection.runs, 2);
        assert.equal(projection.runs[1]?.modelSelection.model, replacementSelection.model);
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
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
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
          ProviderReplayHarness.layerWithRegistry(
            { name: "selection-provider-handoff-lifecycle" },
            layerRegistry,
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
          } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
        });
        const layerRegistry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
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
        }).pipe(Effect.provide(ProviderReplayHarness.layerWithRegistry({ name }, layerRegistry)));
      }),
    ),
);

it.live.each(["exclusive", "shared"] as const)(
  "keeps a delegated %s workspace handoff pending through its atomic continuation",
  (sessionMode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `delegated-workspace-handoff-${sessionMode}`;
        const childReady = yield* Deferred.make<{
          input: ProviderAdapter.ProviderAdapterV2TurnInput;
          publish: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
        }>();
        const parentReady = yield* Deferred.make<{
          input: ProviderAdapter.ProviderAdapterV2TurnInput;
          publish: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
        }>();
        const sourceCwd = yield* checkpointWorkspace(`${name}-source`);
        const targetCwd = yield* checkpointWorkspace(`${name}-target`);
        const parentId = ThreadId.make(`thread:${name}:parent`);
        const contextReadStarted = yield* Deferred.make<void>();
        const finishContextRead = yield* Deferred.make<void>();
        const continuationStarted = yield* Deferred.make<void>();
        const finishContinuation = yield* Deferred.make<void>();
        const state = yield* Ref.make<RestartAdapterState>({
          activeTurn: null,
          opened: [],
          started: [],
          closedSessionCount: 0,
          failedReplacementOpen: false,
        });
        const registry = ProviderAdapterRegistry.layerSingle(
          makeRestartAdapter(
            state,
            sessionMode === "shared" ? pooledCapabilities : exclusiveCapabilities,
            providerInstanceId,
            Deferred.succeed(continuationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishContinuation)),
            ),
            (input, publish) =>
              input.message.text.endsWith("bind my workspace")
                ? Deferred.succeed(childReady, { input, publish }).pipe(Effect.as(true))
                : Deferred.succeed(parentReady, { input, publish }).pipe(Effect.as(false)),
          ),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
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
          yield* worker.drain();
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
          yield* orchestrator.dispatch({
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
          const startingChild = yield* worker.drain(1).pipe(Effect.forkScoped);
          yield* Deferred.await(contextReadStarted);
          assert.lengthOf((yield* Ref.get(state)).started, 1);
          const parent = yield* Deferred.await(parentReady);
          const parentSessionId = parent.input.providerThread.providerSessionId;
          assert.isNotNull(parentSessionId);
          const initialChild = yield* orchestrator.getThreadProjection(childId);
          assert.isEmpty(initialChild.providerTurns);
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
          const boundChild = yield* orchestrator.getThreadProjection(childId);
          assert.equal(boundChild.thread.worktreePath, targetCwd);
          assert.deepEqual(
            boundChild.runs.map((run) => run.status),
            ["running", "queued"],
          );
          assert.equal(
            boundChild.messages.find(
              (message) => message.id === binding.worktreeContinuation.messageId,
            )?.text,
            "handoff continuation",
          );
          assert.equal(
            boundChild.checkpointScopes.find((scope) => scope.runId === boundChild.runs[1]?.id)
              ?.cwd,
            targetCwd,
          );
          assert.deepEqual(yield* orchestrator.dispatch(binding), bound);
          for (const worktreePath of [undefined, targetCwd]) {
            const rejected = yield* orchestrator
              .dispatch({
                ...binding,
                commandId: CommandId.make(`${name}:reject:${worktreePath ?? "branch-only"}`),
                branch: "feature/branch-only",
                worktreePath,
                expectedWorktreePath: targetCwd,
                worktreeContinuation: {
                  messageId: MessageId.make(`${name}:rejected-continue`),
                  text: "unexpected duplicate continuation",
                },
              })
              .pipe(Effect.flip);
            assert.include(String(rejected.cause), "changed worktree binding");
          }
          // The real outbox must keep the detach behind startup, even while
          // the event subscriber exists and the app-context read is suspended.
          assert.isFalse(yield* worker.runOnce);
          assert.isFalse(yield* Deferred.isDone(childReady));
          yield* Deferred.succeed(finishContextRead, undefined);
          yield* Fiber.join(startingChild);
          const child = yield* Deferred.await(childReady);
          assert.equal(
            child.input.providerThread.providerSessionId ===
              parent.input.providerThread.providerSessionId,
            sessionMode === "shared",
          );
          yield* worker.drain(1);
          // A late provider message is a deterministic fence: a detached subscription
          // must end before it can ingest another event for the old run.
          const fenceAt = yield* DateTime.now;
          const publishFence = ({ input, publish }: typeof child, text: string) =>
            publish({
              type: "message.updated",
              driver,
              message: {
                id: MessageId.make(`${input.runId}:${text}`),
                threadId: input.threadId,
                runId: input.runId,
                nodeId: input.rootNodeId,
                role: "assistant",
                text,
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: fenceAt,
                updatedAt: fenceAt,
              },
            });
          yield* publishFence(child, "late-after-detach");
          yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
          yield* sink.stream({ afterSequence: bound.sequence, threadId: childId }).pipe(
            Stream.filter(
              ({ event }) =>
                (event.type === "run.updated" &&
                  event.payload.id === child.input.runId &&
                  ["interrupted", "failed", "completed"].includes(event.payload.status)) ||
                (event.type === "message.updated" && event.payload.text === "late-after-detach"),
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          const detached = yield* orchestrator.getThreadProjection(childId);
          assert.equal(
            detached.runs[0]?.status,
            "interrupted",
            "planned detach must terminate the moving run before another provider event is ingested",
          );
          assert.equal(
            detached.turnItems.find((item) => item.type === "run_interrupt_result")?.message,
            "Run interrupted because the workspace changed",
          );
          yield* Deferred.await(continuationStarted);
          yield* publishFence(parent, "parent-still-alive");
          yield* sink.stream({ afterSequence: bound.sequence, threadId: parentId }).pipe(
            Stream.filter(
              ({ event }) =>
                (event.type === "message.updated" && event.payload.text === "parent-still-alive") ||
                (event.type === "run.updated" &&
                  event.payload.id === parentRun.id &&
                  ["interrupted", "failed", "completed"].includes(event.payload.status)),
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          assert.isTrue(yield* manager.isLive(parentSessionId));
          assert.equal(
            (yield* orchestrator.getThreadProjection(parentId)).runs[0]?.status,
            "running",
          );
          const beforeCompletion = yield* orchestrator.getThreadProjection(parentId);
          assert.isNull(beforeCompletion.subagents[0]?.result);
          assert.isNull(beforeCompletion.subagents[0]?.completionDelivery ?? null);
          assert.isFalse(
            beforeCompletion.contextTransfers.some(
              (transfer) => transfer.type === "subagent_result",
            ),
          );
          const continuing = yield* orchestrator.getThreadProjection(childId);
          assert.deepEqual(
            continuing.runs.map((run) => run.status),
            ["interrupted", "running"],
          );
          assert.isFalse(continuing.runs.some((run) => run.queueHeld));
          assert.equal(continuing.runs[1]?.delegatedTaskId, continuing.runs[0]?.delegatedTaskId);
          assert.equal(continuing.runs[1]?.restartContinuationOfRunId, continuing.runs[0]?.id);
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
          assert.deepEqual(
            (yield* Ref.get(state)).started.map((turn) => turn.cwd),
            [sourceCwd, sourceCwd, targetCwd],
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry({ name }, registry, {
              runEffectWorker: false,
              mcpAppModelContextLayer: Layer.mock(McpAppModelContext.McpAppModelContext)({
                forThread: (threadId) =>
                  threadId === parentId
                    ? Effect.succeed([])
                    : Deferred.succeed(contextReadStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(finishContextRead)),
                        Effect.as([]),
                      ),
              }),
            }),
          ),
        );
      }),
    ),
);
