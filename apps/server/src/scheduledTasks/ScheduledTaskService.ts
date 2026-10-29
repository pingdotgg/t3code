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
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Metric from "effect/Metric";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";
import {
  redactHeaders,
  redactQuery,
  renderWebhookPrompt,
  type WebhookRequest,
} from "./webhookTemplate.ts";
import {
  acceptWebhookDedupe,
  acceptImmediateWebhookDedupe,
  releaseWebhookReplay,
  decodePendingTask,
  decodePendingRequest,
  dedupeError,
} from "./webhookDedupe.ts";
import { describeFailedWebhookFilter, findFailedWebhookFilter } from "./webhookFilter.ts";
import { constantTimeEquals, verifyWebhookSignature } from "./webhookVerification.ts";

export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";
const isScheduledTaskError = Schema.is(ScheduledTaskError);
const PROMPT_TOO_LONG = "The filled-in prompt is too long.";
const WEBHOOK_DELIVERY_RETENTION = 50;
const WEBHOOK_DEDUPE_DELIVERY_RETENTION = 20;
const WEBHOOK_FILTERED_DELIVERY_RETENTION = 20;
const WEBHOOK_DEDUPE_LOG_PER_MINUTE = 10;
const WEBHOOK_FILTERED_LOG_PER_MINUTE = 10;
const WEBHOOK_DELIVERY_LOG_BODY_LIMIT = 64 * 1024;
const WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT = 64 * 1024;
const WEBHOOK_MAX_QUEUED_PER_TASK = 20;
// Enforce the relay's per-task/minute limit here too; tunnel hostnames are public.
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;
const LEGACY_DELIVERY_OUTCOMES: ReadonlySet<string> = new Set([
  "accepted",
  "dispatch_failed",
  "rejected_signature",
  "disabled",
  "rate_limited",
  "expired",
]);

interface WebhookOrigin {
  readonly relayHookBaseUrl: string | null;
}

const ENDPOINT_KEY = /^[0-9a-f]{16}$/;

export function relayHookBaseUrl(input: {
  readonly relayUrl: string;
  readonly tunnelName: string | undefined;
}): string | null {
  const endpointKey = input.tunnelName?.split("-").at(-1);
  const relayUrl = input.relayUrl.replace(/\/+$/, "");
  if (relayUrl === "" || endpointKey === undefined || !ENDPOINT_KEY.test(endpointKey)) {
    return null;
  }
  return `${relayUrl}/v1/hooks/${endpointKey}`;
}

export class ScheduledTaskWebhookOrigin extends Context.Reference<Effect.Effect<WebhookOrigin>>(
  "t3/scheduledTasks/ScheduledTaskWebhookOrigin",
  {
    defaultValue: () => Effect.succeed({ relayHookBaseUrl: null }),
  },
) {}

class WebhookDeliverySkipped extends Data.TaggedError("WebhookDeliverySkipped")<{
  readonly reason: string;
}> {}

interface RateWindow {
  readonly accepted: ReadonlyArray<{ readonly at: number }>;
  readonly rejectedLogged: boolean;
}

export interface WebhookTriggerRequest extends WebhookRequest {
  readonly hookId: string;
  readonly token: string;
  readonly body: Uint8Array;
  readonly relayDeliveryId?: string;
  readonly receivedAt?: string;
}

export type WebhookDeliveryOutcome =
  | "accepted"
  | "duplicate"
  | "coalesced"
  | "prompt_too_long"
  | "queue_full"
  | "rate_limited"
  | "disabled"
  | "rejected_signature"
  | "expired"
  | "filtered"
  | "not_found"
  | "error";

export type WebhookTriggerResult =
  | {
      readonly _tag: "accepted";
      readonly deliveryId: ScheduledTaskWebhookDeliveryId;
      readonly outcome: "accepted" | "duplicate" | "coalesced" | "prompt_too_long" | "filtered";
    }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "rejected_signature" }
  | { readonly _tag: "disabled" }
  | {
      readonly _tag: "rate_limited";
      readonly outcome: "rate_limited" | "queue_full";
    }
  | { readonly _tag: "expired" };

const webhookFilters = (filters: ReadonlyArray<ScheduledTaskWebhookFilter> | undefined) =>
  filters?.length ? { filters } : {};

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
const HeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const MissingFieldsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeHeadersJson = Schema.decodeUnknownOption(HeadersJson);
const decodeMissingFieldsJson = Schema.decodeUnknownOption(MissingFieldsJson);
const encodeHeadersJson = Schema.encodeSync(HeadersJson);
const encodeMissingFieldsJson = Schema.encodeSync(MissingFieldsJson);

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
  readonly webhook_token: string | null;
  readonly webhook_secret: string | null;
}

interface WebhookDeliveryRow {
  readonly delivery_id: string;
  readonly task_id: string;
  readonly received_at: string;
  readonly method: string;
  readonly query: string;
  readonly headers_json: string;
  readonly body: string;
  readonly body_bytes: number;
  readonly body_truncated: number;
  readonly outcome: string;
  readonly signature_verified: number;
  readonly missing_fields_json: string;
  readonly rendered_prompt: string | null;
  readonly pending_window: number;
  readonly error: string | null;
}

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    /** Deletes only tasks that still target this thread, including their webhook deliveries. */
    readonly deleteForThread: (threadId: ThreadId) => Effect.Effect<void, ScheduledTaskError>;
    /** Points tasks bound to these threads at the project the threads moved to. */
    readonly moveThreadTasks: (input: {
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly projectId: ProjectId;
    }) => Effect.Effect<void, ScheduledTaskError>;
    /** The dispatched thread, or null if dispatch failed; leaves the task's binding unchanged. */
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<
      ScheduledTaskRunNowResult & { readonly threadId: ThreadId | null },
      ScheduledTaskError
    >;
    readonly rotateWebhookToken: (
      input: ScheduledTaskRotateWebhookTokenInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly listWebhookDeliveries: (
      input: ScheduledTaskListWebhookDeliveriesInput,
    ) => Effect.Effect<ScheduledTaskListWebhookDeliveriesResult, ScheduledTaskError>;
    readonly getWebhookDelivery: (
      input: ScheduledTaskGetWebhookDeliveryInput,
    ) => Effect.Effect<ScheduledTaskGetWebhookDeliveryResult, ScheduledTaskError>;
    /** Verifies, logs and dispatches; returns after logging while the run continues in the background. */
    readonly triggerWebhook: (
      request: WebhookTriggerRequest,
    ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>;
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
  // Decoded intervals can overflow DateTime; unrepresentable occurrences have no next run.
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

function webhookPath(taskId: string, token: string): string {
  return `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(taskId)}/${token}`;
}

function webhookEndpoint(
  row: Pick<ScheduledTaskRow, "task_id" | "webhook_token" | "webhook_secret">,
  origin: WebhookOrigin | null,
): ScheduledTask["webhook"] {
  if (row.webhook_token === null) return undefined;
  const base = origin?.relayHookBaseUrl ?? null;
  return {
    path: webhookPath(row.task_id, row.webhook_token),
    url: base === null ? null : `${base}/${encodeURIComponent(row.task_id)}/${row.webhook_token}`,
    hasSecret: row.webhook_secret !== null,
  };
}

// Runs per task row; list and lookup operations already own the span.
const decodeRow = Effect.fnUntraced(
  function* (row: ScheduledTaskRow, origin: WebhookOrigin | null = null) {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const webhook = schedule.type === "webhook" ? webhookEndpoint(row, origin) : undefined;
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    return yield* decodeTask({
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
      ...(webhook === undefined ? {} : { webhook }),
    });
  },
  (effect, row, _origin?) =>
    effect.pipe(
      Effect.mapError((cause) => {
        const taskId = decodeTaskId(row.task_id);
        return taskError("Could not decode schedule task row.", {
          ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
          cause,
        });
      }),
    ),
);

export const listDueTasks = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScheduledTaskRow>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL
      AND next_run_at <= ${iso(now)} AND last_run_status <> 'running'
    ORDER BY next_run_at ASC, task_id ASC
  `.pipe(NodeSqliteClient.readOnly);
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is freeform; skip unparseable values before they defect the poll.
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
    const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const secretRequests = yield* SecretRequests.SecretRequests;
    const scheduler = yield* Scheduler.Scheduler;
    const readWebhookOrigin = yield* ScheduledTaskWebhookOrigin;
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
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

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
      return yield* Effect.forEach(rows, (row) => decodeRow(row, origin), { concurrency: 1 });
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
      return yield* decodeRow(row, yield* readWebhookOrigin);
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

    const newWebhookToken = crypto.randomBytes(32).pipe(
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
          next_run_at = excluded.next_run_at,
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
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );

    // A failure between markRunning and markCompleted must still write a terminal record:
    // runDueTasks skips 'running' rows forever, and the dispatch may already have gone out,
    // so next_run_at must advance. Pending webhook attempts count only with their completion.
    const releaseStuckRun = Effect.fn("ScheduledTaskService.releaseStuckRun")(
      function* (task: ScheduledTask, message: string, pendingDeliveryId?: string) {
        const now = yield* localNow;
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return;
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed',
              last_run_error = ${message},
              next_run_at = ${nextRunAt(source, now)},
              updated_at = ${iso(now)},
              run_count = run_count + CASE WHEN EXISTS (
                SELECT 1 FROM scheduled_task_webhook_pending
                WHERE delivery_id = ${pendingDeliveryId ?? null} AND state = 'running'
              ) THEN 0 ELSE 1 END
          WHERE task_id = ${task.id} AND last_run_status = 'running'
        `;
        yield* notifyChanged;
      },
      (effect, task, _message, _pendingDeliveryId) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not release stuck schedule task run", {
              taskId: task.id,
              cause,
            }),
          ),
        ),
    );

    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      trigger: "scheduled" | "manual" | "webhook",
      webhook?: {
        readonly deliveryId: string;
        readonly prompt: string;
        readonly dispatched: Ref.Ref<boolean>;
      },
    ) {
      const reserved = yield* Ref.modify(activeRuns, (active) => {
        if (active.has(task.id)) return [false, active] as const;
        const next = new Set(active);
        next.add(task.id);
        return [true, next] as const;
      });
      if (!reserved) {
        if (trigger !== "scheduled") {
          return yield* taskError("Schedule task is already running.", { taskId: task.id });
        }
        return { task, threadId: null };
      }

      return yield* Effect.gen(function* () {
        const startedAt = yield* localNow;
        const startedAtIso = iso(startedAt);

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
          return { task, threadId: null };
        }
        if (
          webhook !== undefined &&
          (yield* sql`SELECT 1 FROM scheduled_task_webhook_pending WHERE delivery_id = ${webhook.deliveryId} AND state = 'completed'`.pipe(
            NodeSqliteClient.readOnly,
          )).length > 0
        )
          return { task: { ...active, lastRunStatus: "succeeded" as const }, threadId: null };
        const parsedNextRunAt =
          active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
        if (
          trigger === "scheduled" &&
          (!active.enabled ||
            Option.isNone(parsedNextRunAt) ||
            DateTime.toEpochMillis(parsedNextRunAt.value) > DateTime.toEpochMillis(startedAt))
        ) {
          return { task: active, threadId: null };
        }
        // Reject queued deliveries after pause, same-id recreation or trigger changes.
        if (webhook !== undefined) {
          const reason =
            active.createdAt !== task.createdAt
              ? "The task was replaced before this delivery ran."
              : active.schedule.type !== "webhook"
                ? "The task's trigger changed before this delivery ran."
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
        // A webhook prompt was rendered from the row when the request arrived.
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
          if (webhook === undefined) yield* completion;
          else
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const pending =
                    yield* sql`SELECT 1 FROM scheduled_task_webhook_pending WHERE delivery_id = ${webhook.deliveryId}`;
                  if (pending.length === 0) yield* completion;
                  else {
                    const counted =
                      yield* sql`UPDATE scheduled_task_webhook_pending SET state = ${runSucceeded ? "completed" : "failed"}
                      WHERE delivery_id = ${webhook.deliveryId} AND state NOT IN ('completed', 'failed') RETURNING delivery_id`;
                    if (counted.length > 0) yield* completion;
                  }
                }),
              )
              .pipe(
                Effect.mapError((cause) =>
                  taskError("Could not record webhook completion.", { taskId: task.id, cause }),
                ),
              );
          yield* notifyChanged;
        }
        return { task: completed, threadId };
      }).pipe(
        Effect.onError((cause) => releaseStuckRun(task, errorMessage(cause), webhook?.deliveryId)),
        Effect.ensuring(
          Ref.update(activeRuns, (active) => {
            const next = new Set(active);
            next.delete(task.id);
            return next;
          }),
        ),
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
                    next_run_at = ${nextRunAt(decoded.success, now)},
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

    const list: ScheduledTaskService["Service"]["list"] = () =>
      listRows().pipe(
        Effect.map((tasks) => ({ tasks })),
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading to buffer concurrent changes.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: ScheduledTaskService["Service"]["upsert"] = Effect.fn(
      "ScheduledTaskService.upsert",
    )(function* (input) {
      const now = yield* localNow;
      const uuid =
        input.commandId === undefined
          ? yield* crypto
              .randomUUIDv4()
              .pipe(
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
      // Keep the existing next_run_at when the schedule itself is untouched:
      // editing a title or prompt must not postpone (or resurrect) a due
      // run — only schedule/enabled changes restart the clock.
      const schedule: ScheduledTask["schedule"] =
        input.schedule.type === "webhook"
          ? {
              type: "webhook",
              signature:
                input.schedule.signature == null
                  ? null
                  : {
                      header: input.schedule.signature.header.toLowerCase(),
                      encoding: input.schedule.signature.encoding,
                      prefix: input.schedule.signature.prefix,
                    },
              maxDeliveryAgeMinutes: input.schedule.maxDeliveryAgeMinutes ?? null,
              ...(input.schedule.dedupe === undefined
                ? existingTask?.schedule.type === "webhook" &&
                  existingTask.schedule.dedupe !== undefined
                  ? { dedupe: existingTask.schedule.dedupe }
                  : {}
                : { dedupe: input.schedule.dedupe }),
              ...webhookFilters(
                // Omitted keeps the stored filters, so a client that predates
                // them can re-save a task without clearing them.
                input.schedule.filters ??
                  (existingTask?.schedule.type === "webhook"
                    ? existingTask.schedule.filters
                    : undefined),
              ),
            }
          : input.schedule;
      const webhook =
        input.schedule.type === "webhook"
          ? yield* Effect.gen(function* () {
              const existing = existingTask === null ? null : yield* findWebhookCredentials(id);
              const token = existing?.token ?? (yield* newWebhookToken);
              const signature = input.schedule.type === "webhook" ? input.schedule.signature : null;
              // A secretRef is a value the user entered for an agent; this
              // save consumes it, so it cannot be used again. A replay of a
              // save that already used it keeps the secret that save stored.
              const replay = input.commandId !== undefined && existing?.secret != null;
              const fromRef =
                signature?.secretRef === undefined
                  ? undefined
                  : yield* secretRequests
                      .consume({ ref: signature.secretRef, projectId: input.projectId })
                      .pipe(
                        Effect.catch((error) =>
                          replay
                            ? Effect.void
                            : Effect.fail(taskError(error.message, { taskId: id })),
                        ),
                      );
              // A ref, when given, is the only source: a plain secret sent
              // alongside it must not replace what a replayed save stored.
              const provided = signature?.secretRef === undefined ? signature?.secret : fromRef;
              const secret = signature == null ? null : (provided ?? existing?.secret ?? null);
              const secretChanged =
                signature == null || provided !== undefined || existing === null;
              if (signature != null && secret === null) {
                return yield* taskError("A webhook signature check needs a signing secret.", {
                  taskId: id,
                });
              }
              return { token, secret, secretChanged };
            })
          : { token: null, secret: null, secretChanged: true };
      const workspaceStrategy: ScheduledTask["workspaceStrategy"] =
        input.workspaceStrategy.type === "worktree" &&
        (yield* managedFolders.isScratchProject(input.projectId))
          ? { type: "root" }
          : input.workspaceStrategy;
      const scheduleUnchanged =
        existingTask !== null &&
        existingTask.enabled === input.enabled &&
        isSameSchedule(existingTask.schedule, schedule);
      const task: ScheduledTask = {
        id,
        title: input.title,
        prompt: input.prompt,
        enabled: input.enabled,
        schedule,
        projectId: input.projectId,
        threadId: input.threadId ?? null,
        workspaceStrategy,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
        creationSource: input.creationSource ?? "web",
        createdAt: existingTask?.createdAt ?? iso(now),
        updatedAt: iso(now),
        nextRunAt: scheduleUnchanged
          ? existingTask.nextRunAt
          : nextRunAt({ enabled: input.enabled, schedule }, now),
        lastRunAt: existingTask?.lastRunAt ?? null,
        lastRunStatus: existingTask?.lastRunStatus ?? "never",
        lastRunError: existingTask?.lastRunError ?? null,
        runCount: existingTask?.runCount ?? 0,
      };
      yield* saveTask(task, input.requireExisting === true, webhook);
      yield* notifyChanged;
      return { task: (yield* findTask(id)) ?? task };
    });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = Effect.fn(
      "ScheduledTaskService.setEnabled",
    )(function* (input) {
      const existing = yield* loadTask(input.id);
      if (existing.enabled === input.enabled) return { task: existing };
      const now = yield* localNow;
      const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
      // RETURNING so a task deleted between the load and this UPDATE is a
      // visible not-found error, not a false success.
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
    });

    const forgetWebhookTask = (id: ScheduledTaskId) =>
      Effect.all(
        [
          Ref.update(webhookRateWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookRejectedRateWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookDedupeLogWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookFilteredLogWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookPermits, (permits) => {
            const next = new Map(permits);
            next.delete(id);
            return next;
          }),
        ],
        { discard: true },
      );

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      deleteRow(input.id).pipe(
        Effect.andThen(forgetWebhookTask(input.id)),
        Effect.andThen(notifyChanged),
        Effect.as({ id: input.id }),
      );

    const deleteForThread = Effect.fn("ScheduledTaskService.deleteForThread")(function* (
      threadId: ThreadId,
    ) {
      // Check the current binding in the transaction: an automation may have
      // been unbound or moved since thread deletion queued this cleanup.
      const removed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
            DELETE FROM scheduled_task_webhook_deliveries
            WHERE task_id IN (SELECT task_id FROM scheduled_tasks WHERE thread_id = ${threadId})
          `;
            return yield* sql<{ task_id: ScheduledTaskId }>`
            DELETE FROM scheduled_tasks WHERE thread_id = ${threadId} RETURNING task_id
          `;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete thread's schedule tasks.", { cause }),
          ),
        );
      yield* Effect.forEach(removed, ({ task_id }) => forgetWebhookTask(task_id), {
        discard: true,
      });
      if (removed.length > 0) yield* notifyChanged;
    });

    const moveThreadTasks: ScheduledTaskService["Service"]["moveThreadTasks"] = Effect.fn(
      "ScheduledTaskService.moveThreadTasks",
    )(function* (input) {
      if (input.threadIds.length === 0) return;
      const moved = yield* sql<{ task_id: ScheduledTaskId }>`
        UPDATE scheduled_tasks SET project_id = ${input.projectId}
        WHERE project_id != ${input.projectId} AND thread_id IN ${sql.in(input.threadIds)}
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not move the thread's schedule tasks.", { cause }),
        ),
      );
      if (moved.length > 0) yield* notifyChanged;
    });

    const runNow: ScheduledTaskService["Service"]["runNow"] = Effect.fn(
      "ScheduledTaskService.runNow",
    )(function* (input: ScheduledTaskRunNowInput) {
      const task = yield* loadTask(input.id);
      if (task.schedule.type === "webhook") {
        return yield* taskError("Webhook tasks run when their URL receives a request.", {
          taskId: input.id,
        });
      }
      return yield* runTask(task, "manual").pipe(
        Effect.mapError((cause) =>
          taskError("Could not run schedule task.", { taskId: input.id, cause }),
        ),
      );
    });

    const rotateWebhookToken: ScheduledTaskService["Service"]["rotateWebhookToken"] = Effect.fn(
      "ScheduledTaskService.rotateWebhookToken",
    )(function* (input) {
      const task = yield* loadTask(input.id);
      if (task.schedule.type !== "webhook") {
        return yield* taskError("Only webhook tasks have a URL token.", { taskId: input.id });
      }
      const token = yield* newWebhookToken;
      const now = yield* localNow;
      // Matching created_at keeps a rotation from landing on a task deleted
      // and recreated under the same id since it was loaded.
      const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET webhook_token = ${token}, updated_at = ${iso(now)}
          WHERE task_id = ${input.id} AND created_at = ${task.createdAt}
          RETURNING task_id
        `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not rotate webhook token.", { taskId: input.id, cause }),
        ),
      );
      if (updated.length === 0) {
        return yield* taskError("Schedule task was deleted or replaced.", { taskId: input.id });
      }
      yield* notifyChanged;
      return { task: yield* loadTask(input.id) };
    });

    const deliveryHeaders = (row: WebhookDeliveryRow): Readonly<Record<string, string>> =>
      Option.getOrElse(decodeHeadersJson(row.headers_json), () => ({}));
    const decodeDeliverySummary = (row: WebhookDeliveryRow) => ({
      id: ScheduledTaskWebhookDeliveryId.make(row.delivery_id),
      taskId: ScheduledTaskId.make(row.task_id),
      receivedAt: row.received_at,
      method: row.method,
      contentType: deliveryHeaders(row)["content-type"] ?? null,
      bodyBytes: row.body_bytes,
      outcome: row.outcome as ScheduledTaskWebhookDeliveryOutcome,
      signatureVerified: row.signature_verified === 1,
      pendingWindow: row.outcome === "accepted" && row.pending_window === 1,
      missingFields: Option.getOrElse(decodeMissingFieldsJson(row.missing_fields_json), () => []),
      error: row.error,
    });

    const listWebhookDeliveries: ScheduledTaskService["Service"]["listWebhookDeliveries"] = (
      input,
    ) =>
      sql<WebhookDeliveryRow>`
        SELECT d.*, EXISTS (SELECT 1 FROM scheduled_task_webhook_pending p
          WHERE p.delivery_id = d.delivery_id AND p.state IN ('pending', 'dispatching')) AS pending_window
        FROM scheduled_task_webhook_deliveries d WHERE task_id = ${input.id}
        ORDER BY received_at DESC, rowid DESC
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => ({
          deliveries: rows
            .filter(
              (row) => input.acceptAnyOutcome === true || LEGACY_DELIVERY_OUTCOMES.has(row.outcome),
            )
            .map(decodeDeliverySummary),
        })),
        Effect.mapError((cause) =>
          taskError("Could not list webhook deliveries.", { taskId: input.id, cause }),
        ),
      );

    const getWebhookDelivery: ScheduledTaskService["Service"]["getWebhookDelivery"] = Effect.fn(
      "ScheduledTaskService.getWebhookDelivery",
    )(function* (input) {
      const rows = yield* sql<WebhookDeliveryRow>`
          SELECT d.*, EXISTS (SELECT 1 FROM scheduled_task_webhook_pending p
            WHERE p.delivery_id = d.delivery_id AND p.state IN ('pending', 'dispatching')) AS pending_window
          FROM scheduled_task_webhook_deliveries d WHERE task_id = ${input.id} AND delivery_id = ${input.deliveryId}
        `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) =>
          taskError("Could not load webhook delivery.", { taskId: input.id, cause }),
        ),
      );
      const row = rows[0];
      if (
        row === undefined ||
        (input.acceptAnyOutcome !== true && !LEGACY_DELIVERY_OUTCOMES.has(row.outcome))
      ) {
        return yield* taskError("Webhook delivery not found.", { taskId: input.id });
      }
      return {
        delivery: {
          ...decodeDeliverySummary(row),
          query: row.query,
          headers: deliveryHeaders(row),
          body: row.body,
          bodyTruncated: row.body_truncated === 1,
          renderedPrompt: row.rendered_prompt,
        },
      };
    });

    const deliveryRequestBody = (request: WebhookTriggerRequest) => {
      const truncated = request.body.byteLength > WEBHOOK_DELIVERY_LOG_BODY_LIMIT;
      return {
        truncated,
        body: truncated
          ? new TextDecoder().decode(request.body.subarray(0, WEBHOOK_DELIVERY_LOG_BODY_LIMIT))
          : request.bodyText,
      };
    };
    const replaceDeliveryRequest = (deliveryId: string, request: WebhookTriggerRequest) => {
      const logged = deliveryRequestBody(request);
      return sql`UPDATE scheduled_task_webhook_deliveries SET
        method = ${request.method}, query = ${redactQuery(request.query)},
        headers_json = ${encodeHeadersJson(redactHeaders(request.headers))}, body = ${logged.body},
        body_bytes = ${request.body.byteLength}, body_truncated = ${logged.truncated ? 1 : 0}
        WHERE delivery_id = ${deliveryId}`.pipe(Effect.asVoid, Effect.mapError(dedupeError));
    };

    const recordDelivery = (input: {
      readonly id: string;
      readonly taskId: ScheduledTaskId;
      readonly receivedAt: string;
      readonly request: WebhookTriggerRequest;
      readonly outcome: ScheduledTaskWebhookDeliveryOutcome;
      readonly signatureVerified: boolean;
      readonly missing: ReadonlyArray<string>;
      readonly renderedPrompt: string | null;
      readonly error?: string;
    }) => {
      const { truncated, body: loggedBody } = deliveryRequestBody(input.request);
      return sql
        .withTransaction(
          Effect.gen(function* () {
            // Require the task to exist so deletes cannot leave deliveries for a recreated task.
            yield* sql`
              INSERT INTO scheduled_task_webhook_deliveries (
                delivery_id, task_id, received_at, method, query, headers_json, body,
                body_bytes, body_truncated, outcome, signature_verified,
                missing_fields_json, rendered_prompt, error
              )
              SELECT
                ${input.id}, ${input.taskId}, ${input.receivedAt}, ${input.request.method},
                ${redactQuery(input.request.query)},
                ${encodeHeadersJson(redactHeaders(input.request.headers))},
                ${loggedBody},
                ${input.request.body.byteLength}, ${truncated ? 1 : 0}, ${input.outcome},
                ${input.signatureVerified ? 1 : 0}, ${encodeMissingFieldsJson(input.missing)},
                ${input.renderedPrompt?.slice(0, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT) ?? null},
                ${input.error ?? null}
              WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${input.taskId})
              -- A held request retried after a rate limit reuses its relay
              -- delivery id; the newer attempt replaces the logged one.
              ON CONFLICT (delivery_id) DO UPDATE SET
                outcome = excluded.outcome,
                signature_verified = excluded.signature_verified,
                missing_fields_json = excluded.missing_fields_json,
                rendered_prompt = excluded.rendered_prompt,
                error = excluded.error
            `;
            // Each suppression bucket retains its own rows, never real run history.
            const bucket = (outcome: string, error: string | undefined) =>
              outcome === "filtered"
                ? "filtered"
                : outcome === "duplicate" ||
                    outcome === "coalesced" ||
                    outcome === "rate_limited" ||
                    error === PROMPT_TOO_LONG
                  ? "dedupe"
                  : "main";
            const retentionBucket = bucket(input.outcome, input.error);
            const rowBucket = sql.literal(`CASE WHEN outcome = 'filtered' THEN 'filtered'
              WHEN outcome IN ('duplicate', 'coalesced', 'rate_limited') OR error = 'The filled-in prompt is too long.' THEN 'dedupe'
              ELSE 'main' END`);
            yield* sql`
            DELETE FROM scheduled_task_webhook_deliveries
            WHERE task_id = ${input.taskId} AND ${rowBucket} = ${retentionBucket}
              AND delivery_id NOT IN (
                SELECT delivery_id FROM scheduled_task_webhook_deliveries
                WHERE task_id = ${input.taskId} AND ${rowBucket} = ${retentionBucket}
                ORDER BY received_at DESC, rowid DESC
                LIMIT ${retentionBucket === "main" ? WEBHOOK_DELIVERY_RETENTION : retentionBucket === "filtered" ? WEBHOOK_FILTERED_DELIVERY_RETENTION : WEBHOOK_DEDUPE_DELIVERY_RETENTION}
              )
          `;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not record webhook delivery.", { taskId: input.taskId, cause }),
          ),
        );
    };

    const markDeliveryFailed = (deliveryId: string, message: string) =>
      sql`
        UPDATE scheduled_task_webhook_deliveries
        SET outcome = 'dispatch_failed', error = ${message}
        WHERE delivery_id = ${deliveryId}
      `.pipe(Effect.ignore);

    /** Sliding one-minute window for deliveries that can start work. */
    const takeRateSlot = (
      id: ScheduledTaskId,
      nowMs: number,
      rateWindows = webhookRateWindows,
      reservation = { at: nowMs },
    ) =>
      Ref.modify(
        rateWindows,
        (
          windows,
        ): readonly [
          "allowed" | "first_rejected" | "rejected",
          ReadonlyMap<ScheduledTaskId, RateWindow>,
        ] => {
          const current = windows.get(id);
          const recent = (current?.accepted ?? []).filter((entry) => nowMs - entry.at < 60_000);
          if (recent.length >= WEBHOOK_RATE_LIMIT_PER_MINUTE) {
            const first = current?.rejectedLogged !== true;
            return [
              first ? "first_rejected" : "rejected",
              new Map(windows).set(id, { accepted: recent, rejectedLogged: true }),
            ];
          }
          return [
            "allowed",
            new Map(windows).set(id, { accepted: [...recent, reservation], rejectedLogged: false }),
          ];
        },
      );

    const takeDedupeLogSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(webhookDedupeLogWindows, (windows) => {
        const recent = (windows.get(id) ?? []).filter((at) => nowMs - at < 60_000);
        return recent.length >= WEBHOOK_DEDUPE_LOG_PER_MINUTE
          ? ([false, windows] as const)
          : ([true, new Map(windows).set(id, [...recent, nowMs])] as const);
      });
    const releaseReplay = (deliveryId: string) =>
      releaseWebhookReplay(deliveryId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(dedupeError),
      );
    /** Sliding one-minute window of filtered requests written to the delivery log. */
    const takeFilteredLogSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(
        webhookFilteredLogWindows,
        (windows): readonly [boolean, ReadonlyMap<ScheduledTaskId, ReadonlyArray<number>>] => {
          const recent = (windows.get(id) ?? []).filter((at) => nowMs - at < 60_000);
          return recent.length >= WEBHOOK_FILTERED_LOG_PER_MINUTE
            ? [false, windows]
            : [true, new Map(windows).set(id, [...recent, nowMs])];
        },
      );

    const webhookPermit = Effect.fn("ScheduledTaskService.webhookPermit")(function* (
      id: ScheduledTaskId,
    ) {
      const existing = (yield* Ref.get(webhookPermits)).get(id);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(webhookPermits, (permits) => {
        const raced = permits.get(id);
        return raced === undefined
          ? [created, new Map(permits).set(id, created)]
          : [raced, permits];
      });
    });

    const serviceScope = yield* Effect.scope;

    const releaseFailedDelivery = Effect.fn("ScheduledTaskService.releaseFailedDelivery")(
      function* (deliveryId: string) {
        yield* releaseReplay(deliveryId);
        yield* sql`DELETE FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id IN (
          SELECT substr(value, ${"delivery:relay:".length + 1}) FROM scheduled_task_webhook_pending, json_each(delivery_ids_json)
          WHERE delivery_id = ${deliveryId} AND value LIKE 'delivery:relay:%'
        )`.pipe(Effect.mapError(dedupeError));
        if (deliveryId.startsWith("delivery:relay:"))
          yield* sql`DELETE FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id = ${deliveryId.slice("delivery:relay:".length)}`.pipe(
            Effect.mapError(dedupeError),
          );
      },
      (effect) => sql.withTransaction(effect).pipe(Effect.mapError(dedupeError)),
    );

    const runWebhookDelivery = Effect.fn("ScheduledTaskService.runWebhookDelivery")(function* (
      task: ScheduledTask,
      deliveryId: string,
      prompt: string,
    ) {
      const runOutcome = (outcome: "started" | "skipped" | "failed") =>
        Effect.all([
          Effect.annotateCurrentSpan({ "scheduled_task.webhook.run_outcome": outcome }),
          Metrics.increment(Metrics.webhookRunsTotal, { outcome }),
        ]);
      const dispatched = yield* Ref.make(false);
      return yield* runTask(task, "webhook", { deliveryId, prompt, dispatched }).pipe(
        Effect.flatMap(({ task: completed }) =>
          completed.lastRunStatus === "failed"
            ? runOutcome("failed").pipe(
                Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                Effect.andThen(releaseFailedDelivery(deliveryId)),
              )
            : runOutcome("started"),
        ),
        Effect.catchTags({
          WebhookDeliverySkipped: (skipped) =>
            runOutcome("skipped").pipe(
              Effect.andThen(markDeliveryFailed(deliveryId, skipped.reason)),
              Effect.andThen(releaseFailedDelivery(deliveryId)),
            ),
        }),
        Effect.as(true),
        // Dispatch success owns the replay key even if later bookkeeping fails.
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const started = yield* Ref.get(dispatched);
            yield* Effect.logWarning("Webhook dispatch failed", { taskId: task.id, cause });
            yield* runOutcome(started ? "started" : "failed");
            yield* markDeliveryFailed(
              deliveryId,
              started
                ? "The run started, but completion could not be recorded."
                : "The run failed to start.",
            );
            if (!started) {
              yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    const counted =
                      yield* sql`UPDATE scheduled_task_webhook_pending SET state = 'failed'
                WHERE delivery_id = ${deliveryId} AND state = 'running' RETURNING delivery_id`;
                    if (counted.length > 0)
                      yield* sql`UPDATE scheduled_tasks SET run_count = run_count + 1
                WHERE task_id = ${task.id} AND created_at = ${task.createdAt}`;
                  }),
                )
                .pipe(Effect.mapError(dedupeError));
              yield* releaseFailedDelivery(deliveryId);
            }
            // Pending windows retry the same command id to finish bookkeeping.
            return !started;
          }),
        ),
      );
    });

    // Delivery attributes belong to the enclosing triggerWebhook span.
    const observeDelivery = Effect.fnUntraced(function* (
      request: WebhookTriggerRequest,
      outcome: WebhookDeliveryOutcome,
      receivedAt: DateTime.DateTime | undefined,
      now: DateTime.DateTime | undefined,
    ) {
      const source = request.relayDeliveryId === undefined ? "direct" : "relay";
      yield* Effect.annotateCurrentSpan({
        "scheduled_task.webhook.outcome": outcome,
        "scheduled_task.webhook.source": source,
      });
      yield* Metrics.increment(Metrics.webhookDeliveriesTotal, { outcome, source });
      if (request.receivedAt !== undefined && receivedAt !== undefined && now !== undefined) {
        const heldMs = Math.max(
          0,
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt),
        );
        yield* Effect.annotateCurrentSpan({ "scheduled_task.webhook.held_ms": heldMs });
        yield* Metric.update(Metrics.webhookHeldDelay, Duration.millis(heldMs));
      }
    });

    const triggerWebhook: ScheduledTaskService["Service"]["triggerWebhook"] = (request) =>
      triggerWebhookUnobserved(request).pipe(
        Effect.tapError(() => observeDelivery(request, "error", undefined, undefined)),
        Metrics.withMetrics({ timer: Metrics.webhookDeliveryDuration }),
        Effect.withSpan("ScheduledTaskService.triggerWebhook", {
          attributes: {
            "scheduled_task.webhook.method": request.method,
            "scheduled_task.webhook.body_bytes": request.body.byteLength,
            "scheduled_task.webhook.source":
              request.relayDeliveryId === undefined ? "direct" : "relay",
          },
        }),
      );

    // triggerWebhook owns the operation span and its task-id annotation.
    const triggerWebhookUnobserved = Effect.fnUntraced(function* (request: WebhookTriggerRequest) {
      const taskId = decodeTaskId(request.hookId);
      const notFound = observeDelivery(request, "not_found", undefined, undefined).pipe(
        Effect.as({ _tag: "not_found" as const }),
      );
      if (Option.isNone(taskId)) return yield* notFound;
      const rows = yield* getRows(taskId.value).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: taskId.value, cause }),
        ),
      );
      const row = rows[0];
      // A wrong token is indistinguishable from an unknown hook, so the URL
      // does not reveal which hooks exist.
      if (
        row === undefined ||
        row.webhook_token === null ||
        !constantTimeEquals(request.token, row.webhook_token)
      ) {
        return yield* notFound;
      }
      const task = yield* decodeRow(row);
      yield* Effect.annotateCurrentSpan({ "scheduled_task.id": task.id });
      const schedule = task.schedule;
      if (schedule.type !== "webhook") return yield* notFound;

      const now = yield* localNow;
      // Anyone can reach the tunnel directly and set the relay's header, so
      // a receive time is never later than now: a future one would pin the
      // delivery in the log and slip past the task's max age.
      const receivedAt =
        request.receivedAt === undefined
          ? now
          : DateTime.min(
              Option.getOrElse(DateTime.make(request.receivedAt), () => now),
              now,
            );
      const observe = (outcome: WebhookDeliveryOutcome) =>
        observeDelivery(request, outcome, receivedAt, now);
      const deliveryId = ScheduledTaskWebhookDeliveryId.make(
        request.relayDeliveryId === undefined
          ? `delivery:${yield* crypto
              .randomUUIDv4()
              .pipe(
                Effect.mapError((cause) => taskError("Could not generate delivery id.", { cause })),
              )}`
          : `delivery:relay:${request.relayDeliveryId}`,
      );
      // Claimed in its own table, kept longer than the relay holds a request,
      // because the delivery log is trimmed. A rate-limited delivery stays
      // held on the relay, so it must give up its claim or the next pass
      // would treat it as already delivered.
      let claimAcquired = false;
      const releaseClaim = <A>(result: A) =>
        !claimAcquired || request.relayDeliveryId === undefined
          ? Effect.succeed(result)
          : sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE relay_delivery_id = ${request.relayDeliveryId}
              `.pipe(Effect.ignore, Effect.as(result));
      // From the claim until the run is forked nothing may interrupt: a
      // request dropped in between (the relay hangs up after its timeout)
      // would leave a claimed delivery that never runs, or a queue slot that
      // is never released.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (request.relayDeliveryId !== undefined) {
            const claimed = yield* sql<{ relay_delivery_id: string }>`
                INSERT INTO scheduled_task_webhook_relay_deliveries
                  (relay_delivery_id, task_id, seen_at)
                VALUES (${request.relayDeliveryId}, ${task.id}, ${iso(now)})
                ON CONFLICT (relay_delivery_id) DO NOTHING
                RETURNING relay_delivery_id
              `.pipe(
              Effect.mapError((cause) =>
                taskError("Could not record webhook delivery.", { taskId: task.id, cause }),
              ),
            );
            if (claimed.length === 0) {
              yield* observe("duplicate");
              return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
            }
            claimAcquired = true;
            yield* sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE seen_at < ${iso(DateTime.subtract(now, { hours: 48 }))}
              `.pipe(Effect.ignore);
          }
          const log = (
            outcome: ScheduledTaskWebhookDeliveryOutcome,
            details: {
              readonly signatureVerified?: boolean;
              readonly missing?: ReadonlyArray<string>;
              readonly renderedPrompt?: string;
              readonly error?: string;
            } = {},
          ) =>
            recordDelivery({
              id: deliveryId,
              taskId: task.id,
              receivedAt: iso(receivedAt),
              request,
              outcome,
              signatureVerified: details.signatureVerified ?? false,
              missing: details.missing ?? [],
              renderedPrompt: details.renderedPrompt ?? null,
              ...(details.error === undefined ? {} : { error: details.error }),
            });

          // Reject floods before signature work or rejection-log writes; valid
          // deliveries give this reservation back once validation succeeds.
          const rejectionReservation = { at: DateTime.toEpochMillis(now) };
          const rejectionSlot = yield* takeRateSlot(
            task.id,
            DateTime.toEpochMillis(now),
            webhookRejectedRateWindows,
            rejectionReservation,
          );
          if (rejectionSlot !== "allowed") {
            if (rejectionSlot === "first_rejected") yield* log("rate_limited");
            yield* observe("rate_limited");
            return yield* releaseClaim({ _tag: "rate_limited", outcome: "rate_limited" } as const);
          }
          if (!task.enabled) {
            yield* log("disabled");
            yield* observe("disabled");
            return { _tag: "disabled" as const };
          }
          const signature = schedule.signature;
          if (signature !== null) {
            const verified =
              row.webhook_secret !== null &&
              verifyWebhookSignature({
                signature,
                secret: row.webhook_secret,
                headers: request.headers,
                body: request.body,
              });
            if (!verified) {
              yield* log("rejected_signature");
              yield* observe("rejected_signature");
              return { _tag: "rejected_signature" as const };
            }
          }
          const maxAgeMinutes = schedule.maxDeliveryAgeMinutes ?? null;
          if (
            maxAgeMinutes !== null &&
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt) >
              maxAgeMinutes * 60_000
          ) {
            yield* log("expired", { signatureVerified: signature !== null });
            yield* observe("expired");
            return { _tag: "expired" as const };
          }

          const refundRejectionSlot = Ref.update(webhookRejectedRateWindows, (windows) => {
            const current = windows.get(task.id);
            if (current === undefined) return windows;
            return new Map(windows).set(task.id, {
              ...current,
              accepted: current.accepted.filter((entry) => entry !== rejectionReservation),
            });
          });

          const failedFilter = findFailedWebhookFilter(schedule.filters ?? [], request);
          if (failedFilter !== null) {
            if (yield* takeFilteredLogSlot(task.id, DateTime.toEpochMillis(now))) {
              yield* log("filtered", {
                signatureVerified: signature !== null,
                error: describeFailedWebhookFilter(failedFilter),
              });
            }
            yield* refundRejectionSlot;
            yield* observe("filtered");
            return yield* releaseClaim({
              _tag: "accepted" as const,
              deliveryId,
              outcome: "filtered" as const,
            });
          }

          const runWindow = (yield* Ref.get(webhookRateWindows)).get(task.id);
          if (
            schedule.dedupe === undefined &&
            (runWindow?.accepted.filter((entry) => DateTime.toEpochMillis(now) - entry.at < 60_000)
              .length ?? 0) >= WEBHOOK_RATE_LIMIT_PER_MINUTE
          ) {
            if ((yield* takeRateSlot(task.id, DateTime.toEpochMillis(now))) === "first_rejected")
              yield* log("rate_limited");
            yield* observe("rate_limited");
            return yield* releaseClaim({ _tag: "rate_limited", outcome: "rate_limited" } as const);
          }
          const reserve = takeRateSlot(task.id, DateTime.toEpochMillis(now)).pipe(
            Effect.flatMap((slot) => (slot === "allowed" ? Effect.void : Effect.fail(slot))),
          );
          const queueKey = `${task.id}\u0000${task.createdAt}`;
          const checkCapacity = Effect.gen(function* () {
            const [row] = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM scheduled_task_webhook_pending
              WHERE task_id = ${task.id} AND state IN ('pending', 'dispatching', 'running')`;
            if (
              (row?.count ?? 0) + ((yield* Ref.get(webhookQueued)).get(queueKey) ?? 0) >=
              WEBHOOK_MAX_QUEUED_PER_TASK
            )
              return yield* Effect.fail("queue_full" as const);
          }).pipe(
            Effect.mapError((cause) => (cause === "queue_full" ? cause : dedupeError(cause))),
          );
          const admit = <A, E>(effect: Effect.Effect<A, E>) =>
            sql.withTransaction(effect).pipe(
              Effect.catch((cause) =>
                cause === "first_rejected" || cause === "rejected" || cause === "queue_full"
                  ? Effect.succeed({
                      outcome:
                        cause === "queue_full"
                          ? ("queue_full" as const)
                          : ("rate_limited" as const),
                      log: cause === "first_rejected",
                    })
                  : Effect.fail(isScheduledTaskError(cause) ? cause : dedupeError(cause)),
              ),
            );
          const deduped =
            schedule.dedupe === undefined
              ? "run"
              : yield* admit(
                  Effect.gen(function* () {
                    const outcome = yield* acceptWebhookDedupe(
                      task,
                      request,
                      deliveryId,
                      DateTime.toEpochMillis(now),
                      reserve,
                      takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now)),
                      checkCapacity,
                      (ownerId) => replaceDeliveryRequest(ownerId, request),
                    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
                    if (
                      outcome === "pending" ||
                      outcome === "coalesced" ||
                      (outcome === "duplicate" &&
                        (yield* takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now))))
                    )
                      yield* log(outcome === "pending" ? "accepted" : outcome, {
                        signatureVerified: signature !== null,
                      });
                    return outcome;
                  }),
                );
          if (typeof deduped !== "string") {
            yield* refundRejectionSlot;
            if (deduped.log) yield* log("rate_limited");
            yield* observe(deduped.outcome);
            return yield* releaseClaim({ _tag: "rate_limited", outcome: deduped.outcome } as const);
          }
          if (deduped !== "run") {
            if (deduped !== "coalesced" && deduped !== "coalesced_unlogged")
              yield* refundRejectionSlot;
            const outcome =
              deduped === "pending"
                ? "accepted"
                : deduped === "coalesced_unlogged"
                  ? "coalesced"
                  : deduped;
            yield* observe(outcome);
            if (deduped === "duplicate")
              return yield* releaseClaim({ _tag: "accepted", deliveryId, outcome } as const);
            claimAcquired = false;
            return { _tag: "accepted", deliveryId, outcome } as const;
          }
          const frameId = yield* crypto.randomBytes(6).pipe(
            Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
            Effect.mapError((cause) => taskError("Could not generate frame id.", { cause })),
          );
          const rendered = renderWebhookPrompt(task.prompt, request, frameId);
          // Providers trim the prompt before checking, so whitespace around
          // it is free.
          if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
            yield* log("dispatch_failed", {
              signatureVerified: signature !== null,
              missing: rendered.missing,
              renderedPrompt: rendered.prompt,
              error: PROMPT_TOO_LONG,
            });
            yield* releaseReplay(deliveryId);
            yield* observe("prompt_too_long");
            return yield* releaseClaim({
              _tag: "accepted" as const,
              deliveryId,
              outcome: "prompt_too_long" as const,
            });
          }
          // Bound the deliveries one task holds, so steady traffic to a stuck
          // task cannot pile up parked fibers.
          yield* refundRejectionSlot;
          let queueReserved = false;
          const release = Effect.suspend(() => {
            if (!queueReserved) return Effect.void;
            queueReserved = false;
            return Ref.update(webhookQueued, (counts) => {
              const next = new Map(counts);
              const count = (next.get(queueKey) ?? 1) - 1;
              if (count <= 0) next.delete(queueKey);
              else next.set(queueKey, count);
              return next;
            });
          });
          // Serialize immediate reservations with persisted window admission.
          const reserveImmediate = Effect.gen(function* () {
            yield* checkCapacity;
            yield* reserve;
            yield* Ref.update(webhookQueued, (counts) =>
              new Map(counts).set(queueKey, (counts.get(queueKey) ?? 0) + 1),
            );
            queueReserved = true;
          });
          const admitted = yield* admit(
            Effect.gen(function* () {
              const outcome = yield* acceptImmediateWebhookDedupe(
                task,
                request,
                deliveryId,
                DateTime.toEpochMillis(now),
                reserveImmediate,
              ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
              if (outcome === "duplicate") {
                if (yield* takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now)))
                  yield* log("duplicate", { signatureVerified: signature !== null });
              } else
                yield* log("accepted", {
                  signatureVerified: signature !== null,
                  missing: rendered.missing,
                  renderedPrompt: rendered.prompt,
                });
              return outcome;
            }),
          ).pipe(Effect.onError(() => release));
          if (typeof admitted !== "string") {
            yield* release;
            if (admitted.log) yield* log("rate_limited");
            yield* observe(admitted.outcome);
            return yield* releaseClaim({
              _tag: "rate_limited",
              outcome: admitted.outcome,
            } as const);
          }
          if (admitted === "duplicate") {
            yield* release;
            yield* observe("duplicate");
            return yield* releaseClaim({
              _tag: "accepted",
              deliveryId,
              outcome: "duplicate",
            } as const);
          }
          yield* observe("accepted");
          const permit = yield* webhookPermit(task.id);
          yield* runWebhookDelivery(task, deliveryId, rendered.prompt).pipe(
            permit.withPermits(1),
            Effect.ensuring(release),
            Effect.forkIn(serviceScope),
          );
          // Dispatch owns the accepted delivery now; retries must keep its claim.
          claimAcquired = false;
          return { _tag: "accepted" as const, deliveryId, outcome: "accepted" as const };
        }).pipe(
          Effect.onError(() =>
            Effect.all([
              releaseClaim(undefined),
              (request.relayDeliveryId === undefined || claimAcquired
                ? releaseReplay(deliveryId)
                : Effect.void
              ).pipe(Effect.ignore),
            ]),
          ),
        ),
      );
    });

    const dispatchPending = Effect.fn("ScheduledTaskService.dispatchPendingWebhooks")(function* () {
      const now = DateTime.toEpochMillis(yield* localNow);
      yield* sql`UPDATE scheduled_task_webhook_pending SET state = 'dispatching' WHERE state = 'pending' AND due_at <= ${now}`;
      const tasks = yield* sql<{ task_id: ScheduledTaskId }>`
        SELECT DISTINCT task_id FROM scheduled_task_webhook_pending WHERE state IN ('dispatching', 'running', 'completed', 'failed')
      `.pipe(NodeSqliteClient.readOnly);
      yield* Effect.forEach(
        tasks,
        ({ task_id: taskId }) =>
          Effect.gen(function* () {
            const reserved = yield* Ref.modify(pendingInFlight, (active) =>
              active.has(taskId)
                ? ([false, active] as const)
                : ([true, new Set(active).add(taskId)] as const),
            );
            if (!reserved) return;
            const permit = yield* webhookPermit(taskId);
            // One worker per task waits on its permit, then drains persisted rows in order.
            // Other tasks remain independent and ticks never reload an active task's payloads.
            const dispatch = Effect.gen(function* () {
              while (true) {
                const [entry] = yield* sql<{
                  delivery_id: string;
                  task_json: string;
                  request_json: string;
                  state: string;
                }>`
              SELECT delivery_id, task_json, request_json, state FROM scheduled_task_webhook_pending
              WHERE task_id = ${taskId} AND state IN ('dispatching', 'running', 'completed', 'failed') ORDER BY due_at, rowid LIMIT 1
            `.pipe(NodeSqliteClient.readOnly);
                if (entry === undefined) return;
                const remove = sql`DELETE FROM scheduled_task_webhook_pending WHERE delivery_id = ${entry.delivery_id}`;
                if (entry.state === "completed" || entry.state === "failed") {
                  if (entry.state === "failed") {
                    yield* markDeliveryFailed(entry.delivery_id, "The run failed to start.");
                    yield* releaseFailedDelivery(entry.delivery_id);
                  }
                  yield* remove;
                  continue;
                }
                const prepared = yield* Effect.gen(function* () {
                  const task = yield* decodePendingTask(entry.task_json);
                  const request = yield* decodePendingRequest(entry.request_json);
                  const frameId = Buffer.from(yield* crypto.randomBytes(6)).toString("hex");
                  return { task, rendered: renderWebhookPrompt(task.prompt, request, frameId) };
                }).pipe(Effect.exit);
                if (Exit.isFailure(prepared)) {
                  if (Cause.hasInterruptsOnly(prepared.cause))
                    return yield* Effect.failCause(prepared.cause);
                  yield* markDeliveryFailed(
                    entry.delivery_id,
                    "The pending webhook payload could not be prepared.",
                  );
                  yield* releaseFailedDelivery(entry.delivery_id);
                  yield* remove;
                  continue;
                }
                const { task, rendered } = prepared.value;
                if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
                  yield* markDeliveryFailed(entry.delivery_id, PROMPT_TOO_LONG);
                  yield* releaseFailedDelivery(entry.delivery_id);
                } else {
                  yield* sql`UPDATE scheduled_task_webhook_deliveries SET outcome = 'accepted', error = NULL, rendered_prompt = ${rendered.prompt.slice(0, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT)}, missing_fields_json = ${encodeMissingFieldsJson(rendered.missing)} WHERE delivery_id = ${entry.delivery_id}`;
                  if (!(yield* runWebhookDelivery(task, entry.delivery_id, rendered.prompt)))
                    return;
                }
                yield* remove;
              }
            });
            yield* dispatch.pipe(
              permit.withPermits(1),
              Effect.catch((cause) =>
                Effect.logWarning("Pending webhook dispatch failed", { cause }),
              ),
              Effect.ensuring(
                Ref.update(pendingInFlight, (active) => {
                  const next = new Set(active);
                  next.delete(taskId);
                  return next;
                }),
              ),
              Effect.withSpan("ScheduledTaskService.dispatchPendingWebhook", { root: true }),
              Effect.forkIn(serviceScope),
            );
          }),
        { discard: true },
      );
    });
    yield* scheduler.register("webhook-coalescing", dispatchPending());

    return ScheduledTaskService.of({
      list,
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      deleteForThread,
      moveThreadTasks,
      runNow,
      rotateWebhookToken,
      listWebhookDeliveries,
      getWebhookDelivery,
      triggerWebhook,
    });
  }),
);
