import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProjectId,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  ScheduledTaskWebhookDeliveryId,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskGetWebhookDeliveryInput,
  type ScheduledTaskGetWebhookDeliveryResult,
  type ScheduledTaskListWebhookDeliveriesInput,
  type ScheduledTaskListWebhookDeliveriesResult,
  type ScheduledTaskRotateWebhookTokenInput,
  type ScheduledTaskWebhookDeliveryOutcome,
  type ScheduledTaskWebhookFilter,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskUpsertInput,
  managedPolicyDeniedMessage,
  managedRuntimeModeDenial,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ScheduledTaskService, WebhookDeliverySkipped, errorMessage, isScheduledTaskError, iso, localNow, taskError } from "./ScheduledTaskService.ts";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";
import { decodeRow } from "./ScheduledTaskServiceParts.ts";
import { listDueTasks } from "./ScheduledTaskServiceParts2.ts";
import { nextRunAt } from "./ScheduledTaskServiceParts3.ts";
import { nextRunAfterRun } from "./ScheduledTaskServiceParts4.ts";

import type { makeScheduledTaskState } from "./ScheduledTaskService-part3.ts";

type State = Effect.Success<ReturnType<typeof makeScheduledTaskState>>;

export const makeScheduledTaskStage2 = Effect.fn("makeScheduledTaskStage2")(function* (state: State) {
    const {
      sql,
      random,
      threadLaunch,
      threadManagement,
      managedFolders,
      secretRequests,
      scheduler,
      readWebhookOrigin,
      managedPolicy,
      webhookPolicyOrganization,
      webhookPolicyBlock,
      withPolicy,
      webhookPermits,
      webhookQueued,
      webhookRateWindows,
      webhookRejectedRateWindows,
      webhookDedupeLogWindows,
      pendingInFlight,
      webhookFilteredLogWindows,
      activeRuns,
      changesPubSub,
      dueTasks,
      pendingWebhooks,
      notifyChanged,
      selectAllRows,
      listRows,
      getRows,
      findTask,
      findWebhookCredentials,
      newWebhookToken,
      loadTask,
      saveTask,
      deleteRow,
      markRunning,
      markCompleted,
      releaseStuckRun,
    } = state;
    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      trigger: "scheduled" | "manual" | "webhook",
      webhook?: {
        readonly deliveryId: string;
        readonly prompt: string;
        readonly dispatched: Ref.Ref<boolean>;
      },
    ) {
      // Read before reserving: nothing between the reservation and its release may fail.
      const startedAt = yield* localNow;
      const startedAtIso = iso(startedAt);
      const run = Effect.gen(function* () {
        // Re-read stale poll snapshots so deleted, paused or postponed tasks cannot fire.
        const active = yield* findTask(task.id);
        if (active === null) {
          if (webhook !== undefined) {
            return yield* new WebhookDeliverySkipped({
              reason: "The task was deleted before this delivery ran.",
            });
          }
          if (trigger !== "scheduled") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return { task, threadId: null, dispatchFailed: false };
        }
        if (
          webhook !== undefined &&
          (yield* sql`SELECT 1 FROM scheduled_task_webhook_pending WHERE delivery_id = ${webhook.deliveryId} AND state = 'completed'`.pipe(
            NodeSqliteClient.readOnly,
          )).length > 0
        )
          return {
            task: { ...active, lastRunStatus: "succeeded" as const },
            threadId: null,
            dispatchFailed: false,
          };
        const parsedNextRunAt =
          active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
        if (
          trigger === "scheduled" &&
          (!active.enabled ||
            Option.isNone(parsedNextRunAt) ||
            DateTime.toEpochMillis(parsedNextRunAt.value) > DateTime.toEpochMillis(startedAt))
        ) {
          return { task: active, threadId: null, dispatchFailed: false };
        }
        // Reject queued deliveries after pause, same-id recreation or trigger changes.
        if (webhook !== undefined) {
          const reason =
            active.createdAt !== task.createdAt
              ? "The task was replaced before this delivery ran."
              : active.schedule.type !== "webhook"
                ? "The task's trigger changed before this delivery ran."
                : webhookPolicyBlock !== undefined
                  ? webhookPolicyBlock
                  : !active.enabled
                    ? "The task was paused before this delivery ran."
                    : null;
          if (reason !== null) return yield* new WebhookDeliverySkipped({ reason });
        }

        if (webhook === undefined) yield* markRunning(active.id, startedAtIso);
        else
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* markRunning(active.id, startedAtIso, webhook.deliveryId);
                // Recovery must distinguish this delivery from other windows waiting on the same task.
                yield* sql`UPDATE scheduled_task_webhook_pending SET state = 'running' WHERE delivery_id = ${webhook.deliveryId}`;
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                taskError("Could not start webhook run.", { taskId: task.id, cause }),
              ),
            );

        yield* notifyChanged;

        const fireKey =
          webhook === undefined
            ? `${active.id}:${DateTime.toEpochMillis(startedAt)}:${trigger}`
            : `${active.id}:webhook:${webhook.deliveryId}`;
        const commandId = CommandId.make(`scheduled-task:${fireKey}`);
        const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
        const prompt = webhook?.prompt ?? active.prompt;

        // A bound thread can move to another project (No project to a project) while
        // this fires. Follow it; one move needs at most two retries. Same ids replay safely.
        const sendBound = (
          threadId: ThreadId,
          projectId: ProjectId,
          retries: number,
        ): ReturnType<typeof threadManagement.sendToThread> =>
          threadManagement
            .sendToThread({
              projectId,
              commandId,
              threadId,
              messageId,
              scheduledTaskId: active.id,
              text: prompt,
              attachments: [],
              mode: "queue",
              createdBy: active.createdBy,
              creationSource: active.creationSource,
            })
            .pipe(
              Effect.catchTags({
                ThreadManagementThreadNotFoundError: (error) =>
                  retries === 0
                    ? Effect.fail(error)
                    : threadManagement.getThreadShell(threadId).pipe(
                        Effect.orElseSucceed(() => null),
                        Effect.flatMap((shell) =>
                          shell === null || shell.projectId === projectId
                            ? Effect.fail(error)
                            : sendBound(threadId, shell.projectId, retries - 1),
                        ),
                      ),
              }),
            );

        // Capture defects and interrupts too so dispatch failures still reach markCompleted.
        const result =
          active.threadId === null
            ? yield* Effect.exit(
                threadLaunch
                  .launch({
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
                  })
                  .pipe(Effect.map((launched) => launched.threadId)),
              )
            : yield* Effect.exit(
                // The stored selection only seeds fresh threads. A bound run
                // follows the thread's current provider, so it passes none.
                sendBound(ThreadId.make(active.threadId), active.projectId, 2).pipe(
                  Effect.as(ThreadId.make(active.threadId)),
                ),
              );

        const runSucceeded = result._tag === "Success";
        if (webhook !== undefined && runSucceeded) yield* Ref.set(webhook.dispatched, true);
        const completedAt = yield* localNow;
        const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
        const lastRunError = runSucceeded ? null : errorMessage(result.cause);
        const threadId = runSucceeded ? result.value : null;
        // One transaction, so an edit cannot land between reading the schedule and
        // writing the next run computed from it. The origin is read first: it reads
        // files, and the transaction holds SQLite's writer lock.
        const origin = yield* readWebhookOrigin;
        const record = Effect.gen(function* () {
          const [row] = yield* getRows(task.id);
          const current = row === undefined ? null : yield* decodeRow(row, origin);
          const scheduleSource = current ?? task;
          const completed: ScheduledTask = {
            ...scheduleSource,
            updatedAt: iso(completedAt),
            lastRunAt: startedAtIso,
            // A manual run that starts before a one-time run must not use it up.
            nextRunAt: nextRunAt(
              scheduleSource,
              scheduleSource.schedule.type === "once" ? startedAt : completedAt,
            ),
            lastRunStatus,
            lastRunError,
            runCount: scheduleSource.runCount + 1,
          };
          if (current === null) return { recorded: completed, written: false };
          // startedAtIso in the guard ensures this writes only to the row this
          // run marked as running — a task deleted mid-run and recreated with
          // the same id (idempotent commandId replay) must not be stamped.
          const completion = markCompleted({
            id: task.id,
            completedAtIso: completed.updatedAt,
            nextRunAtIso: completed.nextRunAt,
            status: lastRunStatus,
            error: lastRunError,
            startedAtIso,
          });
          let written = false;
          if (webhook === undefined) written = yield* completion;
          else {
            const pending =
              yield* sql`SELECT 1 FROM scheduled_task_webhook_pending WHERE delivery_id = ${webhook.deliveryId}`;
            if (pending.length === 0) written = yield* completion;
            else {
              const counted =
                yield* sql`UPDATE scheduled_task_webhook_pending SET state = ${runSucceeded ? "completed" : "failed"}
                WHERE delivery_id = ${webhook.deliveryId} AND state NOT IN ('completed', 'failed') RETURNING delivery_id`;
              if (counted.length > 0) written = yield* completion;
            }
          }
          // A row recreated mid-run is not this run's, so report what is stored.
          return { recorded: written ? completed : current, written };
        });
        const { recorded, written } = yield* sql
          .withTransaction(record)
          .pipe(
            Effect.mapError((cause) =>
              isScheduledTaskError(cause)
                ? cause
                : taskError(
                    webhook === undefined
                      ? "Could not record schedule task run."
                      : "Could not record webhook completion.",
                    { taskId: task.id, cause },
                  ),
            ),
          );
        if (written) yield* notifyChanged;
        // The stored row can belong to a replacement, so report this dispatch separately.
        return { task: recorded, threadId, dispatchFailed: !runSucceeded };
      }).pipe(
        Effect.onError((cause) =>
          releaseStuckRun(task, startedAtIso, errorMessage(cause), webhook?.deliveryId),
        ),
      );

      // Reserve and release as one bracket so an interrupt cannot leave the task marked busy.
      return yield* Effect.acquireUseRelease(
        Ref.modify(activeRuns, (active) => {
          if (active.has(task.id)) return [false, active] as const;
          const next = new Set(active);
          next.add(task.id);
          return [true, next] as const;
        }),
        (reserved) =>
          reserved
            ? run
            : trigger !== "scheduled"
              ? Effect.fail(taskError("Schedule task is already running.", { taskId: task.id }))
              : Effect.succeed({ task, threadId: null, dispatchFailed: false }),
        (reserved) =>
          reserved
            ? Ref.update(activeRuns, (active) => {
                const next = new Set(active);
                next.delete(task.id);
                return next;
              })
            : Effect.void,
      );
    });

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
      const now = yield* localNow;
      const nowMs = DateTime.toEpochMillis(now);
      if (yield* dueTasks.isIdle(nowMs)) return;
      const readVersion = yield* dueTasks.version;
      const [next] = yield* sql<{ next_run_at: string | null }>`
        SELECT MIN(next_run_at) AS next_run_at FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND last_run_status <> 'running'
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      // Compare as text like listDueTasks: expanded years (`+011533-…`) sort first but parse far ahead.
      const nextRunAt = next?.next_run_at ?? null;
      if (nextRunAt === null || nextRunAt > iso(now)) {
        const nextDueAt =
          nextRunAt === null
            ? Option.some(Infinity)
            : DateTime.make(nextRunAt).pipe(Option.map(DateTime.toEpochMillis));
        if (Option.isSome(nextDueAt) && nextDueAt.value > nowMs) {
          yield* dueTasks.record(readVersion, nextDueAt.value, nowMs);
        }
        return;
      }
      const tasks = yield* listDueTasks(now).pipe(
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      const due = tasks.flatMap((task) =>
        task.nextRunAt === null ? [] : [{ task, dueAt: DateTime.makeUnsafe(task.nextRunAt) }],
      );
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          Effect.suspend(() =>
            isMissedFixedTimeRun(task.schedule, dueAt, now)
              ? rescheduleMissedRun(task, now)
              : runTask(task, "scheduled"),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    // Recover crash-left running rows that the due-task filter would otherwise skip forever.
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
                    next_run_at = ${nextRunAfterRun(decoded.success, now)},
                    updated_at = ${iso(now)},
                    run_count = run_count + CASE WHEN EXISTS (
                      SELECT 1 FROM scheduled_task_webhook_pending
                      WHERE task_id IS ${row.task_id} AND state = 'running'
                        AND delivery_id = scheduled_tasks.last_run_webhook_delivery_id
                    ) THEN 0 ELSE 1 END
                WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
              `;
              return;
            }
            yield* Effect.logWarning(
              "Recovering undecodable schedule task row without rescheduling",
              { taskId: row.task_id, cause: decoded.failure },
            );
            yield* sql`
              UPDATE scheduled_tasks
              SET last_run_status = 'failed',
                  last_run_error = 'Run was interrupted by a server restart.',
                  updated_at = ${iso(now)},
                  run_count = run_count + CASE WHEN EXISTS (
                    SELECT 1 FROM scheduled_task_webhook_pending
                    WHERE task_id IS ${row.task_id} AND state = 'running'
                        AND delivery_id = scheduled_tasks.last_run_webhook_delivery_id
                  ) THEN 0 ELSE 1 END
              WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
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

    yield* scheduler.register("scheduled-tasks", runDueTasks());

    return {
      ...state,
      runTask,
      rescheduleMissedRun,
      runDueTasks,
    };
});
