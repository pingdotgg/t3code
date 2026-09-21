import {
  CommandId,
  MessageId,
  ProjectId,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskUpdateInput,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);
const encodeScheduleJson = Schema.encodeEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const encodeWorkspaceStrategyJson = Schema.encodeEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const encodeModelSelectionJson = Schema.encodeEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);
const isScheduledTaskError = Schema.is(ScheduledTaskError);

interface ScheduledTaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly workspace_strategy_json: string;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly last_run_error: string | null;
  readonly run_count: number;
}

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    /** Emits the full task list on subscribe and again after every change (CRUD, run transitions, reschedules). */
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    /**
     * Atomic partial update: writes only the provided fields, and only while
     * the task still exists in `input.projectId`. Returns `Option.none()` when
     * no such task exists — the update can never insert a row, so an edit
     * racing a delete loses instead of resurrecting the task.
     *
     * Two merge cases are typed conflicts instead of silent writes: a patch
     * carrying schedule/enabled fails when a committed edit already changed
     * the columns the patch was reasoned from, and a `threadId`/`nextProjectId`
     * patch fails when the merged pair would bind the task to a thread outside
     * its project (the dispatch check in `getProjectThread` would reject it).
     * Unbind explicitly with `threadId: null` to move a bound task.
     */
    readonly update: (
      input: ScheduledTaskUpdateInput,
    ) => Effect.Effect<Option.Option<ScheduledTaskMutationResult>, ScheduledTaskError>;
    /** Partial update flipping only the enabled flag; never touches other fields. */
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<Option.Option<ScheduledTaskDeleteResult>, ScheduledTaskError>;
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<ScheduledTaskRunNowResult, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskService") {}

function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

function nextRunAt(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  from: DateTime.DateTime,
): string | null {
  if (!task.enabled) return null;
  // A stored interval can decode yet overflow the representable DateTime
  // range; an unrepresentable occurrence means the task has no next run.
  try {
    const next = nextScheduledRunAt(task.schedule, from);
    return next !== null && Number.isFinite(DateTime.toEpochMillis(next)) ? iso(next) : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return Cause.pretty(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

// Contention surfaces differently per runtime: Bun's SQLite driver reports
// `code`/`errno`, which the vendored classifier maps to a retryable
// LockTimeoutError, while node:sqlite reports `errcode` (e.g.
// SQLITE_BUSY_SNAPSHOT 517), which the classifier cannot see. Accept either:
// a reason the classifier already marked retryable, or a native numeric code
// in the SQLITE_BUSY (5) / SQLITE_LOCKED (6) families on any of the field
// names a driver might use. The ScheduledTaskError unwrap covers statements
// that wrap SqlError inside the transaction before the retry policy sees it.
const isContendedWriteError = (cause: unknown): boolean => {
  if (isScheduledTaskError(cause)) return isContendedWriteError(cause.cause);
  if (!SqlError.isSqlError(cause)) return false;
  if (cause.reason.isRetryable) return true;
  const native = cause.reason.cause;
  for (const key of ["errcode", "errno", "code"] as const) {
    if (Predicate.hasProperty(native, key) && typeof native[key] === "number") {
      const base = native[key] & 0xff;
      if (base === 5 || base === 6) return true;
    }
  }
  return false;
};

// A commit on another connection between a transaction's read and its write
// leaves that transaction on a stale snapshot (SQLITE_BUSY_SNAPSHOT) — retry
// on a fresh snapshot so disjoint edits still merge instead of failing.
const retryContended = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ times: 2, while: isContendedWriteError }));

const decodeRow = (row: ScheduledTaskRow) =>
  Effect.gen(function* () {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    return yield* decodeTask({
      // The stored id decodes through the task schema so a corrupt value fails
      // as a typed parse error, not a `ScheduledTaskId.make` defect.
      id: row.task_id,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      schedule,
      projectId: row.project_id,
      threadId: row.thread_id,
      workspaceStrategy,
      modelSelection,
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      lastRunError: row.last_run_error,
      runCount: row.run_count,
    });
  }).pipe(
    Effect.mapError((cause) => {
      // The typed diagnostic can only carry an id that itself decodes; a
      // corrupt stored id is omitted rather than re-thrown as a defect.
      const taskId = decodeTaskId(row.task_id);
      return taskError("Could not decode schedule task row.", {
        ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
        cause,
      });
    }),
  );

/** Select poll candidates before decoding their schedules or other JSON payloads. */
export const listDueTasks = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScheduledTaskRow>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL
      AND next_run_at <= ${iso(now)} AND last_run_status <> 'running'
    ORDER BY next_run_at ASC, task_id ASC
  `;
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is a freeform string at the schema level; a stored value
      // that cannot parse as a DateTime would defect the poll below, so the
      // row is skipped here like any other corrupt row.
      if (task.nextRunAt === null || Option.isSome(DateTime.make(task.nextRunAt))) {
        tasks.push(task);
      } else {
        yield* Effect.logWarning("Skipping schedule task row with invalid next_run_at", {
          taskId: row.task_id,
        });
      }
    } else {
      yield* Effect.logWarning("Skipping undecodable schedule task row", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    }
  }
  return tasks;
});

export const layer = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    // Sliding(1) coalesces the dirty-signal: every notification triggers a
    // full list() re-emit anyway, so a slow subscriber only ever needs the
    // latest signal — an unbounded backlog would just grow memory.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const selectAllRows = () => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count
      FROM scheduled_tasks
      ORDER BY updated_at DESC, task_id ASC
    `;

    // Strict decode for the API surface: a corrupt row is a visible error.
    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* () {
      const rows = yield* selectAllRows();
      return yield* Effect.forEach(rows, decodeRow, { concurrency: 1 });
    });

    const getRows = (id: ScheduledTaskId) => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count
      FROM scheduled_tasks
      WHERE task_id = ${id}
    `;

    const getScopedRows = (id: ScheduledTaskId, projectId: ScheduledTask["projectId"]) =>
      sql<ScheduledTaskRow>`
        SELECT
          task_id,
          title,
          prompt,
          enabled,
          schedule_json,
          project_id,
          thread_id,
          workspace_strategy_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_by,
          creation_source,
          created_at,
          updated_at,
          next_run_at,
          last_run_at,
          last_run_status,
          last_run_error,
          run_count
        FROM scheduled_tasks
        WHERE task_id = ${id} AND project_id = ${projectId}
      `;

    /** Load a task, returning `null` when it does not exist; real load/decode failures propagate. */
    const findTask = Effect.fn("ScheduledTaskService.findTask")(function* (id: ScheduledTaskId) {
      const rows = yield* getRows(id).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeRow(row);
    });

    const loadTask = Effect.fn("ScheduledTaskService.loadTask")(function* (id: ScheduledTaskId) {
      const task = yield* findTask(id);
      if (task === null) {
        return yield* taskError("Schedule task not found.", { taskId: id });
      }
      return task;
    });

    // A task only ever dispatches through getProjectThread, which reads the
    // v2 projection and requires the bound thread to live in the task's
    // project and not be deleted — so any stored (project, thread) pair that
    // check would reject is a task that can never fire. This is the
    // side-effect-free mirror of that rule: a plain read of the same v2
    // projection table, safe to run inside the update transaction because it
    // never takes the importer's thread lock or hydrates a transcript a
    // rollback would orphan. (No v1 fallback: startup shell reconciliation
    // has already imported every v1 thread before writes are served, and
    // ensureTranscript never creates shells, so a thread without a v2 row is
    // one dispatch can never reach.)
    const requireThreadInProject = Effect.fn("ScheduledTaskService.requireThreadInProject")(
      function* (taskId: ScheduledTaskId, projectId: ProjectId, threadId: ThreadId) {
        const counts = yield* sql<{ matched: number }>`
          SELECT COUNT(*) AS matched
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
            AND project_id = ${projectId}
            AND deleted_at IS NULL
            AND archived_at IS NULL
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not validate the schedule task's thread binding.", {
              taskId,
              cause,
            }),
          ),
        );
        if ((counts[0]?.matched ?? 0) === 0) {
          return yield* taskError(
            "The task's thread binding is not a live thread in the task's project; unbind it or rebind to a thread in the project.",
            { taskId },
          );
        }
      },
    );

    // Run-state columns (last_run_*, run_count) are intentionally absent from
    // the conflict clause: they are owned by the run transitions below, and a
    // concurrent settings save must not overwrite an in-flight increment.
    // Check existence in the write itself so an edit cannot undo a deletion
    // that landed after upsert loaded the previous task.
    const saveTask = (task: ScheduledTask, requireExisting: boolean) =>
      sql<{ task_id: string }>`
        INSERT INTO scheduled_tasks (
          task_id,
          title,
          prompt,
          enabled,
          schedule_json,
          project_id,
          thread_id,
          workspace_strategy_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_by,
          creation_source,
          created_at,
          updated_at,
          next_run_at,
          last_run_at,
          last_run_status,
          last_run_error,
          run_count
        )
        SELECT
          ${task.id},
          ${task.title},
          ${task.prompt},
          ${task.enabled ? 1 : 0},
          ${JSON.stringify(task.schedule)},
          ${task.projectId},
          ${task.threadId},
          ${JSON.stringify(task.workspaceStrategy)},
          ${JSON.stringify(task.modelSelection)},
          ${task.runtimeMode},
          ${task.interactionMode},
          ${task.createdBy},
          ${task.creationSource},
          ${task.createdAt},
          ${task.updatedAt},
          ${task.nextRunAt},
          ${task.lastRunAt},
          ${task.lastRunStatus},
          ${task.lastRunError},
          ${task.runCount}
        WHERE ${requireExisting ? 0 : 1} = 1
           OR EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${task.id})
        ON CONFLICT (task_id)
        DO UPDATE SET
          title = excluded.title,
          prompt = excluded.prompt,
          enabled = excluded.enabled,
          schedule_json = excluded.schedule_json,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          workspace_strategy_json = excluded.workspace_strategy_json,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          creation_source = excluded.creation_source,
          updated_at = excluded.updated_at,
          next_run_at = excluded.next_run_at
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not save schedule task.", { taskId: task.id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : taskError("Schedule task not found.", { taskId: task.id }),
        ),
      );

    // Scoped like update: when the caller supplies a project, the DELETE's
    // WHERE carries it, so a task moved to another project mid-request is a
    // missing row, never a cross-project delete. RETURNING surfaces that.
    const deleteRow = (id: ScheduledTaskId, projectId?: ProjectId) =>
      (projectId === undefined
        ? sql`DELETE FROM scheduled_tasks WHERE task_id = ${id} RETURNING task_id`
        : sql`DELETE FROM scheduled_tasks WHERE task_id = ${id} AND project_id = ${projectId} RETURNING task_id`
      ).pipe(
        Effect.mapError((cause) =>
          taskError("Could not delete schedule task.", { taskId: id, cause }),
        ),
      );

    // Run-state transitions use targeted UPDATEs (never the full-row upsert) so
    // a completing run cannot resurrect a deleted task or clobber concurrent
    // edits to the task definition.
    const markRunning = (id: ScheduledTaskId, startedAtIso: string) =>
      sql`
        UPDATE scheduled_tasks
        SET updated_at = ${startedAtIso},
            last_run_at = ${startedAtIso},
            last_run_status = 'running',
            last_run_error = NULL
        WHERE task_id = ${id}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not mark schedule task as running.", { taskId: id, cause }),
        ),
      );

    const markCompleted = (input: {
      readonly id: ScheduledTaskId;
      readonly completedAtIso: string;
      readonly nextRunAtIso: string | null;
      readonly status: "succeeded" | "failed";
      readonly error: string | null;
      readonly startedAtIso: string;
    }) =>
      sql`
        UPDATE scheduled_tasks
        SET updated_at = ${input.completedAtIso},
            next_run_at = ${input.nextRunAtIso},
            last_run_status = ${input.status},
            last_run_error = ${input.error},
            run_count = run_count + 1
        WHERE task_id = ${input.id}
          AND last_run_status = 'running'
          AND last_run_at = ${input.startedAtIso}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );

    // Best-effort escape hatch: if anything fails between markRunning and
    // markCompleted, write a full terminal record so runDueTasks neither skips
    // the task forever (it filters out 'running' rows) nor re-fires it
    // immediately: the dispatch may already have gone out, so next_run_at must
    // advance and run_count must count the attempt.
    const releaseStuckRun = (task: ScheduledTask, message: string) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        // Compute the next occurrence from the current row so a schedule
        // edited while the run was in flight is honoured; fall back to the
        // run's snapshot only if the re-read itself fails.
        // Re-read and write under one lock so an edit committed between them
        // keeps its own next_run_at rather than being overwritten by the
        // schedule snapshot taken before the edit. Contention retry keeps a
        // cross-connection commit from stranding the task as 'running'.
        yield* retryContended(
          sql
            .withTransaction(
              Effect.gen(function* () {
                const reread = yield* Effect.result(findTask(task.id));
                if (Result.isSuccess(reread) && reread.success === null) return; // deleted — nothing to release
                const source =
                  Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
                yield* sql`
              UPDATE scheduled_tasks
              SET last_run_status = 'failed',
                  last_run_error = ${message},
                  next_run_at = ${nextRunAt(source, now)},
                  updated_at = ${iso(now)},
                  run_count = run_count + 1
              WHERE task_id = ${task.id} AND last_run_status = 'running'
            `;
              }),
            )
            .pipe(
              Effect.catchTags({
                SqlError: (cause) =>
                  Effect.fail(
                    taskError("Could not release stuck schedule task run.", {
                      taskId: task.id,
                      cause,
                    }),
                  ),
              }),
            ),
        );
        yield* notifyChanged;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not release stuck schedule task run", {
            taskId: task.id,
            cause,
          }),
        ),
      );

    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      trigger: "scheduled" | "manual",
      projectId?: ProjectId,
    ) {
      const reserved = yield* Ref.modify(activeRuns, (active) => {
        if (active.has(task.id)) return [false, active] as const;
        const next = new Set(active);
        next.add(task.id);
        return [true, next] as const;
      });
      if (!reserved) {
        if (trigger === "manual") {
          return yield* taskError("Schedule task is already running.", { taskId: task.id });
        }
        return task;
      }

      return yield* Effect.gen(function* () {
        const startedAt = yield* localNow;
        const startedAtIso = iso(startedAt);

        // The in-memory snapshot may be stale: re-read and mark running under
        // one transaction, so a pause, postpone, or delete committed between
        // the poll's read and this dispatch still wins instead of firing a
        // run the edit just invalidated.
        const marked = yield* retryContended(
          sql
            .withTransaction(
              Effect.gen(function* () {
                const active = yield* findTask(task.id);
                // A scoped manual run re-reads inside the transaction that
                // marks the task running, so a task moved to another project
                // since authorization is a missing row — never a dispatch
                // under the old project's authority.
                if (active === null || (projectId !== undefined && active.projectId !== projectId))
                  return null;
                // A next_run_at corrupted between the poll read and this
                // re-read must not defect the poll; an unparseable value is
                // treated as not due.
                const parsedNextRunAt =
                  active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
                if (
                  trigger === "scheduled" &&
                  (!active.enabled ||
                    Option.isNone(parsedNextRunAt) ||
                    DateTime.toEpochMillis(parsedNextRunAt.value) >
                      DateTime.toEpochMillis(startedAt))
                ) {
                  return { task: active, running: false } as const;
                }
                yield* markRunning(active.id, startedAtIso);
                return { task: active, running: true } as const;
              }),
            )
            .pipe(
              Effect.catchTags({
                ScheduledTaskError: (error) => Effect.fail(error),
                SqlError: (cause) =>
                  Effect.fail(
                    taskError("Could not mark schedule task as running.", {
                      taskId: task.id,
                      cause,
                    }),
                  ),
              }),
            ),
        );
        if (marked === null) {
          // A manual run on a just-deleted task must fail loudly, not report
          // a successful run that never dispatched.
          if (trigger === "manual") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return task;
        }
        if (!marked.running) return marked.task;
        const active = marked.task;
        yield* notifyChanged;

        const fireKey = `${active.id}:${DateTime.toEpochMillis(startedAt)}:${trigger}`;
        const commandId = CommandId.make(`scheduled-task:${fireKey}`);
        const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
        // Dispatch from the fresh row so prompt/model/binding edits made
        // after the poll read are honoured.
        const prompt = active.prompt;

        // Effect.exit (not Effect.result) so defects and interruptions in the
        // dispatch are also captured and recorded as a failed run instead of
        // aborting before markCompleted.
        const result =
          active.threadId === null
            ? yield* Effect.exit(
                threadLaunch.launch({
                  commandId,
                  projectId: active.projectId,
                  title: active.title,
                  modelSelection: active.modelSelection,
                  runtimeMode: active.runtimeMode,
                  interactionMode: active.interactionMode,
                  workspaceStrategy: active.workspaceStrategy,
                  initialMessage: {
                    messageId,
                    scheduledTaskId: active.id,
                    text: prompt,
                    attachments: [],
                  },
                  createdBy: active.createdBy,
                  creationSource: active.creationSource,
                }),
              )
            : yield* Effect.exit(
                threadManagement.sendToThread({
                  projectId: active.projectId,
                  commandId,
                  threadId: ThreadId.make(active.threadId),
                  messageId,
                  scheduledTaskId: active.id,
                  text: prompt,
                  attachments: [],
                  modelSelection: active.modelSelection,
                  mode: "auto",
                  createdBy: active.createdBy,
                  creationSource: active.creationSource,
                }),
              );

        const completedAt = yield* localNow;
        const runSucceeded = result._tag === "Success";
        const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
        const lastRunError = runSucceeded ? null : errorMessage(result.cause);
        // Re-read the task so the next run is computed from the schedule as it
        // is *now* (the user may have edited or deleted it while we ran). The
        // re-read and the write share one transaction so a concurrent edit
        // cannot land between them and have its next_run_at overwritten by a
        // stale schedule. Contention retry keeps a cross-connection commit
        // from abandoning the completion write with the task left 'running'.
        const current = yield* retryContended(
          sql
            .withTransaction(
              Effect.gen(function* () {
                const current = yield* findTask(task.id);
                if (current !== null) {
                  // startedAtIso in the guard ensures this writes only to the row
                  // this run marked as running — a task deleted mid-run and
                  // recreated with the same id (idempotent commandId replay) must
                  // not be stamped.
                  yield* markCompleted({
                    id: task.id,
                    completedAtIso: iso(completedAt),
                    nextRunAtIso: nextRunAt(current, completedAt),
                    status: lastRunStatus,
                    error: lastRunError,
                    startedAtIso,
                  });
                }
                return current;
              }),
            )
            .pipe(
              Effect.catchTags({
                ScheduledTaskError: (error) => Effect.fail(error),
                SqlError: (cause) =>
                  Effect.fail(
                    taskError("Could not record schedule task run.", {
                      taskId: task.id,
                      cause,
                    }),
                  ),
              }),
            ),
        );
        if (current !== null) {
          yield* notifyChanged;
        }
        const scheduleSource = current ?? task;
        const completed: ScheduledTask = {
          ...scheduleSource,
          updatedAt: iso(completedAt),
          lastRunAt: startedAtIso,
          nextRunAt: nextRunAt(scheduleSource, completedAt),
          lastRunStatus,
          lastRunError,
          runCount: scheduleSource.runCount + 1,
        };
        return completed;
      }).pipe(
        Effect.onError((cause) => releaseStuckRun(task, errorMessage(cause))),
        Effect.ensuring(
          Ref.update(activeRuns, (active) => {
            const next = new Set(active);
            next.delete(task.id);
            return next;
          }),
        ),
      );
    });

    // A due fixed-time run that is long past its slot (server was off or
    // asleep) is skipped and re-aimed at its next occurrence, not fired late.
    const rescheduleMissedRun = Effect.fn("ScheduledTaskService.rescheduleMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
    ) {
      const next = nextRunAt(task, now);
      yield* Effect.logInfo("Skipping missed schedule task run", {
        taskId: task.id,
        missedRunAt: task.nextRunAt,
        rescheduledTo: next,
      });
      // Guard on the due time we read: an edit that rescheduled the task
      // since the poll changes next_run_at, so this compare-and-swap loses
      // instead of overwriting the edit with a stale computation.
      yield* sql`
        UPDATE scheduled_tasks
        SET next_run_at = ${next},
            updated_at = ${iso(now)}
        WHERE task_id = ${task.id} AND next_run_at = ${task.nextRunAt}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule missed schedule task run.", { taskId: task.id, cause }),
        ),
      );
      yield* notifyChanged;
    });

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
      const now = yield* localNow;
      const tasks = yield* listDueTasks(now).pipe(
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      const due = tasks.flatMap((task) =>
        task.nextRunAt === null ? [] : [{ task, dueAt: DateTime.makeUnsafe(task.nextRunAt) }],
      );
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          (isMissedFixedTimeRun(task.schedule, dueAt, now)
            ? rescheduleMissedRun(task, now)
            : runTask(task, "scheduled")
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    // Recover from a crash or hard shutdown mid-run: rows stuck in 'running'
    // would otherwise be skipped by the due-task filter forever. The dispatch
    // may already have gone out before the crash, so next_run_at must advance
    // and run_count must count the attempt — otherwise the first poll after
    // every restart re-fires the interrupted task (same rationale as
    // releaseStuckRun). Schedules are JSON, so this is per-row Effect work
    // rather than a single UPDATE.
    yield* Effect.gen(function* () {
      const rows = yield* selectAllRows();
      const stuck = rows.filter((row) => row.last_run_status === "running");
      if (stuck.length === 0) return;
      const now = yield* localNow;
      yield* Effect.forEach(
        stuck,
        (row) =>
          Effect.gen(function* () {
            const decoded = yield* Effect.result(decodeRow(row));
            if (Result.isSuccess(decoded)) {
              yield* retryContended(sql`
                UPDATE scheduled_tasks
                SET last_run_status = 'failed',
                    last_run_error = 'Run was interrupted by a server restart.',
                    next_run_at = ${nextRunAt(decoded.success, now)},
                    updated_at = ${iso(now)},
                    run_count = run_count + 1
                WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
              `);
              return;
            }
            // The schedule cannot be decoded, so the next occurrence cannot
            // be computed — still release the row so it is not stuck in
            // 'running' (the lenient poller skips it, so it cannot re-fire).
            yield* Effect.logWarning(
              "Recovering undecodable schedule task row without rescheduling",
              { taskId: row.task_id, cause: decoded.failure },
            );
            yield* retryContended(sql`
              UPDATE scheduled_tasks
              SET last_run_status = 'failed',
                  last_run_error = 'Run was interrupted by a server restart.',
                  updated_at = ${iso(now)},
                  run_count = run_count + 1
              WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
            `);
          }),
        { concurrency: 1, discard: true },
      );
      yield* notifyChanged;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reset interrupted schedule task runs", { cause }),
      ),
    );

    yield* scheduler.register("scheduled-tasks", runDueTasks());

    const list: ScheduledTaskService["Service"]["list"] = () =>
      listRows().pipe(
        Effect.map((tasks) => ({ tasks })),
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: ScheduledTaskService["Service"]["upsert"] = (input) =>
      Effect.gen(function* () {
        const task = yield* retryContended(
          sql.withTransaction(
            Effect.gen(function* () {
              const now = yield* localNow;
              const uuid =
                input.commandId === undefined
                  ? yield* crypto.randomUUIDv4.pipe(
                      Effect.mapError((cause) =>
                        taskError("Could not generate schedule task id.", { cause }),
                      ),
                    )
                  : null;
              const id =
                input.id ??
                ScheduledTaskId.make(
                  input.commandId ? `scheduled-task:${input.commandId}` : `scheduled-task:${uuid}`,
                );
              // Look up by the *resolved* id so idempotent creates (commandId replays)
              // keep their run history, and so real load failures propagate instead
              // of silently resetting an existing row.
              const existingTask = yield* findTask(id);
              // A replayed create resolves the same id even after the task
              // left the caller's project — the scoped view must answer
              // not-found rather than let the upsert drag the row back and
              // overwrite a definition the caller can no longer see.
              if (existingTask !== null && existingTask.projectId !== input.projectId) {
                return yield* taskError("Schedule task not found.", { taskId: id });
              }
              // Keep the existing next_run_at when the schedule itself is untouched:
              // editing a title or prompt must not postpone (or resurrect) a due
              // run — only schedule/enabled changes restart the clock.
              const scheduleUnchanged =
                existingTask !== null &&
                existingTask.enabled === input.enabled &&
                isSameSchedule(existingTask.schedule, input.schedule);
              const task: ScheduledTask = {
                id,
                title: input.title,
                prompt: input.prompt,
                enabled: input.enabled,
                schedule: input.schedule,
                projectId: input.projectId,
                threadId: input.threadId ?? null,
                workspaceStrategy: input.workspaceStrategy,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
                creationSource: input.creationSource ?? "web",
                createdAt: existingTask?.createdAt ?? iso(now),
                updatedAt: iso(now),
                nextRunAt: scheduleUnchanged
                  ? existingTask.nextRunAt
                  : nextRunAt({ enabled: input.enabled, schedule: input.schedule }, now),
                lastRunAt: existingTask?.lastRunAt ?? null,
                lastRunStatus: existingTask?.lastRunStatus ?? "never",
                lastRunError: existingTask?.lastRunError ?? null,
                runCount: existingTask?.runCount ?? 0,
              };
              if (task.threadId !== null) {
                yield* requireThreadInProject(task.id, task.projectId, task.threadId);
              }
              yield* saveTask(task, input.requireExisting === true);
              return task;
            }),
          ),
        ).pipe(
          Effect.catchTags({
            ScheduledTaskError: (error) => Effect.fail(error),
            SqlError: (cause) =>
              Effect.fail(taskError("Could not upsert the schedule task.", { cause })),
          }),
        );
        yield* notifyChanged;
        return { task };
      });

    // Partial edits run inside one transaction: the scoped row is read and
    // rewritten without another fiber's statements interleaving (the client's
    // connection serializes transactions), so a delete racing the edit
    // surfaces as `none` (the UPDATE never inserts) and concurrent disjoint
    // edits each keep their own columns.
    const update: ScheduledTaskService["Service"]["update"] = (input) =>
      Effect.gen(function* () {
        const task = yield* retryContended(
          sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* getScopedRows(input.id, input.projectId).pipe(
                Effect.mapError((cause) =>
                  taskError("Could not load schedule task.", { taskId: input.id, cause }),
                ),
              );
              const row = rows[0];
              if (row === undefined) return null;
              const existing = yield* decodeRow(row);
              // Patches merge with whatever concurrent edits already
              // committed, so the resulting pair must still be dispatchable:
              // a move keeps an existing threadId only when that thread
              // belongs to the destination project, and a binding update
              // keeps the current project. Passing `threadId: null` in the
              // same patch is the explicit unbind that lets a bound task move.
              if (input.threadId !== undefined || input.nextProjectId !== undefined) {
                const mergedThreadId =
                  input.threadId === undefined ? existing.threadId : input.threadId;
                if (mergedThreadId !== null) {
                  yield* requireThreadInProject(
                    input.id,
                    input.nextProjectId ?? existing.projectId,
                    mergedThreadId,
                  );
                }
              }
              const patch: Record<string, unknown> = {};
              if (input.title !== undefined) patch.title = input.title;
              if (input.prompt !== undefined) patch.prompt = input.prompt;
              if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
              if (input.schedule !== undefined) {
                patch.schedule_json = yield* encodeScheduleJson(input.schedule);
              }
              if (input.threadId !== undefined) patch.thread_id = input.threadId;
              if (input.workspaceStrategy !== undefined) {
                patch.workspace_strategy_json = yield* encodeWorkspaceStrategyJson(
                  input.workspaceStrategy,
                );
              } else if (input.workspaceStrategyPatch !== undefined) {
                // A sparse patch merges into the strategy read above inside
                // this transaction: two clients editing disjoint controls
                // (baseRef vs startFromOrigin) both land instead of the
                // second whole-object write reverting the first. Keys that
                // do not belong to the live strategy kind encode away, so a
                // patch racing a kind change drops the stale control edit.
                const sparse = input.workspaceStrategyPatch;
                patch.workspace_strategy_json = yield* encodeWorkspaceStrategyJson({
                  ...existing.workspaceStrategy,
                  ...(sparse.branch !== undefined ? { branch: sparse.branch } : {}),
                  ...(sparse.worktreePath !== undefined
                    ? { worktreePath: sparse.worktreePath }
                    : {}),
                  ...(sparse.baseRef !== undefined ? { baseRef: sparse.baseRef } : {}),
                  ...(sparse.startFromOrigin !== undefined
                    ? { startFromOrigin: sparse.startFromOrigin }
                    : {}),
                });
              }
              if (input.modelSelection !== undefined) {
                patch.model_selection_json = yield* encodeModelSelectionJson(input.modelSelection);
              }
              if (input.runtimeMode !== undefined) patch.runtime_mode = input.runtimeMode;
              if (input.nextProjectId !== undefined) patch.project_id = input.nextProjectId;
              if (Object.keys(patch).length === 0) return existing;
              const now = yield* localNow;
              // Mirror the upsert rule: only a real schedule/enabled change
              // restarts the run clock — other edits retain the pending due
              // time.
              if (input.enabled !== undefined || input.schedule !== undefined) {
                const nextEnabled = input.enabled ?? existing.enabled;
                const nextSchedule = input.schedule ?? existing.schedule;
                if (
                  nextEnabled !== existing.enabled ||
                  !isSameSchedule(existing.schedule, nextSchedule)
                ) {
                  patch.next_run_at = nextRunAt(
                    { enabled: nextEnabled, schedule: nextSchedule },
                    now,
                  );
                }
              }
              patch.updated_at = iso(now);
              const clauses = [sql`task_id = ${input.id}`, sql`project_id = ${input.projectId}`];
              // A patch carrying schedule/enabled reasons from the row read
              // above (whether next_run_at gets recomputed or deliberately
              // retained), so the write guards on those snapshot columns: a
              // concurrent schedule/enabled commit turns this update into a
              // typed conflict rather than a write derived from stale state.
              if (input.enabled !== undefined || input.schedule !== undefined) {
                clauses.push(sql`enabled = ${existing.enabled ? 1 : 0}`);
                clauses.push(sql`schedule_json = ${row.schedule_json}`);
              }
              const written = yield* sql<ScheduledTaskRow>`
                UPDATE scheduled_tasks
                SET ${sql.update(patch)}
                WHERE ${sql.and(clauses)}
                RETURNING *
              `.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not update schedule task.", { taskId: input.id, cause }),
                ),
              );
              const updatedRow = written[0];
              if (updatedRow === undefined) {
                // The row was found above, so an empty RETURNING is either a
                // delete committed between the read and the write (report
                // `none`, never resurrect) or a contested scheduling edit
                // (typed conflict) — re-read inside the transaction to tell
                // them apart.
                const reread = yield* getScopedRows(input.id, input.projectId).pipe(
                  Effect.mapError((cause) =>
                    taskError("Could not re-read schedule task after a contested update.", {
                      taskId: input.id,
                      cause,
                    }),
                  ),
                );
                if (reread[0] === undefined) return null;
                return yield* taskError(
                  "The schedule task changed while it was being updated; retry the edit.",
                  { taskId: input.id },
                );
              }
              return yield* decodeRow(updatedRow);
            }),
          ),
        ).pipe(
          Effect.catchTags({
            ScheduledTaskError: (error) => Effect.fail(error),
            SqlError: (cause) =>
              Effect.fail(
                taskError("Could not update schedule task.", { taskId: input.id, cause }),
              ),
            SchemaError: (cause) =>
              Effect.fail(
                taskError("Could not update schedule task.", { taskId: input.id, cause }),
              ),
          }),
        );
        if (task === null) return Option.none();
        yield* notifyChanged;
        return Option.some({ task });
      });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = (input) =>
      Effect.gen(function* () {
        // Read and write share one transaction: the recomputed next_run_at can
        // never be based on a schedule a concurrent edit has already replaced.
        const outcome = yield* retryContended(
          sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* getRows(input.id).pipe(
                Effect.mapError((cause) =>
                  taskError("Could not load schedule task.", { taskId: input.id, cause }),
                ),
              );
              const row = rows[0];
              if (row === undefined) return null;
              const existing = yield* decodeRow(row);
              if (existing.enabled === input.enabled) {
                return { task: existing, changed: false } as const;
              }
              const now = yield* localNow;
              const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
              // RETURNING so a task deleted between the load and this UPDATE is a
              // visible not-found error, not a false success. The schedule_json
              // guard keeps a schedule committed mid-transaction from being
              // paired with a next_run_at derived from the pre-commit row.
              const updated = yield* sql<{ task_id: string }>`
                UPDATE scheduled_tasks
                SET enabled = ${input.enabled ? 1 : 0},
                    next_run_at = ${next},
                    updated_at = ${iso(now)}
                WHERE task_id = ${input.id} AND schedule_json = ${row.schedule_json}
                RETURNING task_id
              `.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not update schedule task.", { taskId: input.id, cause }),
                ),
              );
              if (updated.length === 0) {
                const reread = yield* getRows(input.id).pipe(
                  Effect.mapError((cause) =>
                    taskError("Could not re-read schedule task after a contested update.", {
                      taskId: input.id,
                      cause,
                    }),
                  ),
                );
                if (reread[0] === undefined) return null;
                return yield* taskError(
                  "The schedule task changed while it was being updated; retry the edit.",
                  { taskId: input.id },
                );
              }
              return {
                task: { ...existing, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now) },
                changed: true,
              } as const;
            }),
          ),
        ).pipe(
          Effect.catchTags({
            ScheduledTaskError: (error) => Effect.fail(error),
            SqlError: (cause) =>
              Effect.fail(
                taskError("Could not update schedule task.", { taskId: input.id, cause }),
              ),
          }),
        );
        if (outcome === null) {
          return yield* taskError("Schedule task not found.", { taskId: input.id });
        }
        if (outcome.changed) yield* notifyChanged;
        return { task: outcome.task };
      });

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      Effect.gen(function* () {
        const rows = yield* deleteRow(input.id, input.projectId);
        if (rows.length === 0) return Option.none<ScheduledTaskDeleteResult>();
        yield* notifyChanged;
        return Option.some({ id: input.id });
      });

    const runNow: ScheduledTaskService["Service"]["runNow"] = (input: ScheduledTaskRunNowInput) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
        const next = yield* runTask(task, "manual", input.projectId).pipe(
          Effect.mapError((cause) =>
            taskError("Could not run schedule task.", { taskId: input.id, cause }),
          ),
        );
        return { task: next };
      });

    return ScheduledTaskService.of({
      list,
      subscribeList,
      upsert,
      update,
      setEnabled,
      delete: deleteTask,
      runNow,
    });
  }),
);
