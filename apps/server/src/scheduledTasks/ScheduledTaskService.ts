import {
  CommandId,
  MessageId,
  type OrchestrationV2PolicyCeiling,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  type RunId,
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
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import type { CommandReceiptV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);

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

export interface ScheduledTaskManualRunInput {
  readonly id: ScheduledTaskId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly unboundThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly policyCeiling: OrchestrationV2PolicyCeiling;
}

export interface ScheduledTaskManualRunResult {
  readonly task: ScheduledTask | null;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly replayed: boolean;
  readonly receipt: CommandReceiptV2;
}

export class ScheduledTaskManualRunScopeError extends Schema.TaggedErrorClass<ScheduledTaskManualRunScopeError>()(
  "ScheduledTaskManualRunScopeError",
  { taskId: ScheduledTaskId, message: Schema.String },
) {}

export class ScheduledTaskManualRunRuntimeCeilingError extends Schema.TaggedErrorClass<ScheduledTaskManualRunRuntimeCeilingError>()(
  "ScheduledTaskManualRunRuntimeCeilingError",
  { taskId: ScheduledTaskId, message: Schema.String },
) {}

export class ScheduledTaskManualRunInteractionCeilingError extends Schema.TaggedErrorClass<ScheduledTaskManualRunInteractionCeilingError>()(
  "ScheduledTaskManualRunInteractionCeilingError",
  { taskId: ScheduledTaskId, message: Schema.String },
) {}

export class ScheduledTaskManualRunConflictError extends Schema.TaggedErrorClass<ScheduledTaskManualRunConflictError>()(
  "ScheduledTaskManualRunConflictError",
  { taskId: ScheduledTaskId, commandId: CommandId, message: Schema.String },
) {}

export class ScheduledTaskManualRunNotFoundError extends Schema.TaggedErrorClass<ScheduledTaskManualRunNotFoundError>()(
  "ScheduledTaskManualRunNotFoundError",
  { taskId: ScheduledTaskId, message: Schema.String },
) {}

export type ScheduledTaskManualRunError =
  | ScheduledTaskError
  | ScheduledTaskManualRunScopeError
  | ScheduledTaskManualRunRuntimeCeilingError
  | ScheduledTaskManualRunInteractionCeilingError
  | ScheduledTaskManualRunConflictError
  | ScheduledTaskManualRunNotFoundError;

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    /** Emits the full task list on subscribe and again after every change (CRUD, run transitions, reschedules). */
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    /** Partial update flipping only the enabled flag; never touches other fields. */
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<ScheduledTaskRunNowResult, ScheduledTaskError>;
    readonly runNowIdempotent: (
      input: ScheduledTaskManualRunInput,
    ) => Effect.Effect<ScheduledTaskManualRunResult, ScheduledTaskManualRunError>;
  }
>()("t3/scheduledTasks/ScheduledTaskService") {}

function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

function automationPrompt(task: ScheduledTask): string {
  return `[Triggered by schedule task: ${task.title}]\n\n${task.prompt}`;
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
  const next = nextScheduledRunAt(task.schedule, from);
  return next === null ? null : iso(next);
}

function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return Cause.pretty(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

function runtimeModeRank(mode: ScheduledTask["runtimeMode"]): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

function interactionModeRank(mode: ScheduledTask["interactionMode"]): number {
  return mode === "plan" ? 0 : 1;
}

const decodeRow = (row: ScheduledTaskRow) =>
  Effect.gen(function* () {
    const id = ScheduledTaskId.make(row.task_id);
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    return yield* decodeTask({
      id,
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
    Effect.mapError((cause) =>
      taskError("Could not decode schedule task row.", {
        taskId: ScheduledTaskId.make(row.task_id),
        cause,
      }),
    ),
  );

export const layer = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    const taskMutations = yield* makeKeyedSerialExecutor<ScheduledTaskId>();
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

    // Lenient decode for the scheduler: one corrupt row must never halt the
    // poll loop or crash recovery for every other task — skip it and log.
    const listTasksLenient = Effect.fn("ScheduledTaskService.listTasksLenient")(function* () {
      const rows = yield* selectAllRows();
      const tasks: ScheduledTask[] = [];
      for (const row of rows) {
        const decoded = yield* Effect.result(decodeRow(row));
        if (Result.isSuccess(decoded)) {
          tasks.push(decoded.success);
        } else {
          yield* Effect.logWarning("Skipping undecodable schedule task row", {
            taskId: row.task_id,
            cause: decoded.failure,
          });
        }
      }
      return tasks;
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

    const readCommandReceipt = (taskId: ScheduledTaskId, commandId: CommandId) =>
      threadManagement
        .getCommandReceipt(commandId)
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not read the scheduled task run receipt.", { taskId, cause }),
          ),
        );

    const authorizeFreshManualRun = Effect.fn("ScheduledTaskService.authorizeFreshManualRun")(
      function* (task: ScheduledTask, input: ScheduledTaskManualRunInput) {
        const loadScopedThread = (threadId: ThreadId, role: "caller" | "target") =>
          threadManagement.getProjectThread({ projectId: input.projectId, threadId }).pipe(
            Effect.mapError((cause) =>
              cause._tag === "ThreadManagementThreadNotFoundError"
                ? new ScheduledTaskManualRunScopeError({
                    taskId: input.id,
                    message: `The scheduled task run ${role} is not active in the calling project.`,
                  })
                : taskError(`Could not authorize the scheduled task run ${role}.`, {
                    taskId: input.id,
                    cause,
                  }),
            ),
          );
        const caller = yield* loadScopedThread(input.policyCeiling.callerThreadId, "caller");
        if (caller.thread.archivedAt !== null) {
          return yield* new ScheduledTaskManualRunScopeError({
            taskId: input.id,
            message: "The scheduled task run caller is archived.",
          });
        }
        const target =
          task.threadId === null
            ? null
            : yield* loadScopedThread(ThreadId.make(task.threadId), "target");
        if (target !== null && target.thread.archivedAt !== null) {
          return yield* new ScheduledTaskManualRunScopeError({
            taskId: input.id,
            message: "The scheduled task target is archived.",
          });
        }
        const runtimeMode = target?.thread.runtimeMode ?? task.runtimeMode;
        const interactionMode = target?.thread.interactionMode ?? task.interactionMode;
        if (
          runtimeModeRank(runtimeMode) > runtimeModeRank(input.policyCeiling.runtimeMode) ||
          runtimeModeRank(runtimeMode) > runtimeModeRank(caller.thread.runtimeMode)
        ) {
          return yield* new ScheduledTaskManualRunRuntimeCeilingError({
            taskId: input.id,
            message: `Target runtime mode ${runtimeMode} exceeds the caller ceiling.`,
          });
        }
        if (
          interactionModeRank(interactionMode) >
            interactionModeRank(input.policyCeiling.interactionMode) ||
          interactionModeRank(interactionMode) > interactionModeRank(caller.thread.interactionMode)
        ) {
          return yield* new ScheduledTaskManualRunInteractionCeilingError({
            taskId: input.id,
            message: `Target interaction mode ${interactionMode} exceeds the caller ceiling.`,
          });
        }
      },
    );

    const findAcceptedManualRun = Effect.fn("ScheduledTaskService.findAcceptedManualRun")(
      function* (input: ScheduledTaskManualRunInput) {
        const initialMessageCommandId = CommandId.make(`${input.commandId}:initial-message`);
        const initialMessageReceipt = yield* readCommandReceipt(input.id, initialMessageCommandId);
        let receipt = Option.getOrUndefined(initialMessageReceipt);
        if (receipt === undefined) {
          const primaryReceipt = yield* readCommandReceipt(input.id, input.commandId);
          if (Option.isNone(primaryReceipt)) {
            return Option.none<ScheduledTaskManualRunResult>();
          }
          if (primaryReceipt.value.status === "rejected") {
            return yield* taskError("This manual run request was previously rejected.", {
              taskId: input.id,
            });
          }
          if (primaryReceipt.value.commandType === "thread.create") {
            if (primaryReceipt.value.threadId !== input.unboundThreadId) {
              return yield* new ScheduledTaskManualRunConflictError({
                taskId: input.id,
                commandId: input.commandId,
                message: "The idempotency key belongs to a different scheduled task run.",
              });
            }
            // Thread creation committed, but the scheduled prompt did not. Let
            // ThreadLaunchService replay the create receipt and finish the same
            // task-specific initial message.
            return Option.none<ScheduledTaskManualRunResult>();
          }
          receipt = primaryReceipt.value;
        }
        if (receipt.status === "rejected") {
          return yield* taskError("This manual run request was previously rejected.", {
            taskId: input.id,
          });
        }
        if (receipt.commandType !== "message.dispatch") {
          return yield* new ScheduledTaskManualRunConflictError({
            taskId: input.id,
            commandId: input.commandId,
            message: "The idempotency key belongs to a different command.",
          });
        }

        const caller = yield* threadManagement
          .getThreadProjection(input.policyCeiling.callerThreadId)
          .pipe(
            Effect.mapError((cause) =>
              taskError("Could not authorize the scheduled task run caller.", {
                taskId: input.id,
                cause,
              }),
            ),
          );
        const target = yield* threadManagement.getThreadProjection(receipt.threadId).pipe(
          Effect.mapError((cause) =>
            taskError("Could not load the accepted scheduled task run.", {
              taskId: input.id,
              cause,
            }),
          ),
        );
        if (
          caller.thread.deletedAt !== null ||
          caller.thread.archivedAt !== null ||
          caller.thread.projectId !== input.projectId ||
          target.thread.deletedAt !== null ||
          target.thread.projectId !== input.projectId
        ) {
          return yield* new ScheduledTaskManualRunScopeError({
            taskId: input.id,
            message: "The accepted run is no longer authorized in the calling project.",
          });
        }
        if (
          runtimeModeRank(target.thread.runtimeMode) >
            runtimeModeRank(input.policyCeiling.runtimeMode) ||
          runtimeModeRank(target.thread.runtimeMode) > runtimeModeRank(caller.thread.runtimeMode)
        ) {
          return yield* new ScheduledTaskManualRunRuntimeCeilingError({
            taskId: input.id,
            message: `Target runtime mode ${target.thread.runtimeMode} exceeds the caller ceiling.`,
          });
        }
        if (
          interactionModeRank(target.thread.interactionMode) >
            interactionModeRank(input.policyCeiling.interactionMode) ||
          interactionModeRank(target.thread.interactionMode) >
            interactionModeRank(caller.thread.interactionMode)
        ) {
          return yield* new ScheduledTaskManualRunInteractionCeilingError({
            taskId: input.id,
            message: `Target interaction mode ${target.thread.interactionMode} exceeds the caller ceiling.`,
          });
        }

        const message = target.messages.find((candidate) => candidate.id === input.messageId);
        const run =
          message?.runId === null || message?.runId === undefined
            ? undefined
            : target.runs.find((candidate) => candidate.id === message.runId);
        if (message === undefined || run === undefined) {
          return yield* new ScheduledTaskManualRunConflictError({
            taskId: input.id,
            commandId: input.commandId,
            message: "The idempotency key was already accepted for a different scheduled task run.",
          });
        }
        return Option.some({
          task: null,
          threadId: target.thread.id,
          messageId: message.id,
          runId: run.id,
          status: run.status,
          replayed: true,
          receipt,
        } satisfies ScheduledTaskManualRunResult);
      },
    );

    // Run-state columns (last_run_*, run_count) are intentionally absent from
    // the conflict clause: they are owned by the run transitions below, and a
    // concurrent settings save must not overwrite an in-flight increment.
    const saveTask = (task: ScheduledTask) =>
      sql`
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
        VALUES (
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
        )
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
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not save schedule task.", { taskId: task.id, cause }),
        ),
      );

    const deleteRow = (id: ScheduledTaskId) =>
      sql`DELETE FROM scheduled_tasks WHERE task_id = ${id}`.pipe(
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
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return; // deleted — nothing to release
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed',
              last_run_error = ${message},
              next_run_at = ${nextRunAt(source, now)},
              updated_at = ${iso(now)},
              run_count = run_count + 1
          WHERE task_id = ${task.id} AND last_run_status = 'running'
        `;
        yield* notifyChanged;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not release stuck schedule task run", {
            taskId: task.id,
            cause,
          }),
        ),
      );

    const acceptedManualRun = Effect.fn("ScheduledTaskService.acceptedManualRun")(function* (
      input: ScheduledTaskManualRunInput,
      projection: OrchestrationV2ThreadProjection,
      receiptCommandId: CommandId,
    ) {
      const receiptOption = yield* readCommandReceipt(input.id, receiptCommandId);
      if (Option.isNone(receiptOption) || receiptOption.value.status !== "accepted") {
        return yield* taskError(
          "The scheduled task dispatch did not produce an accepted receipt.",
          {
            taskId: input.id,
          },
        );
      }
      const message = projection.messages.find((candidate) => candidate.id === input.messageId);
      const run =
        message?.runId === null || message?.runId === undefined
          ? undefined
          : projection.runs.find((candidate) => candidate.id === message.runId);
      if (message === undefined || run === undefined) {
        return yield* taskError("The scheduled task dispatch is missing its durable run.", {
          taskId: input.id,
        });
      }
      return {
        task: null,
        threadId: projection.thread.id,
        messageId: message.id,
        runId: run.id,
        status: run.status,
        replayed: false,
        receipt: receiptOption.value,
      } satisfies ScheduledTaskManualRunResult;
    });

    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      trigger: "scheduled" | "manual",
      manualRun?: ScheduledTaskManualRunInput,
    ) {
      const reserved = yield* Ref.modify(activeRuns, (active) => {
        if (active.has(task.id)) return [false, active] as const;
        const next = new Set(active);
        next.add(task.id);
        return [true, next] as const;
      });
      if (!reserved) {
        if (trigger === "manual") {
          if (manualRun !== undefined) {
            return yield* new ScheduledTaskManualRunConflictError({
              taskId: task.id,
              commandId: manualRun.commandId,
              message: "Schedule task is already running.",
            });
          }
          return yield* taskError("Schedule task is already running.", { taskId: task.id });
        }
        return { task, manualRun: null, dispatchError: null };
      }

      return yield* taskMutations
        .withLock(
          task.id,
          Effect.gen(function* () {
            const startedAt = yield* localNow;
            const startedAtIso = iso(startedAt);

            // The in-memory snapshot may be stale: re-read after admission and
            // before touching run state. CRUD uses this same task lock.
            const active = yield* findTask(task.id);
            if (active === null) {
              if (trigger === "manual") {
                if (manualRun !== undefined) {
                  return yield* new ScheduledTaskManualRunNotFoundError({
                    taskId: task.id,
                    message: "Schedule task not found.",
                  });
                }
                return yield* taskError("Schedule task not found.", { taskId: task.id });
              }
              return { task, manualRun: null, dispatchError: null };
            }
            if (manualRun !== undefined && active.projectId !== manualRun.projectId) {
              return yield* new ScheduledTaskManualRunScopeError({
                taskId: active.id,
                message: "The scheduled task does not belong to the calling project.",
              });
            }
            if (manualRun !== undefined) {
              yield* authorizeFreshManualRun(active, manualRun);
            }
            if (
              trigger === "scheduled" &&
              (!active.enabled ||
                active.nextRunAt === null ||
                DateTime.toEpochMillis(DateTime.makeUnsafe(active.nextRunAt)) >
                  DateTime.toEpochMillis(startedAt))
            ) {
              return { task: active, manualRun: null, dispatchError: null };
            }

            yield* markRunning(active.id, startedAtIso);
            yield* notifyChanged;

            const fireKey = `${active.id}:${DateTime.toEpochMillis(startedAt)}:${trigger}`;
            const commandId = manualRun?.commandId ?? CommandId.make(`scheduled-task:${fireKey}`);
            const messageId =
              manualRun?.messageId ?? MessageId.make(`scheduled-task-message:${fireKey}`);
            const prompt = automationPrompt(active);

            // Effect.exit captures defects and interruption so bookkeeping is
            // terminal even when dispatch is rejected before a turn starts.
            const result =
              active.threadId === null
                ? yield* Effect.exit(
                    threadLaunch
                      .launch({
                        commandId,
                        ...(manualRun === undefined ? {} : { threadId: manualRun.unboundThreadId }),
                        projectId: active.projectId,
                        title: active.title,
                        modelSelection: active.modelSelection,
                        runtimeMode: active.runtimeMode,
                        interactionMode: active.interactionMode,
                        ...(manualRun === undefined
                          ? {}
                          : { policyCeiling: manualRun.policyCeiling }),
                        workspaceStrategy: active.workspaceStrategy,
                        initialMessage: {
                          messageId,
                          text: prompt,
                          attachments: [],
                        },
                        createdBy: active.createdBy,
                        creationSource: active.creationSource,
                      })
                      .pipe(
                        Effect.flatMap((launched) =>
                          manualRun === undefined
                            ? Effect.succeed(null)
                            : acceptedManualRun(
                                manualRun,
                                launched.projection,
                                CommandId.make(`${commandId}:initial-message`),
                              ),
                        ),
                      ),
                  )
                : yield* Effect.exit(
                    threadManagement
                      .sendToThread({
                        projectId: active.projectId,
                        commandId,
                        threadId: ThreadId.make(active.threadId),
                        messageId,
                        text: prompt,
                        attachments: [],
                        modelSelection: active.modelSelection,
                        ...(manualRun === undefined
                          ? {}
                          : { policyCeiling: manualRun.policyCeiling }),
                        mode: "auto",
                        createdBy: active.createdBy,
                        creationSource: active.creationSource,
                      })
                      .pipe(
                        Effect.flatMap((sent) =>
                          manualRun === undefined
                            ? Effect.succeed(null)
                            : acceptedManualRun(manualRun, sent.projection, commandId),
                        ),
                      ),
                  );

            const completedAt = yield* localNow;
            const runSucceeded = result._tag === "Success";
            const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
            const lastRunError = runSucceeded ? null : errorMessage(result.cause);
            const current = yield* findTask(task.id);
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
            if (current !== null) {
              yield* markCompleted({
                id: task.id,
                completedAtIso: completed.updatedAt,
                nextRunAtIso: completed.nextRunAt,
                status: lastRunStatus,
                error: lastRunError,
                startedAtIso,
              });
              yield* notifyChanged;
            }
            return {
              task: completed,
              manualRun: runSucceeded ? result.value : null,
              dispatchError: runSucceeded ? null : result.cause,
            };
          }).pipe(Effect.onError((cause) => releaseStuckRun(task, errorMessage(cause)))),
        )
        .pipe(
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
      yield* sql`
        UPDATE scheduled_tasks
        SET next_run_at = ${next},
            updated_at = ${iso(now)}
        WHERE task_id = ${task.id}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule missed schedule task run.", { taskId: task.id, cause }),
        ),
      );
      yield* notifyChanged;
    });

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
      const tasks = yield* listTasksLenient().pipe(
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      const now = yield* localNow;
      const nowEpochMillis = DateTime.toEpochMillis(now);
      const due = tasks.flatMap((task) => {
        if (!task.enabled || task.nextRunAt === null || task.lastRunStatus === "running") {
          return [];
        }
        const dueAt = DateTime.makeUnsafe(task.nextRunAt);
        return DateTime.toEpochMillis(dueAt) <= nowEpochMillis ? [{ task, dueAt }] : [];
      });
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          (isMissedFixedTimeRun(task.schedule, dueAt, now)
            ? rescheduleMissedRun(task, now)
            : runTask(task, "scheduled")
          ).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
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
              yield* sql`
                UPDATE scheduled_tasks
                SET last_run_status = 'failed',
                    last_run_error = 'Run was interrupted by a server restart.',
                    next_run_at = ${nextRunAt(decoded.success, now)},
                    updated_at = ${iso(now)},
                    run_count = run_count + 1
                WHERE task_id = ${row.task_id} AND last_run_status = 'running'
              `;
              return;
            }
            // The schedule cannot be decoded, so the next occurrence cannot
            // be computed — still release the row so it is not stuck in
            // 'running' (the lenient poller skips it, so it cannot re-fire).
            yield* Effect.logWarning(
              "Recovering undecodable schedule task row without rescheduling",
              { taskId: row.task_id, cause: decoded.failure },
            );
            yield* sql`
              UPDATE scheduled_tasks
              SET last_run_status = 'failed',
                  last_run_error = 'Run was interrupted by a server restart.',
                  updated_at = ${iso(now)},
                  run_count = run_count + 1
              WHERE task_id = ${row.task_id} AND last_run_status = 'running'
            `;
          }),
        { concurrency: 1, discard: true },
      );
      yield* notifyChanged;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reset interrupted schedule task runs", { cause }),
      ),
    );

    yield* runDueTasks().pipe(
      Effect.catch((cause) => Effect.logWarning("Scheduled task polling failed", { cause })),
      Effect.delay(Duration.seconds(5)),
      Effect.forever,
      Effect.forkScoped,
    );

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
        return yield* taskMutations.withLock(
          id,
          Effect.gen(function* () {
            const now = yield* localNow;
            // Look up by the *resolved* id so idempotent creates (commandId replays)
            // keep their run history, and so real load failures propagate instead
            // of silently resetting an existing row.
            const existingTask = yield* findTask(id);
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
            yield* saveTask(task);
            yield* notifyChanged;
            return { task };
          }),
        );
      });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = (input) =>
      taskMutations.withLock(
        input.id,
        Effect.gen(function* () {
          const existing = yield* loadTask(input.id);
          if (existing.enabled === input.enabled) return { task: existing };
          const now = yield* localNow;
          const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
          const updated = yield* sql<{ task_id: string }>`
            UPDATE scheduled_tasks
            SET enabled = ${input.enabled ? 1 : 0},
                next_run_at = ${next},
                updated_at = ${iso(now)}
            WHERE task_id = ${input.id}
            RETURNING task_id
          `.pipe(
            Effect.mapError((cause) =>
              taskError("Could not update schedule task.", { taskId: input.id, cause }),
            ),
          );
          if (updated.length === 0) {
            return yield* taskError("Schedule task not found.", { taskId: input.id });
          }
          yield* notifyChanged;
          return {
            task: { ...existing, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now) },
          };
        }),
      );

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      taskMutations.withLock(
        input.id,
        deleteRow(input.id).pipe(Effect.andThen(notifyChanged), Effect.as({ id: input.id })),
      );

    const runNow: ScheduledTaskService["Service"]["runNow"] = (input: ScheduledTaskRunNowInput) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
        const next = yield* runTask(task, "manual").pipe(
          Effect.mapError((cause) =>
            taskError("Could not run schedule task.", { taskId: input.id, cause }),
          ),
        );
        return { task: next.task };
      });

    const runNowIdempotent: ScheduledTaskService["Service"]["runNowIdempotent"] = (input) =>
      Effect.gen(function* () {
        const replay = yield* findAcceptedManualRun(input);
        if (Option.isSome(replay)) return replay.value;
        const task = yield* findTask(input.id);
        if (task === null) {
          return yield* new ScheduledTaskManualRunNotFoundError({
            taskId: input.id,
            message: "Schedule task not found.",
          });
        }
        const outcome = yield* runTask(task, "manual", input);
        if (outcome.dispatchError !== null) {
          return yield* taskError("Could not dispatch schedule task run.", {
            taskId: input.id,
            cause: outcome.dispatchError,
          });
        }
        if (outcome.manualRun === null) {
          return yield* taskError("The schedule task run was not dispatched.", {
            taskId: input.id,
          });
        }
        return { ...outcome.manualRun, task: outcome.task };
      });

    return ScheduledTaskService.of({
      list,
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      runNow,
      runNowIdempotent,
    });
  }),
);
