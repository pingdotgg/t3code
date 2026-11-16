import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { fyiWakeGate, wakeCommand } from "./Fyi.ts";
import * as FyiWakeWorker from "./FyiWakeWorker.ts";

const startMs = Date.parse("2026-11-16T00:00:00.000Z");
const at = (hours: number) => DateTime.makeUnsafe(startMs + hours * 60 * 60 * 1_000);
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const runEvent = (
  threadId: ThreadId,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  hour: number,
  userMessageId = MessageId.make(`message:${threadId}:${ordinal}`),
): Omit<OrchestrationV2DomainEvent, "id"> => ({
  type: "run.created",
  threadId,
  occurredAt: at(hour),
  payload: {
    id: RunId.make(`run:${threadId}:${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId,
    rootNodeId: NodeId.make(`node:${threadId}:${ordinal}`),
    activeAttemptId: null,
    status,
    requestedAt: at(hour),
    startedAt: at(hour),
    completedAt: status === "running" || status === "queued" ? null : at(hour),
    checkpointId: null,
    contextHandoffId: null,
  },
});

/** A turn item of the thread's run at `ordinal`, on that run's root node. */
const runItem = (
  threadId: ThreadId,
  ordinal: number,
  hour: number,
  item: Pick<
    Extract<OrchestrationV2TurnItem, { readonly type: "run_interrupt_request" | "error" }>,
    "type" | "status"
  > &
    ({ readonly message: string } | { readonly failure: OrchestrationV2ProviderFailure }),
): Omit<OrchestrationV2DomainEvent, "id"> =>
  ({
    type: "turn-item.updated",
    threadId,
    occurredAt: at(hour),
    payload: {
      id: TurnItemId.make(`item:${threadId}:${ordinal}:${item.type}`),
      threadId,
      runId: RunId.make(`run:${threadId}:${ordinal}`),
      nodeId: NodeId.make(`node:${threadId}:${ordinal}`),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ordinal * 100 + 1,
      title: null,
      startedAt: at(hour),
      completedAt: at(hour),
      updatedAt: at(hour),
      ...item,
    },
  }) as Omit<OrchestrationV2DomainEvent, "id">;

/** A waiting FYI sent to the thread at `hour`. */
const fyiEvent = (threadId: ThreadId, hour: number): Omit<OrchestrationV2DomainEvent, "id"> => ({
  type: "turn-item.updated",
  threadId,
  occurredAt: at(hour),
  payload: {
    id: TurnItemId.make(`item:${threadId}:fyi:${hour}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1_000_000 + hour * 100,
    status: "pending",
    title: null,
    startedAt: at(hour),
    completedAt: null,
    updatedAt: at(hour),
    type: "user_message",
    messageId: MessageId.make(`message:${threadId}:fyi:${hour}`),
    createdBy: "agent",
    creationSource: "mcp",
    inputIntent: "steer",
    text: "main moved",
    attachments: [],
    fyi: true,
  },
});

/** A thread whose one run, if any, ended at hour 0 and whose FYI was sent at `fyiAt`. */
const seedThread = (
  key: string,
  fyiAt: number,
  runStatus: OrchestrationV2Run["status"] | null,
  thread: {
    readonly archivedAt?: DateTime.Utc;
    readonly settledOverride?: "settled";
    readonly snoozedUntil?: DateTime.Utc;
    readonly pendingRequest?: true;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly runEvents?: (
      threadId: ThreadId,
    ) => ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>;
  } = {},
) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:${key}`);
    const instanceId = thread.providerInstanceId ?? modelSelection.instanceId;
    const events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> = [
      {
        type: "thread.created",
        threadId,
        occurredAt: at(0),
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:fyi-wake"),
          title: key,
          providerInstanceId: instanceId,
          modelSelection: { ...modelSelection, instanceId },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: at(0),
          updatedAt: at(0),
          archivedAt: thread.archivedAt ?? null,
          settledOverride: thread.settledOverride ?? null,
          ...(thread.snoozedUntil === undefined ? {} : { snoozedUntil: thread.snoozedUntil }),
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
      ...(runStatus === null ? [] : [runEvent(threadId, 1, runStatus, 0)]),
      ...(thread.runEvents?.(threadId) ?? []),
      fyiEvent(threadId, fyiAt),
      ...(thread.pendingRequest
        ? [
            {
              type: "runtime-request.updated" as const,
              threadId,
              occurredAt: at(0),
              payload: {
                id: RuntimeRequestId.make(`request:${key}`),
                nodeId: NodeId.make(`node:${key}`),
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input" as const,
                status: "pending" as const,
                responseCapability: { type: "message" as const },
                createdAt: at(0),
                resolvedAt: null,
              },
            },
          ]
        : []),
    ];
    for (const [index, event] of events.entries()) {
      yield* store.apply({
        ...event,
        id: EventId.make(`event:${key}:${index}`),
      } as OrchestrationV2DomainEvent);
    }
  });

const userStop = {
  type: "run_interrupt_request",
  status: "completed",
  message: "Stopped by user",
} as const;

const usageLimit = (resetHour: number) =>
  ({
    type: "error",
    status: "failed",
    failure: {
      class: "usage_limit",
      message: "Usage limit reached.",
      code: null,
      retryable: null,
      resetAt: DateTime.formatIso(at(resetHour)),
    },
  }) as const;

/** The orchestrator gate's wake for the thread now: its command id, or why it refuses. */
const gateWake = (store: ProjectionStore.ProjectionStoreV2Shape, threadId: ThreadId) =>
  Effect.gen(function* () {
    const decision = fyiWakeGate({
      projection: yield* store.getThreadProjection(threadId),
      settings: DEFAULT_SERVER_SETTINGS,
      now: yield* DateTime.now,
    });
    return decision.due
      ? wakeCommand(threadId, decision.idleFrom).commandId
      : `refused: ${decision.reason}`;
  }).pipe(Effect.orDie);

it.effect(
  "wakes each idle thread 6 hours after it went idle, and no busy, archived, settled or asking one",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at(5)));
      const dispatched = yield* Queue.unbounded<string>();
      const layerDatabase = ProjectionStore.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
      );
      yield* Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        yield* seedThread("due", 1, "completed");
        yield* seedThread("later", 1, "completed", {
          runEvents: (threadId) => [runEvent(threadId, 2, "completed", 5)],
        });
        yield* seedThread("no-run", 1, null);
        yield* seedThread("busy", 1, "running");
        yield* seedThread("archived", 1, "completed", { archivedAt: at(2) });
        yield* seedThread("settled", 1, "completed", { settledOverride: "settled" });
        yield* seedThread("asking", 1, "completed", { pendingRequest: true });
        yield* seedThread("stopped", 1, "interrupted", {
          runEvents: (threadId) => [runItem(threadId, 1, 0, userStop)],
        });
        yield* seedThread("agent-stopped", 1, "interrupted", {
          runEvents: (threadId) => [
            runItem(threadId, 1, 0, { ...userStop, message: "Stopped by an agent" }),
          ],
        });
        // Held queues run out of ordinal order: the limited run ended first, so it is not the latest.
        yield* seedThread("ended-later", 1, "completed", {
          runEvents: (threadId) => [
            runEvent(threadId, 1, "completed", 0.5),
            runEvent(threadId, 2, "failed", 0.25),
            runItem(threadId, 2, 0.25, usageLimit(20)),
          ],
        });
        yield* seedThread("after-wake", 1, "completed", {
          runEvents: (threadId) => [
            runEvent(threadId, 2, "completed", 2, MessageId.make(`message:fyi-wake:${threadId}`)),
          ],
        });
        yield* seedThread("limited", 1, "failed", {
          runEvents: (threadId) => [runItem(threadId, 1, 0, usageLimit(20))],
        });
        yield* seedThread("limit-reset", 1, "failed", {
          runEvents: (threadId) => [runItem(threadId, 1, 0, usageLimit(3))],
        });
        // The limited agent may run again when the later of its reset and its snooze ends.
        yield* seedThread("limit-snoozed", 1, "failed", {
          snoozedUntil: at(4),
          runEvents: (threadId) => [runItem(threadId, 1, 0, usageLimit(3))],
        });
        yield* seedThread("limit-rolled-back", 2, "failed", {
          runEvents: (threadId) => [
            runItem(threadId, 1, 0, usageLimit(20)),
            { ...runEvent(threadId, 1, "rolled_back", 1), type: "run.updated" },
          ],
        });
        yield* seedThread("limit-other-provider", 1, "failed", {
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runEvents: (threadId) => [runItem(threadId, 1, 0, usageLimit(20))],
        });
        const woken = new Set<ThreadId>();
        // Every seeded thread the sweep has not woken gets no wake from the gate either.
        const assertGateRefusesTheRest = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ readonly thread_id: ThreadId }>`
            SELECT thread_id FROM orchestration_v2_projection_threads`;
          for (const { thread_id } of threads) {
            if (woken.has(thread_id)) continue;
            assert.match(
              yield* gateWake(store, thread_id),
              /^refused: /,
              `the gate agrees the sweep sends ${thread_id} no wake`,
            );
          }
        }).pipe(Effect.orDie);
        yield* Effect.gen(function* () {
          // An adjust waits for the sweeps it wakes, so every wake due by then has been sent.
          yield* TestClock.adjust("2 hours");
          assert.deepStrictEqual((yield* Queue.clear(dispatched)).toSorted(), [
            "command:fyi-wake:thread:agent-stopped:2026-11-16T00:00:00.000Z",
            "command:fyi-wake:thread:due:2026-11-16T00:00:00.000Z",
            "command:fyi-wake:thread:ended-later:2026-11-16T00:30:00.000Z",
            "command:fyi-wake:thread:limit-other-provider:2026-11-16T00:00:00.000Z",
            "command:fyi-wake:thread:limit-rolled-back:2026-11-16T01:00:00.000Z",
            "command:fyi-wake:thread:no-run:2026-11-16T00:00:00.000Z",
            "command:fyi-wake:thread:stopped:2026-11-16T00:00:00.000Z",
          ]);
          yield* assertGateRefusesTheRest;
          yield* TestClock.adjust("4 hours");
          assert.deepStrictEqual(
            (yield* Queue.clear(dispatched)).toSorted(),
            [
              "command:fyi-wake:thread:after-wake:2026-11-16T02:00:00.000Z",
              "command:fyi-wake:thread:later:2026-11-16T05:00:00.000Z",
              "command:fyi-wake:thread:limit-reset:2026-11-16T03:00:00.000Z",
              "command:fyi-wake:thread:limit-snoozed:2026-11-16T04:00:00.000Z",
            ],
            "a woken thread is busy; no wake reaches a busy, archived, settled or asking thread, or one whose usage limit resets later",
          );
          yield* assertGateRefusesTheRest;
        }).pipe(
          Effect.provide(
            FyiWakeWorker.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Scheduler.layer,
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    // The wake's run makes the thread busy, as the real dispatch does.
                    dispatch: (command) =>
                      command.type !== "message.dispatch"
                        ? Effect.die("The sweep sends only messages.")
                        : Effect.gen(function* () {
                            woken.add(command.threadId);
                            const gate = yield* gateWake(store, command.threadId);
                            // The gate must send the same wake, or the sweep would retry a refused one.
                            yield* Queue.offer(
                              dispatched,
                              gate === command.commandId
                                ? command.commandId
                                : `${command.commandId} (gate: ${gate})`,
                            );
                            yield* store.apply({
                              ...runEvent(command.threadId, 9, "running", 7),
                              id: EventId.make(`event:wake:${command.commandId}`),
                            } as OrchestrationV2DomainEvent);
                            return { sequence: 0, storedEvents: [] };
                          }).pipe(Effect.orDie),
                  }),
                  Layer.mock(ServerSettings.ServerSettingsService)({
                    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                  }),
                ),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(layerDatabase));
    }),
);

it.effect("a sweep builds the FYI index that failed at startup, then wakes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(at(7)));
    const dispatched = yield* Queue.unbounded<string>();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE fork_fyi_turn_items_idx (blocks_the_index_name INTEGER)`;
      yield* seedThread("unindexed", 1, "completed");
      yield* Effect.gen(function* () {
        yield* sql`DROP TABLE fork_fyi_turn_items_idx`;
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual(
          yield* Queue.take(dispatched),
          "command:fyi-wake:thread:unindexed:2026-11-16T00:00:00.000Z",
        );
        const indexes = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'fork_fyi_turn_items_idx'`;
        assert.lengthOf(indexes, 1, "the sweep built the index");
      }).pipe(
        Effect.provide(
          FyiWakeWorker.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Scheduler.layer,
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  dispatch: (command) =>
                    Queue.offer(dispatched, command.commandId).pipe(
                      Effect.as({ sequence: 0, storedEvents: [] }),
                    ),
                }),
                Layer.mock(ServerSettings.ServerSettingsService)({
                  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    );
  }),
);
