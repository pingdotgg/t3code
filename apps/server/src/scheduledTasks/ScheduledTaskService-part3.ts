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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { ScheduledTaskService, ScheduledTaskWebhookOrigin, iso, localNow, taskError } from "./ScheduledTaskService.ts";
import type { RateWindow } from "./ScheduledTaskService.ts";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { decodeRow } from "./ScheduledTaskServiceParts.ts";
import { nextRunAt } from "./ScheduledTaskServiceParts3.ts";
import { nextRunAfterRun } from "./ScheduledTaskServiceParts4.ts";
import type { ScheduledTaskRow } from "./ScheduledTaskServiceParts5.ts";

export const makeScheduledTaskState = Effect.fn("makeScheduledTaskState")(function* () {
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const secretRequests = yield* SecretRequests.SecretRequests;
    const scheduler = yield* Scheduler.Scheduler;
    const readWebhookOrigin = yield* ScheduledTaskWebhookOrigin;
    const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
    const webhookPolicyOrganization = ManagedPolicy.deniedBy(managedPolicy, "webhookTasks");
    // Existing webhook tasks stay stored but report why they do not run.
    const webhookPolicyBlock =
      webhookPolicyOrganization === undefined
        ? undefined
        : managedPolicyDeniedMessage(webhookPolicyOrganization, "webhook tasks");
    const withPolicy = (task: ScheduledTask): ScheduledTask =>
      webhookPolicyBlock !== undefined && task.schedule.type === "webhook"
        ? { ...task, blockedByPolicy: webhookPolicyBlock }
        : task;
    const webhookPermits = yield* Ref.make<ReadonlyMap<ScheduledTaskId, Semaphore.Semaphore>>(
      new Map(),
    );
    // Include creation time so late deliveries cannot decrement a recreated task's count.
    const webhookQueued = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const webhookRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(new Map());
    const webhookRejectedRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(
      new Map(),
    );
    const webhookDedupeLogWindows = yield* Ref.make<
      ReadonlyMap<ScheduledTaskId, ReadonlyArray<number>>
    >(new Map());
    const pendingInFlight = yield* Ref.make<ReadonlySet<string>>(new Set());
    const webhookFilteredLogWindows = yield* Ref.make<
      ReadonlyMap<ScheduledTaskId, ReadonlyArray<number>>
    >(new Map());
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    // Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const dueTasks = DueHint.make();
    const pendingWebhooks = DueHint.make();
    // Every scheduled_tasks write that can change next_run_at, enabled or run state notifies.
    const notifyChanged = dueTasks.invalidate.pipe(
      Effect.andThen(PubSub.publish(changesPubSub, undefined)),
      Effect.asVoid,
    );

    const selectAllRows = () =>
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
        run_count,
        webhook_token,
        webhook_secret
      FROM scheduled_tasks
      -- Not updated_at: toggles, runs and edits rewrite it, and clients render
      -- this order as-is, so rows would move under the pointer.
      ORDER BY created_at DESC, task_id ASC
    `.pipe(NodeSqliteClient.readOnly);

    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* () {
      const rows = yield* selectAllRows();
      const origin = yield* readWebhookOrigin;
      return yield* Effect.forEach(
        rows,
        (row) => decodeRow(row, origin).pipe(Effect.map(withPolicy)),
        { concurrency: 1 },
      );
    });

    const getRows = (id: ScheduledTaskId) =>
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
        run_count,
        webhook_token,
        webhook_secret
      FROM scheduled_tasks
      WHERE task_id = ${id}
    `.pipe(NodeSqliteClient.readOnly);

    const findTask = Effect.fn("ScheduledTaskService.findTask")(function* (id: ScheduledTaskId) {
      const rows = yield* getRows(id).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return withPolicy(yield* decodeRow(row, yield* readWebhookOrigin));
    });

    const findWebhookCredentials = (id: ScheduledTaskId) =>
      getRows(id).pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? null
            : { token: rows[0].webhook_token, secret: rows[0].webhook_secret },
        ),
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );

    const newWebhookToken = random.randomBytes(32).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.mapError((cause) => taskError("Could not generate webhook token.", { cause })),
    );

    const loadTask = Effect.fn("ScheduledTaskService.loadTask")(function* (id: ScheduledTaskId) {
      const task = yield* findTask(id);
      if (task === null) {
        return yield* taskError("Schedule task not found.", { taskId: id });
      }
      return task;
    });

    // Run transitions own run-state columns; settings saves must not overwrite them.
    // Check existence in the write so edits cannot undo concurrent deletion.
    const saveTask = (
      task: ScheduledTask,
      requireExisting: boolean,
      /** The schedule this save read, when it left the schedule unchanged. */
      keptSchedule: ScheduledTask["schedule"] | null,
      webhook: {
        readonly token: string | null;
        readonly secret: string | null;
        readonly secretChanged: boolean;
      },
    ) =>
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
          run_count,
          webhook_token,
          webhook_secret
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
          ${task.runCount},
          ${webhook.token},
          ${webhook.secret}
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
          -- Keep a next_run_at that a finishing run moved during this save, unless
          -- another edit changed the schedule or enabled state meanwhile.
          next_run_at = CASE
            WHEN ${keptSchedule === null ? 0 : 1} = 1
              AND scheduled_tasks.schedule_json IN (
                excluded.schedule_json,
                ${keptSchedule === null ? null : JSON.stringify(keptSchedule)}
              )
              AND scheduled_tasks.enabled = excluded.enabled
            THEN scheduled_tasks.next_run_at
            ELSE excluded.next_run_at
          END,
          -- Only rotate changes a live token, so a save racing a rotation
          -- cannot bring the old URL back.
          webhook_token = CASE
            WHEN excluded.webhook_token IS NULL THEN NULL
            ELSE COALESCE(scheduled_tasks.webhook_token, excluded.webhook_token)
          END,
          webhook_secret = CASE
            WHEN ${webhook.secretChanged ? 1 : 0} = 1 THEN excluded.webhook_secret
            ELSE scheduled_tasks.webhook_secret
          END
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

    const deleteRow = (id: ScheduledTaskId) =>
      sql
        .withTransaction(
          sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id = ${id}`.pipe(
            Effect.andThen(sql`DELETE FROM scheduled_tasks WHERE task_id = ${id}`),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete schedule task.", { taskId: id, cause }),
          ),
        );

    const markRunning = (id: ScheduledTaskId, startedAtIso: string, webhookDeliveryId?: string) =>
      sql<{ task_id: string }>`
        UPDATE scheduled_tasks
        SET updated_at = ${startedAtIso},
            last_run_at = ${startedAtIso},
            last_run_webhook_delivery_id = ${webhookDeliveryId ?? null},
            last_run_status = 'running',
            last_run_error = NULL
        WHERE task_id = ${id}
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not mark schedule task as running.", { taskId: id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0 ? Effect.void : taskError("Schedule task not found.", { taskId: id }),
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
        RETURNING task_id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );

    // A failure between markRunning and markCompleted must still write a terminal record:
    // runDueTasks skips 'running' rows forever, and the dispatch may already have gone out,
    // so next_run_at must advance. Pending webhook attempts count only with their completion.
    const releaseStuckRun = Effect.fn("ScheduledTaskService.releaseStuckRun")(
      function* (
        task: ScheduledTask,
        startedAtIso: string,
        message: string,
        pendingDeliveryId?: string,
      ) {
        const now = yield* localNow;
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return;
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed',
              last_run_error = ${message},
              next_run_at = ${nextRunAfterRun({ ...source, lastRunAt: startedAtIso }, now)},
              updated_at = ${iso(now)},
              run_count = run_count + CASE WHEN EXISTS (
                SELECT 1 FROM scheduled_task_webhook_pending
                WHERE delivery_id = ${pendingDeliveryId ?? null} AND state = 'running'
              ) THEN 0 ELSE 1 END
          WHERE task_id = ${task.id} AND last_run_status = 'running'
        `;
        yield* notifyChanged;
      },
      (effect, task, _startedAtIso, _message, _pendingDeliveryId) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not release stuck schedule task run", {
              taskId: task.id,
              cause,
            }),
          ),
        ),
    );

    return {
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
    };
});
