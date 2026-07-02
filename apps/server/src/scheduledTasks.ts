import {
  CommandId,
  MessageId,
  ScheduledTaskError,
  ScheduledTaskId,
  ScheduledAgentTask as ScheduledAgentTaskSchema,
  STANDALONE_CHAT_PROJECT_ID,
  type ScheduledAgentTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskSnapshot,
  type ScheduledTaskUpdateInput,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import * as ServerConfig from "./config.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrapDispatcher from "./orchestration/ThreadTurnBootstrapDispatcher.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const CADENCE_MS = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
} as const satisfies Record<ScheduledAgentTask["cadence"], number>;

const PersistedScheduledTasksState = Schema.Struct({
  version: Schema.Literal(1),
  tasks: Schema.Array(ScheduledAgentTaskSchema),
});
type PersistedScheduledTasksState = typeof PersistedScheduledTasksState.Type;
type ScheduledTaskOperation = ScheduledTaskError["operation"];

const decodePersistedScheduledTasksState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedScheduledTasksState),
);
const encodePersistedScheduledTasksState = Schema.encodeSync(
  Schema.fromJsonString(PersistedScheduledTasksState),
);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export interface ScheduledTasksLiveOptions {
  readonly sweepIntervalMs?: number;
}

export class ScheduledTasks extends Context.Service<
  ScheduledTasks,
  {
    readonly list: Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    readonly create: (
      input: ScheduledTaskCreateInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly update: (
      input: ScheduledTaskUpdateInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly runDueTasks: Effect.Effect<void, never>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<ScheduledTaskSnapshot>>;
  }
>()("t3/scheduledTasks") {}

function taskOrder(
  left: ScheduledAgentTask | ScheduledTaskSnapshot,
  right: ScheduledAgentTask | ScheduledTaskSnapshot,
): number {
  return (
    left.title.localeCompare(right.title) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function nextRunAt(task: ScheduledAgentTask): string | null {
  if (!task.enabled || task.lastFinishedAt === null) {
    return null;
  }
  const lastFinishedMs = Date.parse(task.lastFinishedAt);
  if (Number.isNaN(lastFinishedMs)) {
    return null;
  }
  return Option.match(DateTime.make(lastFinishedMs + CADENCE_MS[task.cadence]), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function toSnapshot(
  task: ScheduledAgentTask,
  runningTaskIds: ReadonlySet<ScheduledTaskId>,
): ScheduledTaskSnapshot {
  const runState: ScheduledTaskSnapshot["runState"] = runningTaskIds.has(task.id)
    ? "running"
    : !task.enabled
      ? "disabled"
      : task.lastFinishedAt === null
        ? "pending_manual_run"
        : "scheduled";

  return {
    ...task,
    runState,
    nextRunAt: nextRunAt(task),
  };
}

function taskDue(task: ScheduledAgentTask, nowMs: number): boolean {
  if (!task.enabled || task.lastFinishedAt === null) {
    return false;
  }
  const lastFinishedMs = Date.parse(task.lastFinishedAt);
  if (Number.isNaN(lastFinishedMs)) {
    return false;
  }
  return nowMs - lastFinishedMs >= CADENCE_MS[task.cadence];
}

function taskNotFound(id: ScheduledTaskId) {
  return new ScheduledTaskError({
    operation: "run",
    taskId: id,
    message: `Scheduled task '${id}' was not found.`,
  });
}

function scheduledTaskError(input: {
  readonly operation: ScheduledTaskOperation;
  readonly taskId?: ScheduledTaskId;
  readonly message: string;
  readonly cause?: unknown;
}) {
  return new ScheduledTaskError({
    operation: input.operation,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    message: input.message,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function errorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
}

export const make = Effect.fn("ScheduledTasks.make")(function* (
  options?: ScheduledTasksLiveOptions,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const bootstrapDispatcher = yield* ThreadTurnBootstrapDispatcher.ThreadTurnBootstrapDispatcher;

  const tasksRef = yield* Ref.make<ReadonlyArray<ScheduledAgentTask> | null>(null);
  const runningTaskIdsRef = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
  const startedRef = yield* Ref.make(false);
  const writeSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<ScheduledTaskSnapshot>>(),
    PubSub.shutdown,
  );
  const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

  const randomUuid = (
    operation: ScheduledTaskOperation,
    message: string,
    taskId?: ScheduledTaskId,
  ) =>
    crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        scheduledTaskError({
          operation,
          ...(taskId ? { taskId } : {}),
          message,
          cause,
        }),
      ),
    );

  const snapshotsFor = (
    tasks: ReadonlyArray<ScheduledAgentTask>,
  ): Effect.Effect<ReadonlyArray<ScheduledTaskSnapshot>> =>
    Ref.get(runningTaskIdsRef).pipe(
      Effect.map((runningTaskIds) =>
        tasks.map((task) => toSnapshot(task, runningTaskIds)).toSorted(taskOrder),
      ),
    );

  const emitChange = (tasks: ReadonlyArray<ScheduledAgentTask>) =>
    snapshotsFor(tasks).pipe(
      Effect.flatMap((snapshots) => PubSub.publish(changesPubSub, snapshots)),
      Effect.asVoid,
    );

  const readPersistedTasks: Effect.Effect<
    ReadonlyArray<ScheduledAgentTask>,
    ScheduledTaskError
  > = Effect.gen(function* () {
    const exists = yield* fs.exists(config.scheduledTasksStatePath).pipe(
      Effect.mapError(
        (cause) =>
          new ScheduledTaskError({
            operation: "read",
            message: `Failed to check scheduled task state at ${config.scheduledTasksStatePath}.`,
            cause,
          }),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (!exists) {
      return [] as ReadonlyArray<ScheduledAgentTask>;
    }

    const raw = yield* fs.readFileString(config.scheduledTasksStatePath).pipe(
      Effect.mapError(
        (cause) =>
          new ScheduledTaskError({
            operation: "read",
            message: `Failed to read scheduled task state at ${config.scheduledTasksStatePath}.`,
            cause,
          }),
      ),
    );
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return [] as ReadonlyArray<ScheduledAgentTask>;
    }

    return yield* decodePersistedScheduledTasksState(trimmed).pipe(
      Effect.map((state) => state.tasks),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to parse scheduled task state, ignoring", {
          path: config.scheduledTasksStatePath,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<ScheduledAgentTask>)),
      ),
    );
  });

  const loadTasks: Effect.Effect<
    ReadonlyArray<ScheduledAgentTask>,
    ScheduledTaskError
  > = Effect.gen(function* () {
    const cached = yield* Ref.get(tasksRef);
    if (cached !== null) {
      return cached;
    }
    const tasks = (yield* readPersistedTasks).toSorted(taskOrder);
    yield* Ref.set(tasksRef, tasks);
    return tasks;
  });

  const persistTasks = (
    tasks: ReadonlyArray<ScheduledAgentTask>,
  ): Effect.Effect<ReadonlyArray<ScheduledAgentTask>, ScheduledTaskError> =>
    Effect.gen(function* () {
      const state: PersistedScheduledTasksState = {
        version: 1,
        tasks: tasks.toSorted(taskOrder),
      };
      yield* writeFileStringAtomically({
        filePath: config.scheduledTasksStatePath,
        contents: `${encodePersistedScheduledTasksState(state)}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new ScheduledTaskError({
              operation: "write",
              message: `Failed to write scheduled task state at ${config.scheduledTasksStatePath}.`,
              cause,
            }),
        ),
      );
      yield* Ref.set(tasksRef, state.tasks);
      yield* emitChange(state.tasks);
      return state.tasks;
    });

  const writeTasks = <A>(
    operation: ScheduledTaskOperation,
    effect: (
      tasks: ReadonlyArray<ScheduledAgentTask>,
    ) => Effect.Effect<
      { readonly tasks: ReadonlyArray<ScheduledAgentTask>; readonly value: A },
      ScheduledTaskError
    >,
  ): Effect.Effect<
    { readonly tasks: ReadonlyArray<ScheduledAgentTask>; readonly value: A },
    ScheduledTaskError
  > =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* loadTasks;
        const result = yield* effect(current);
        const tasks = yield* persistTasks(result.tasks).pipe(
          Effect.mapError((error) =>
            error.operation === "write"
              ? error
              : new ScheduledTaskError({
                  operation,
                  message: error.message,
                  cause: error,
                }),
          ),
        );
        return { tasks, value: result.value };
      }),
    );

  const mutationResult = (
    taskId: ScheduledTaskId,
    tasks: ReadonlyArray<ScheduledAgentTask>,
  ): Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError> =>
    Effect.gen(function* () {
      const snapshots = yield* snapshotsFor(tasks);
      const task = snapshots.find((candidate) => candidate.id === taskId);
      if (!task) {
        return yield* taskNotFound(taskId);
      }
      return { task, tasks: snapshots } satisfies ScheduledTaskMutationResult;
    });

  const list = loadTasks.pipe(
    Effect.flatMap((tasks) => snapshotsFor(tasks)),
    Effect.map((tasks) => ({ tasks }) satisfies ScheduledTaskListResult),
  );

  const create: ScheduledTasks["Service"]["create"] = Effect.fn("ScheduledTasks.create")(
    function* (input) {
      const id = ScheduledTaskId.make(
        yield* randomUuid("create", "Failed to generate scheduled task id."),
      );
      const timestamp = yield* nowIso;
      return yield* writeTasks("create", (tasks) =>
        Effect.succeed({
          tasks: [
            ...tasks,
            {
              ...input,
              id,
              createdAt: timestamp,
              updatedAt: timestamp,
              lastStartedAt: null,
              lastFinishedAt: null,
              lastStatus: null,
              lastError: null,
              lastThreadId: null,
            } satisfies ScheduledAgentTask,
          ],
          value: id,
        }),
      ).pipe(Effect.flatMap(({ tasks, value }) => mutationResult(value, tasks)));
    },
  );

  const update: ScheduledTasks["Service"]["update"] = Effect.fn("ScheduledTasks.update")(
    function* (input) {
      const timestamp = yield* nowIso;
      return yield* writeTasks("update", (tasks) => {
        const existing = tasks.find((task) => task.id === input.id);
        if (!existing) {
          return Effect.fail(taskNotFound(input.id));
        }
        return Effect.succeed({
          tasks: tasks.map((task) =>
            task.id === input.id
              ? {
                  ...task,
                  ...input.patch,
                  updatedAt: timestamp,
                }
              : task,
          ),
          value: input.id,
        });
      }).pipe(Effect.flatMap(({ tasks, value }) => mutationResult(value, tasks)));
    },
  );

  const deleteTask: ScheduledTasks["Service"]["delete"] = Effect.fn("ScheduledTasks.delete")(
    function* (input) {
      return yield* writeTasks("delete", (tasks) => {
        if (!tasks.some((task) => task.id === input.id)) {
          return Effect.fail(taskNotFound(input.id));
        }
        return Effect.succeed({
          tasks: tasks.filter((task) => task.id !== input.id),
          value: undefined,
        });
      }).pipe(
        Effect.flatMap(({ tasks }) =>
          snapshotsFor(tasks).pipe(
            Effect.map((snapshots) => ({ tasks: snapshots }) satisfies ScheduledTaskDeleteResult),
          ),
        ),
      );
    },
  );

  const buildRunCommand = Effect.fn("ScheduledTasks.buildRunCommand")(function* (
    task: ScheduledAgentTask,
  ) {
    const uuid = yield* randomUuid("run", "Failed to generate scheduled task thread id.", task.id);
    const threadId = ThreadId.make(uuid);
    const messageId = MessageId.make(
      yield* randomUuid("run", "Failed to generate scheduled task message id.", task.id),
    );
    const commandUuid = yield* randomUuid(
      "run",
      "Failed to generate scheduled task command id.",
      task.id,
    );
    const commandId = CommandId.make(`scheduled-task:${task.id}:${commandUuid}`);
    const createdAt = yield* nowIso;
    const origin = {
      type: "scheduled-task" as const,
      scheduledTaskId: task.id,
      scheduledTaskTitle: task.title,
    };

    const bootstrap = yield* Effect.gen(function* () {
      if (task.target.type === "standalone") {
        return {
          ensureStandaloneProject: true,
          createThread: {
            projectId: STANDALONE_CHAT_PROJECT_ID,
            title: task.title,
            modelSelection: task.modelSelection,
            runtimeMode: task.runtimeMode,
            interactionMode: task.interactionMode,
            branch: null,
            worktreePath: null,
            origin,
            createdAt,
          },
        } satisfies NonNullable<
          Extract<OrchestrationCommand, { type: "thread.turn.start" }>["bootstrap"]
        >;
      }

      const project = yield* projectionSnapshotQuery
        .getProjectShellById(task.target.projectId)
        .pipe(
          Effect.map(Option.getOrNull),
          Effect.mapError(
            (cause) =>
              new ScheduledTaskError({
                operation: "run",
                taskId: task.id,
                message: `Failed to resolve project for scheduled task '${task.title}'.`,
                cause,
              }),
          ),
        );
      if (project === null) {
        return yield* new ScheduledTaskError({
          operation: "run",
          taskId: task.id,
          message: `Project for scheduled task '${task.title}' was not found.`,
        });
      }
      if (project.kind !== "workspace") {
        return yield* new ScheduledTaskError({
          operation: "run",
          taskId: task.id,
          message: `Project scheduled task '${task.title}' must target a workspace project.`,
        });
      }

      if (task.target.workspace.mode === "worktree") {
        const branchUuid = yield* randomUuid(
          "run",
          "Failed to generate scheduled task worktree branch id.",
          task.id,
        );
        return {
          createThread: {
            projectId: task.target.projectId,
            title: task.title,
            modelSelection: task.modelSelection,
            runtimeMode: task.runtimeMode,
            interactionMode: task.interactionMode,
            branch: task.target.workspace.baseBranch,
            worktreePath: null,
            origin,
            createdAt,
          },
          prepareWorktree: {
            projectCwd: project.workspaceRoot,
            baseBranch: task.target.workspace.baseBranch,
            branch: buildTemporaryWorktreeBranchName((byteLength) =>
              branchUuid.replaceAll("-", "").slice(0, byteLength * 2),
            ),
            ...(task.target.workspace.startFromOrigin ? { startFromOrigin: true } : {}),
          },
          runSetupScript: true,
        } satisfies NonNullable<
          Extract<OrchestrationCommand, { type: "thread.turn.start" }>["bootstrap"]
        >;
      }

      return {
        createThread: {
          projectId: task.target.projectId,
          title: task.title,
          modelSelection: task.modelSelection,
          runtimeMode: task.runtimeMode,
          interactionMode: task.interactionMode,
          branch: null,
          worktreePath: task.target.workspace.worktreePath,
          origin,
          createdAt,
        },
      } satisfies NonNullable<
        Extract<OrchestrationCommand, { type: "thread.turn.start" }>["bootstrap"]
      >;
    });

    return {
      threadId,
      command: {
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: task.prompt,
          attachments: [],
        },
        modelSelection: task.modelSelection,
        titleSeed: task.title,
        runtimeMode: task.runtimeMode,
        interactionMode: task.interactionMode,
        bootstrap,
        createdAt,
      } satisfies OrchestrationCommand,
    };
  });

  const runTask = Effect.fn("ScheduledTasks.runTask")(function* (
    taskId: ScheduledTaskId,
    reason: "manual" | "scheduled",
  ) {
    const startedAt = yield* nowIso;
    const claim = yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const runningIds = yield* Ref.get(runningTaskIdsRef);
        if (runningIds.has(taskId)) {
          return Option.none<ScheduledAgentTask>();
        }

        const tasks = yield* loadTasks;
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (!task) {
          return yield* taskNotFound(taskId);
        }

        yield* Ref.update(runningTaskIdsRef, (current) => new Set(current).add(taskId));
        yield* persistTasks(
          tasks.map((candidate) =>
            candidate.id === taskId
              ? {
                  ...candidate,
                  lastStartedAt: startedAt,
                  lastError: null,
                }
              : candidate,
          ),
        );
        return Option.some(task);
      }),
    );
    if (Option.isNone(claim)) {
      const tasks = yield* loadTasks;
      return yield* mutationResult(taskId, tasks);
    }

    const task = claim.value;
    yield* Effect.logInfo("scheduled task run started", {
      taskId,
      title: task.title,
      reason,
    });

    const exit = yield* buildRunCommand(task).pipe(
      Effect.flatMap(({ command, threadId }) =>
        bootstrapDispatcher.dispatch(command).pipe(Effect.as({ threadId })),
      ),
      Effect.exit,
    );
    const finishedAt = yield* nowIso;
    const finishedTaskId = taskId;
    const next = yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const tasks = yield* loadTasks;
        const status = exit._tag === "Success" ? "succeeded" : "failed";
        const lastError = exit._tag === "Success" ? null : errorMessage(exit.cause);
        const lastThreadId = exit._tag === "Success" ? exit.value.threadId : null;
        const nextTasks = yield* persistTasks(
          tasks.map((candidate) =>
            candidate.id === finishedTaskId
              ? {
                  ...candidate,
                  lastFinishedAt: finishedAt,
                  lastStatus: status,
                  lastError,
                  lastThreadId,
                }
              : candidate,
          ),
        );
        yield* Ref.update(runningTaskIdsRef, (current) => {
          const next = new Set(current);
          next.delete(finishedTaskId);
          return next;
        });
        yield* emitChange(nextTasks);
        return nextTasks;
      }),
    );

    if (exit._tag === "Failure") {
      yield* Effect.logWarning("scheduled task run failed", {
        taskId,
        title: task.title,
        reason,
        cause: Cause.pretty(exit.cause),
      });
    } else {
      yield* Effect.logInfo("scheduled task run completed", {
        taskId,
        title: task.title,
        reason,
        threadId: exit.value.threadId,
      });
    }

    return yield* mutationResult(taskId, next);
  });

  const runNow: ScheduledTasks["Service"]["runNow"] = (input) => runTask(input.id, "manual");

  const runDueTasks = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const runningTaskIds = yield* Ref.get(runningTaskIdsRef);
    const tasks = yield* loadTasks.pipe(Effect.orElseSucceed(() => []));
    const dueTasks = tasks
      .filter((task) => !runningTaskIds.has(task.id) && taskDue(task, nowMs))
      .toSorted(taskOrder);

    for (const task of dueTasks) {
      yield* runTask(task.id, "scheduled").pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scheduled task sweep failed to run task", {
            taskId: task.id,
            title: task.title,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("scheduled task sweep failed", { cause })),
  );

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return;
    }

    yield* Effect.forkScoped(
      runDueTasks.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
    );
    yield* Effect.logInfo("scheduled task runner started", { sweepIntervalMs });
  }).pipe(Effect.ignoreCause({ log: true }));

  return ScheduledTasks.of({
    list,
    create,
    update,
    delete: deleteTask,
    runNow,
    runDueTasks,
    start,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  });
});

export const layer = (options?: ScheduledTasksLiveOptions) =>
  Layer.effect(ScheduledTasks, make(options));

export const layerLive = layer();
