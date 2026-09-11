import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, type OrchestrationCommand, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import * as ProjectionThreadActivities from "../persistence/Services/ProjectionThreadActivities.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import {
  settleThreadsTasks,
  settleThreadTasks,
  type TaskActivityRow,
} from "./ThreadTaskSettlement.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

const liveRowsFor = (taskId: string): ReadonlyArray<TaskActivityRow> => [
  { kind: "task.started", payload: { taskId, agentKind: "agent", title: taskId } },
  { kind: "task.updated", payload: { taskId, status: "running", agentKind: "agent" } },
];

/**
 * Fills the columns settlement never reads, so the repository double returns
 * the same rows the real one does.
 */
const toActivityRows = (
  threadId: ThreadId,
  rows: ReadonlyArray<TaskActivityRow>,
): ReadonlyArray<ProjectionThreadActivities.ProjectionThreadActivity> =>
  rows.map((row, index) => ({
    activityId: EventId.make(`activity-${threadId}-${index}`),
    threadId,
    turnId: null,
    tone: "info",
    kind: row.kind,
    summary: row.kind,
    payload: row.payload,
    createdAt,
  }));

const settledTaskIds = (dispatched: ReadonlyArray<OrchestrationCommand>): ReadonlyArray<string> =>
  dispatched.flatMap((command) =>
    command.type === "thread.activity.append" &&
    typeof command.activity.payload === "object" &&
    command.activity.payload !== null
      ? [String((command.activity.payload as { taskId?: unknown }).taskId)]
      : [],
  );

/**
 * Provides the settlement dependencies. `failFor` decides which appends blow
 * up, so a test can prove the loop keeps going past a failure.
 */
const withSettlementServices = (input: {
  readonly activitiesByThreadId: Readonly<Record<string, ReadonlyArray<TaskActivityRow>>>;
  readonly dispatched: Array<OrchestrationCommand>;
  readonly liveness: ThreadBackgroundLiveness.ThreadBackgroundLivenessService["Service"];
  readonly failFor?: (command: OrchestrationCommand) => boolean;
}) => {
  const repository = {
    upsert: () => Effect.die("unused"),
    listByThreadId: () => Effect.die("unused"),
    listUserInputLifecycleByThreadId: () => Effect.die("unused"),
    getLatestTaskActivity: () => Effect.die("unused"),
    deleteByThreadId: () => Effect.die("unused"),
    listTaskLifecycleByThreadId: ({ threadId }) =>
      Effect.succeed(toActivityRows(threadId, input.activitiesByThreadId[threadId] ?? [])),
    listTaskLifecycleByThreadIds: ({ threadIds }) =>
      Effect.succeed(
        threadIds.flatMap((threadId) =>
          toActivityRows(threadId, input.activitiesByThreadId[threadId] ?? []),
        ),
      ),
  } satisfies ProjectionThreadActivities.ProjectionThreadActivityRepository["Service"];

  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        ProjectionThreadActivities.ProjectionThreadActivityRepository,
        repository,
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) => {
          if (input.failFor?.(command) === true) {
            return Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "simulated settlement append failure",
              }),
            );
          }
          input.dispatched.push(command);
          return Effect.succeed({ sequence: input.dispatched.length });
        },
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
      Effect.provideService(
        ThreadBackgroundLiveness.ThreadBackgroundLivenessService,
        input.liveness,
      ),
      Effect.provide(NodeServices.layer),
    );
};

it.effect("settles the rest of the fleet when one task's append fails", () => {
  const threadId = ThreadId.make("thread-partial-failure");
  const dispatched: Array<OrchestrationCommand> = [];
  const liveness = ThreadBackgroundLiveness.make();
  for (const taskId of ["child-one", "child-two"]) {
    liveness.recordTaskLiveness({
      threadId,
      taskId,
      taskType: undefined,
      status: "running",
      kind: "updated",
    });
  }

  return settleThreadTasks({ threadId, status: "interrupted", createdAt }).pipe(
    withSettlementServices({
      activitiesByThreadId: {
        [threadId]: [...liveRowsFor("child-one"), ...liveRowsFor("child-two")],
      },
      dispatched,
      liveness,
      failFor: (command) =>
        command.type === "thread.activity.append" &&
        command.activity.id === `task-settled:${threadId}:child-one`,
    }),
    Effect.tap(() =>
      Effect.sync(() => {
        // The failed task keeps no row, so it must keep no tombstone either;
        // the second task settles regardless.
        assert.deepStrictEqual(settledTaskIds(dispatched), ["child-two"]);
        assert.equal(liveness.getThreadBackgroundLiveness(threadId), "working");
        liveness.recordTaskLiveness({
          threadId,
          taskId: "child-one",
          taskType: undefined,
          status: "interrupted",
          kind: "updated",
          settledByHost: true,
        });
        assert.equal(liveness.getThreadBackgroundLiveness(threadId), null);
      }),
    ),
  );
});

it.effect("a failing thread does not block the threads after it in a batch", () => {
  const failing = ThreadId.make("thread-batch-failing");
  const healthy = ThreadId.make("thread-batch-healthy");
  const dispatched: Array<OrchestrationCommand> = [];
  const liveness = ThreadBackgroundLiveness.make();
  liveness.recordTaskLiveness({
    threadId: healthy,
    taskId: "child-two",
    taskType: undefined,
    status: "running",
    kind: "updated",
  });

  return settleThreadsTasks({
    threadIds: [failing, healthy],
    status: "interrupted",
    createdAt,
  }).pipe(
    withSettlementServices({
      activitiesByThreadId: {
        [failing]: liveRowsFor("child-one"),
        [healthy]: liveRowsFor("child-two"),
      },
      dispatched,
      liveness,
      failFor: (command) =>
        command.type === "thread.activity.append" && command.threadId === failing,
    }),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepStrictEqual(settledTaskIds(dispatched), ["child-two"]);
        assert.equal(liveness.getThreadBackgroundLiveness(healthy), null);
      }),
    ),
  );
});
