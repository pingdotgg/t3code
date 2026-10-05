import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
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
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Metric from "effect/Metric";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
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
import { constantTimeEquals, verifyWebhookSignature } from "./webhookVerification.ts";

/** Path prefix of the environment route that receives webhook requests. */
export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";
/** Deliveries kept per task; older ones are pruned on insert. */
const WEBHOOK_DELIVERY_RETENTION = 50;
/** Body text kept in the delivery log. Larger bodies are cut and flagged. */
const WEBHOOK_DELIVERY_LOG_BODY_LIMIT = 64 * 1024;
/** Rendered prompt text kept in the delivery log. */
const WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT = 64 * 1024;
/** Deliveries one task may hold at once, running or waiting their turn. */
const WEBHOOK_MAX_QUEUED_PER_TASK = 20;
/** Accepted deliveries per task per minute, enforced here as well as on the relay because the tunnel hostname is public too. */
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;

/**
 * Where a webhook task's public URL points: `${relayHookBaseUrl}/${taskId}/${token}`.
 * Null when the environment has no managed tunnel on T3 Connect; clients then show the path.
 */
interface WebhookOrigin {
  readonly relayHookBaseUrl: string | null;
}

const ENDPOINT_KEY = /^[0-9a-f]{16}$/;

/**
 * The relay's hook URL prefix for this environment. The relay finds the
 * environment by its managed tunnel's key (the tunnel name's last segment),
 * so the URL never reveals the environment id.
 */
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

/** A queued webhook delivery that no longer applies to its task; `reason` is shown in the delivery log. */
class WebhookDeliverySkipped extends Data.TaggedError("WebhookDeliverySkipped")<{
  readonly reason: string;
}> {}

interface RateWindow {
  readonly accepted: ReadonlyArray<number>;
  /** Whether a rejection was already logged in this window. */
  readonly rejectedLogged: boolean;
}

export interface WebhookTriggerRequest extends WebhookRequest {
  readonly hookId: string;
  readonly token: string;
  readonly body: Uint8Array;
  /** Set by T3 Connect; the same id is never dispatched twice. */
  readonly relayDeliveryId?: string;
  /** When the relay received a held request; defaults to now. */
  readonly receivedAt?: string;
}

/** What the HTTP route should answer. `not_found` covers unknown hooks and wrong tokens alike. */
/**
 * What happened to one webhook request, as recorded in metrics and spans.
 * Sent back to the relay as `x-t3-hook-outcome`; never request contents.
 */
export type WebhookDeliveryOutcome =
  | "accepted"
  | "duplicate"
  | "prompt_too_long"
  | "queue_full"
  | "rate_limited"
  | "disabled"
  | "rejected_signature"
  | "expired"
  | "not_found"
  | "error";

export type WebhookTriggerResult =
  | {
      readonly _tag: "accepted";
      readonly deliveryId: ScheduledTaskWebhookDeliveryId;
      /** A 202 covers more than a started run; this says which. */
      readonly outcome: "accepted" | "duplicate" | "prompt_too_long";
    }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "rejected_signature" }
  | { readonly _tag: "disabled" }
  | {
      readonly _tag: "rate_limited";
      /** Too many requests to this hook, or too many runs already waiting. */
      readonly outcome: "rate_limited" | "queue_full";
    }
  | { readonly _tag: "expired" };

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
  readonly enabled_seq: number | null;
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
  readonly error: string | null;
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
     * A `threadId`/`nextProjectId` patch is a typed conflict when the merged
     * pair would bind the task to a thread outside its project (the dispatch
     * check in `getProjectThread` would reject it).
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
    /** Issues a new URL token for a webhook task; the old URL stops working at once. */
    readonly rotateWebhookToken: (
      input: ScheduledTaskRotateWebhookTokenInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly listWebhookDeliveries: (
      input: ScheduledTaskListWebhookDeliveriesInput,
    ) => Effect.Effect<ScheduledTaskListWebhookDeliveriesResult, ScheduledTaskError>;
    readonly getWebhookDelivery: (
      input: ScheduledTaskGetWebhookDeliveryInput,
    ) => Effect.Effect<ScheduledTaskGetWebhookDeliveryResult, ScheduledTaskError>;
    /**
     * Verifies, logs and dispatches one webhook request. Returns as soon as the
     * delivery is logged; the run itself continues in the background so senders
     * with short timeouts get their answer immediately.
     */
    readonly triggerWebhook: (
      request: WebhookTriggerRequest,
    ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>;
    /**
     * Pause every enabled task bound to `threadId` (sets `enabled = 0` and
     * clears `next_run_at`). Called when the thread is archived or deleted —
     * a bound dispatch can only fail from then on, so leaving the task
     * enabled would loop a guaranteed failure on every fire. Re-enabling is
     * an explicit caller action once the thread accepts runs again.
     */
    readonly pauseForThread: (threadId: ThreadId) => Effect.Effect<void, ScheduledTaskError>;
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

// Write transactions take the lock up front and wait up to busy_timeout, so
// contention only surfaces when another process holds the lock longer than
// that. Bun reports `code`/`errno`, and the node:sqlite client copies
// `errcode` into `errno`, so both normally arrive as a retryable
// LockTimeoutError. Accept that classification, and as a fallback a raw
// native code in the SQLITE_BUSY (5) / SQLITE_LOCKED (6) families on any of
// the field names a driver might use without that normalization. The ScheduledTaskError unwrap covers statements
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

// Retry a write that timed out waiting for another process's lock, so a
// lock held a little past busy_timeout does not drop an edit or strand a run
// as 'running'.
const retryContended = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ times: 2, while: isContendedWriteError }));

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

const decodeRow = (row: ScheduledTaskRow, origin: WebhookOrigin | null = null) =>
  Effect.gen(function* () {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const webhook = schedule.type === "webhook" ? webhookEndpoint(row, origin) : undefined;
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
      ...(webhook === undefined ? {} : { webhook }),
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
    const secretRequests = yield* SecretRequests.SecretRequests;
    const scheduler = yield* Scheduler.Scheduler;
    const readWebhookOrigin = yield* ScheduledTaskWebhookOrigin;
    // Webhook deliveries for one task dispatch in arrival order rather than
    // being dropped while an earlier delivery is still dispatching.
    const webhookPermits = yield* Ref.make<ReadonlyMap<ScheduledTaskId, Semaphore.Semaphore>>(
      new Map(),
    );
    // Keyed by task id and creation time, so deliveries of a deleted task that
    // finish late release their own count, never a recreated task's.
    const webhookQueued = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const webhookRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(new Map());
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
        enabled_seq,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count,
        webhook_token,
        webhook_secret
      FROM scheduled_tasks
      ORDER BY updated_at DESC, task_id ASC
    `;

    // Strict decode for the API surface: a corrupt row is a visible error.
    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* () {
      const rows = yield* selectAllRows();
      const origin = yield* readWebhookOrigin;
      return yield* Effect.forEach(rows, (row) => decodeRow(row, origin), { concurrency: 1 });
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
        enabled_seq,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count,
        webhook_token,
        webhook_secret
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
          enabled_seq,
          next_run_at,
          last_run_at,
          last_run_status,
          last_run_error,
          run_count,
          webhook_token,
          webhook_secret
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

    // Stored webhook schedules keep only the read-model fields: the signing
    // secret lives in its own column and the header matches case-insensitively.
    const normalizeSchedule = (
      schedule: ScheduledTaskUpsertInput["schedule"],
    ): ScheduledTask["schedule"] =>
      schedule.type === "webhook"
        ? {
            type: "webhook",
            signature:
              schedule.signature == null
                ? null
                : {
                    header: schedule.signature.header.toLowerCase(),
                    encoding: schedule.signature.encoding,
                    prefix: schedule.signature.prefix,
                  },
            maxDeliveryAgeMinutes: schedule.maxDeliveryAgeMinutes ?? null,
          }
        : schedule;

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

    // The same projection row, including archive state. Every thread-liveness
    // decision this service makes inside a transaction goes through this
    // read — getThreadShell opens its own transaction, which must not nest
    // inside the scheduled_tasks writes.
    const boundThreadRow = Effect.fn("ScheduledTaskService.boundThreadRow")(function* (
      threadId: ThreadId,
    ) {
      const rows = yield* sql<{
        project_id: string;
        archived_at: string | null;
        deleted_at: string | null;
      }>`
        SELECT project_id, archived_at, deleted_at
        FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not read the schedule task's bound thread.", { cause }),
        ),
      );
      return rows[0];
    });

    // An enabled task must never be bound to a thread that cannot accept a
    // dispatch: archived, missing, deleted, or owned by another project.
    // Disabled tasks skip this check so a paused task bound to an archived
    // thread stays editable; the binding re-validates on enable.
    const boundThreadBlocksDispatch = Effect.fn("ScheduledTaskService.boundThreadBlocksDispatch")(
      function* (input: {
        readonly projectId: ScheduledTask["projectId"];
        readonly threadId: ThreadId;
        readonly taskId?: ScheduledTaskId;
      }) {
        const row = yield* boundThreadRow(input.threadId);
        if (row === undefined || row.deleted_at !== null || row.project_id !== input.projectId) {
          return "missing" as const;
        }
        return row.archived_at !== null ? ("archived" as const) : null;
      },
    );

    const ensureBindableTarget = Effect.fn("ScheduledTaskService.ensureBindableTarget")(
      function* (input: {
        readonly projectId: ScheduledTask["projectId"];
        readonly threadId: ThreadId;
        readonly taskId?: ScheduledTaskId;
      }) {
        const options = input.taskId === undefined ? undefined : { taskId: input.taskId };
        const blocked = yield* boundThreadBlocksDispatch(input);
        if (blocked === "missing") {
          return yield* taskError(
            `Schedule task cannot bind to thread ${input.threadId}: the thread does not exist in this project.`,
            options,
          );
        }
        if (blocked === "archived") {
          return yield* taskError(
            `Schedule task cannot dispatch to archived thread ${input.threadId}. Unarchive the thread or unbind the task first.`,
            options,
          );
        }
      },
    );

    // The archive/delete counterpart: a bound thread that stops accepting
    // runs must pause its tasks. Called by the domain-event reactor and the
    // startup sweep below, and re-asserted at fire time inside runTask. The
    // shell re-check shares the write transaction: a queued archive event can
    // arrive after the thread was already unarchived. Unarchive alone must
    // never resume a schedule, so even then a task whose current enabled
    // binding committed before the latest archive event is paused — only an
    // enable that committed after it (the explicit post-unarchive re-enable)
    // is spared. Ordering uses the event log's commit sequence, not wall
    // clocks: an event's occurred_at is assigned at decide time and can
    // precede a racing enable's commit, and run-state writes must never move
    // the marker. enabled_seq is the sequence high-water captured inside the
    // enabling transaction; an enable that could see the archive commit also
    // saw the archived shell and was rejected, so enabled_seq > the archive
    // sequence means the enable committed post-unarchive.
    const pauseTasksBoundTo = Effect.fn("ScheduledTaskService.pauseTasksBoundTo")(function* (
      threadId: ThreadId,
    ) {
      const now = yield* localNow;
      const paused = yield* retryContended(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const row = yield* boundThreadRow(threadId);
              if (row !== undefined && row.deleted_at === null && row.archived_at === null) {
                // The subquery is NULL when the thread has no committed archive
                // event at all, so a healthy enabled task — including a legacy
                // row whose enabled_seq is NULL — is never paused by a no-op
                // call on a never-archived thread.
                return yield* sql<{ task_id: string }>`
                  UPDATE scheduled_tasks
                  SET enabled = 0, enabled_seq = NULL,
                      next_run_at = NULL, updated_at = ${iso(now)}
                  WHERE thread_id = ${threadId} AND enabled = 1
                    AND ${staleArchiveCommitted(threadId)}
                  RETURNING task_id
                `;
              }
              return yield* sql<{ task_id: string }>`
                UPDATE scheduled_tasks
                SET enabled = 0, enabled_seq = NULL,
                    next_run_at = NULL, updated_at = ${iso(now)}
                WHERE thread_id = ${threadId} AND enabled = 1
                RETURNING task_id
              `;
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isScheduledTaskError(cause)
                ? cause
                : taskError("Could not pause schedule tasks bound to the thread.", { cause }),
            ),
          ),
      );
      if (paused.length === 0) return;
      yield* Effect.logInfo("Paused schedule tasks bound to a thread that no longer accepts runs", {
        threadId,
        taskIds: paused.map((row) => row.task_id),
      });
      yield* notifyChanged;
    });

    // "A committed archive postdates this task's enablement." Used by the
    // pause and by the fire-time claim so an archive+unarchive pair still
    // queued for the reactor pauses the task rather than dispatching a run
    // the explicit re-enable was never given. The subquery is NULL for a
    // never-archived thread, which never satisfies the predicate.
    // The event row alone is not durable evidence: compaction retains only
    // the newest state event per thread, so an archive followed by any later
    // state event (unarchive, pin, visit) is deleted. Command receipts are
    // never compacted for non-legacy commands — an accepted thread.archive
    // receipt's result_sequence is the archived event's sequence — so the
    // watermark unions both sources. Pin the partial archive index so the
    // event lookup never walks the thread's unrelated event history.
    const staleArchiveCommitted = (threadId: ThreadId) => sql`
      (
        SELECT MAX(sequence) FROM (
          SELECT MAX(sequence) AS sequence FROM orchestration_events
            INDEXED BY orchestration_events_v2_archived_threads_idx
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND event_type = 'thread.archived'
            AND application_event_version = 2
          UNION ALL
          SELECT MAX(result_sequence) AS sequence FROM orchestration_command_receipts
          WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
            AND command_type = 'thread.archive'
            AND status = 'accepted'
            AND result_sequence > 0
        )
      ) >= COALESCE(enabled_seq, -1)
    `;

    // The sequence watermark for enabled_seq: the latest committed
    // orchestration event at the moment this enabled binding commits. Read
    // inside the write transaction so it orders correctly against a racing
    // archive commit.
    const latestEventSeq = Effect.map(
      sql<{ max: number }>`
        SELECT COALESCE(MAX(sequence), 0) AS max FROM orchestration_events
      `,
      (rows) => rows[0]?.max ?? 0,
    );

    // "A committed archive on the task's bound thread postdates its stored
    // enablement." When this holds, an explicit enable affirmation is a
    // resume — the row stayed enabled only because the archive's pause is
    // still queued — so the caller paths below restart next_run_at from
    // now instead of keeping the overdue due time the voided enablement
    // left behind.
    const enablementInvalidatedByArchive = (input: {
      readonly id: ScheduledTaskId;
      readonly threadId: ThreadId | null;
    }) =>
      input.threadId === null
        ? Effect.succeed(false)
        : Effect.map(
            sql`
              SELECT 1 AS stale FROM scheduled_tasks
              WHERE task_id = ${input.id} AND enabled = 1
                AND ${staleArchiveCommitted(input.threadId)}
            `,
            (rows) => rows.length > 0,
          );

    // Run-state columns (last_run_*, run_count) are intentionally absent from
    // the conflict clause: they are owned by the run transitions below, and a
    // concurrent settings save must not overwrite an in-flight increment.
    // Check existence in the write itself so an edit cannot undo a deletion
    // that landed after upsert loaded the previous task.
    const saveTask = (
      task: ScheduledTask,
      requireExisting: boolean,
      webhook: {
        readonly token: string | null;
        readonly secret: string | null;
        /** False when the save carried no new secret, so a concurrent change survives. */
        readonly secretChanged: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const enabledSeq = task.enabled ? yield* latestEventSeq : null;
        const rows = yield* sql<{ task_id: string }>`
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
          enabled_seq,
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
          ${yield* encodeScheduleJson(task.schedule)},
          ${task.projectId},
          ${task.threadId},
          ${yield* encodeWorkspaceStrategyJson(task.workspaceStrategy)},
          ${yield* encodeModelSelectionJson(task.modelSelection)},
          ${task.runtimeMode},
          ${task.interactionMode},
          ${task.createdBy},
          ${task.creationSource},
          ${task.createdAt},
          ${task.updatedAt},
          ${enabledSeq},
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
          enabled_seq = CASE
            WHEN excluded.enabled = 0 THEN NULL
            ELSE excluded.enabled_seq
          END,
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
        );
        if (rows.length === 0) {
          return yield* taskError("Schedule task not found.", { taskId: task.id });
        }
      });

    // Scoped like update: when the caller supplies a project, the DELETE's
    // WHERE carries it, so a task moved to another project mid-request is a
    // missing row, never a cross-project delete. RETURNING surfaces that. The
    // task's webhook delivery log goes with it in the same transaction.
    const deleteRow = (id: ScheduledTaskId, projectId?: ProjectId) =>
      sql
        .withTransaction(
          (projectId === undefined
            ? sql<{
                task_id: string;
              }>`DELETE FROM scheduled_tasks WHERE task_id = ${id} RETURNING task_id`
            : sql<{
                task_id: string;
              }>`DELETE FROM scheduled_tasks WHERE task_id = ${id} AND project_id = ${projectId} RETURNING task_id`
          ).pipe(
            Effect.flatMap((rows) =>
              rows.length > 0
                ? sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id = ${id}`.pipe(
                    Effect.as(rows),
                  )
                : Effect.succeed(rows),
            ),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete schedule task.", { taskId: id, cause }),
          ),
        );

    // Run-state transitions use targeted UPDATEs (never the full-row upsert) so
    // a completing run cannot resurrect a deleted task or clobber concurrent
    // edits to the task definition.
    const markRunning = (id: ScheduledTaskId, startedAtIso: string) =>
      sql<{ task_id: string }>`
        UPDATE scheduled_tasks
        SET updated_at = ${startedAtIso},
            last_run_at = ${startedAtIso},
            last_run_status = 'running',
            last_run_error = NULL
        WHERE task_id = ${id}
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not mark schedule task as running.", { taskId: id, cause }),
        ),
        // A task deleted after the re-read must not be dispatched from the stale snapshot.
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
        // lock held by another process from stranding the task as 'running'.
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
      trigger: "scheduled" | "manual" | "webhook",
      webhook?: { readonly deliveryId: string; readonly prompt: string },
      projectId?: ProjectId,
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
                  return { task: active, running: false, paused: false } as const;
                }
                if (active.threadId !== null) {
                  // The archive/delete pause may not have landed yet: a bound
                  // thread that no longer accepts runs must pause the task
                  // instead of recording a guaranteed sendToThread failure on
                  // every fire. Done inside the transaction so the pause and
                  // the decision to not run stay atomic with the row read.
                  const blocked = yield* boundThreadBlocksDispatch({
                    projectId: active.projectId,
                    threadId: active.threadId,
                    taskId: active.id,
                  });
                  if (blocked !== null) {
                    yield* sql`
                      UPDATE scheduled_tasks
                      SET enabled = 0, enabled_seq = NULL,
                          next_run_at = NULL, updated_at = ${startedAtIso}
                      WHERE task_id = ${active.id} AND enabled = 1
                    `.pipe(
                      Effect.mapError((cause) =>
                        taskError("Could not pause schedule task bound to the thread.", {
                          taskId: active.id,
                          cause,
                        }),
                      ),
                    );
                    return {
                      task: {
                        ...active,
                        enabled: false,
                        nextRunAt: null,
                        updatedAt: startedAtIso,
                      },
                      running: false,
                      paused: true,
                    } as const;
                  }
                  // The shell is active, but archive then unarchive can both
                  // have committed while the archive event is still queued for
                  // the reactor — unarchive alone never resumes a schedule, so
                  // a task whose enablement predates a committed archive pauses
                  // here instead of dispatching.
                  const stalePaused = yield* sql<{ task_id: string }>`
                    UPDATE scheduled_tasks
                    SET enabled = 0, enabled_seq = NULL,
                        next_run_at = NULL, updated_at = ${startedAtIso}
                    WHERE task_id = ${active.id} AND enabled = 1
                      AND ${staleArchiveCommitted(active.threadId)}
                    RETURNING task_id
                  `.pipe(
                    Effect.mapError((cause) =>
                      taskError("Could not pause schedule task bound to the thread.", {
                        taskId: active.id,
                        cause,
                      }),
                    ),
                  );
                  if (stalePaused.length > 0) {
                    return {
                      task: {
                        ...active,
                        enabled: false,
                        nextRunAt: null,
                        updatedAt: startedAtIso,
                      },
                      running: false,
                      paused: true,
                    } as const;
                  }
                }
                // A queued delivery must not run a task that was paused,
                // deleted and recreated under the same id, or switched to
                // another trigger while it waited for its turn.
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
                yield* markRunning(active.id, startedAtIso);
                return { task: active, running: true, paused: false } as const;
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
          if (webhook !== undefined) {
            return yield* new WebhookDeliverySkipped({
              reason: "The task was deleted before this delivery ran.",
            });
          }
          // A manual run on a just-deleted task must fail loudly, not report
          // a successful run that never dispatched.
          if (trigger !== "scheduled") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return task;
        }
        if (!marked.running) {
          if (marked.paused) {
            yield* Effect.logInfo(
              "Paused schedule task bound to a thread that no longer accepts runs",
              { taskId: marked.task.id },
            );
            yield* notifyChanged;
            if (trigger === "manual") {
              return yield* taskError(
                "Schedule task is bound to a thread that no longer accepts runs and has been paused. Unarchive the thread or unbind the task to run it.",
                { taskId: task.id },
              );
            }
          }
          return marked.task;
        }
        const active = marked.task;
        yield* notifyChanged;

        // A webhook run is keyed by its delivery so the same delivery can
        // never dispatch twice.
        const fireKey =
          webhook === undefined
            ? `${active.id}:${DateTime.toEpochMillis(startedAt)}:${trigger}`
            : `${active.id}:webhook:${webhook.deliveryId}`;
        const commandId = CommandId.make(`scheduled-task:${fireKey}`);
        const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
        // Dispatch from the fresh row so prompt/model/binding edits made
        // after the poll read are honoured. A webhook prompt was rendered
        // from the row when the request arrived.
        const prompt = webhook?.prompt ?? active.prompt;

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
                  // Scheduled prompts must not interrupt tools in the bound thread.
                  mode: "queue",
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
        // stale schedule. Contention retry keeps a lock held by another
        // process from abandoning the completion write with the task left
        // 'running'.
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

    // A bound thread that is archived or deleted can no longer accept a
    // dispatch — sendToThread rejects it — so an enabled task would otherwise
    // re-fire a guaranteed failure on every interval. Pausing on the live
    // domain event is the prompt path; the sweep below covers archives and
    // deletes committed while the server was down; the fire-time check in
    // runTask is the final backstop for anything both miss.
    yield* Stream.runForEach(threadManagement.streamDomainEvents, (event) =>
      event.type === "thread.archived" || event.type === "thread.deleted"
        ? pauseTasksBoundTo(event.threadId)
        : Effect.void,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Schedule task archive reactor stopped", { cause }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.gen(function* () {
      const bound = yield* sql<{ thread_id: string }>`
        SELECT DISTINCT thread_id FROM scheduled_tasks
        WHERE enabled = 1 AND thread_id IS NOT NULL
      `;
      yield* Effect.forEach(bound, (row) => pauseTasksBoundTo(ThreadId.make(row.thread_id)), {
        concurrency: 1,
        discard: true,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not pause schedule tasks bound to archived threads", { cause }),
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
        const signatureInput = input.schedule.type === "webhook" ? input.schedule.signature : null;
        // A secretRef is a value the user entered for an agent; this save
        // consumes it, so it cannot be used again. Consume it once, outside
        // the write transaction, so a contended-write retry cannot spend it
        // twice.
        const consumedRef =
          signatureInput?.secretRef === undefined
            ? undefined
            : yield* Effect.result(
                secretRequests.consume({
                  ref: signatureInput.secretRef,
                  projectId: input.projectId,
                }),
              );
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
              if (
                input.id === undefined &&
                existingTask !== null &&
                existingTask.projectId !== input.projectId
              ) {
                return yield* taskError("Schedule task not found.", { taskId: id });
              }
              const schedule = normalizeSchedule(input.schedule);
              const webhook =
                input.schedule.type === "webhook"
                  ? yield* Effect.gen(function* () {
                      const existing =
                        existingTask === null ? null : yield* findWebhookCredentials(id);
                      // Saving a webhook task keeps its URL; only rotate changes it.
                      const token = existing?.token ?? (yield* newWebhookToken);
                      // A replay of a save that already used the ref keeps
                      // the secret that save stored.
                      const replay = input.commandId !== undefined && existing?.secret != null;
                      const fromRef =
                        consumedRef === undefined
                          ? undefined
                          : Result.isSuccess(consumedRef)
                            ? consumedRef.success
                            : replay
                              ? undefined
                              : yield* taskError(consumedRef.failure.message, { taskId: id });
                      // A ref, when given, is the only source: a plain secret sent
                      // alongside it must not replace what a replayed save stored.
                      const provided =
                        signatureInput?.secretRef === undefined ? signatureInput?.secret : fromRef;
                      const secret =
                        signatureInput == null ? null : (provided ?? existing?.secret ?? null);
                      const secretChanged =
                        signatureInput == null || provided !== undefined || existing === null;
                      if (signatureInput != null && secret === null) {
                        return yield* taskError(
                          "A webhook signature check needs a signing secret.",
                          { taskId: id },
                        );
                      }
                      return { token, secret, secretChanged };
                    })
                  : { token: null, secret: null, secretChanged: true };
              // Keep the existing next_run_at when the schedule itself is untouched:
              // editing a title or prompt must not postpone (or resurrect) a due
              // run — only schedule/enabled changes restart the clock.
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
                  : nextRunAt({ enabled: input.enabled, schedule }, now),
                lastRunAt: existingTask?.lastRunAt ?? null,
                lastRunStatus: existingTask?.lastRunStatus ?? "never",
                lastRunError: existingTask?.lastRunError ?? null,
                runCount: existingTask?.runCount ?? 0,
              };
              // An enabled task must never point at a thread that cannot
              // accept a dispatch, so its binding is checked on every write:
              // inside this transaction, an archive (and the pause it
              // triggers) committed before saveTask cannot be overwritten back
              // to enabled. A disabled task may keep a stored binding (a paused
              // task stays editable); like update, only a binding this write
              // changes must still be a live thread in the project, so a
              // legacy full-row save or commandId replay of an unchanged pair
              // does not block an unrelated edit.
              const bindingChanged =
                existingTask === null ||
                existingTask.threadId !== task.threadId ||
                existingTask.projectId !== task.projectId;
              if (task.threadId !== null) {
                if (task.enabled) {
                  yield* ensureBindableTarget({
                    projectId: task.projectId,
                    threadId: task.threadId,
                    taskId: task.id,
                  });
                } else if (bindingChanged) {
                  yield* requireThreadInProject(task.id, task.projectId, task.threadId);
                }
              }
              // An enabled upsert that re-affirms an enablement a committed
              // archive already voided (pause still queued) is a resume:
              // restart the interval rather than preserving the stale due
              // time scheduleUnchanged carried over. Invalidation is judged
              // on the *stored* binding — that is the enablement the archive
              // may have voided, not the replacement target's history.
              const toSave =
                task.enabled &&
                existingTask !== null &&
                existingTask.enabled &&
                (yield* enablementInvalidatedByArchive({
                  id: task.id,
                  threadId: existingTask.threadId,
                }))
                  ? {
                      ...task,
                      nextRunAt: nextRunAt({ enabled: true, schedule: task.schedule }, now),
                    }
                  : task;
              yield* saveTask(toSave, input.requireExisting === true, webhook);
              return toSave;
            }),
          ),
        ).pipe(
          Effect.catchTags({
            ScheduledTaskError: (error) => Effect.fail(error),
            SqlError: (cause) =>
              Effect.fail(taskError("Could not upsert the schedule task.", { cause })),
            SchemaError: (cause) =>
              Effect.fail(taskError("Could not upsert the schedule task.", { cause })),
          }),
        );
        yield* notifyChanged;
        // Re-read so the result carries the webhook endpoint the row stores.
        return { task: (yield* findTask(task.id)) ?? task };
      });

    // Partial edits run inside one transaction: the scoped row is read and
    // rewritten without another fiber's statements interleaving (the client's
    // connection serializes transactions), so a delete racing the edit
    // surfaces as `none` (the UPDATE never inserts) and concurrent disjoint
    // edits each keep their own columns.
    const update: ScheduledTaskService["Service"]["update"] = (input) =>
      Effect.gen(function* () {
        const schedule =
          input.schedule === undefined ? undefined : normalizeSchedule(input.schedule);
        const signatureInput = input.schedule?.type === "webhook" ? input.schedule.signature : null;
        // Consumed once, before the write transaction, so a contended-write
        // retry cannot spend the ref twice.
        const consumedRef =
          signatureInput?.secretRef === undefined
            ? undefined
            : yield* secretRequests
                .consume({ ref: signatureInput.secretRef, projectId: input.projectId })
                .pipe(Effect.mapError((error) => taskError(error.message, { taskId: input.id })));
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
              const existing = yield* decodeRow(row, yield* readWebhookOrigin);
              if (
                (input.expectedRuntimeMode !== undefined &&
                  existing.runtimeMode !== input.expectedRuntimeMode) ||
                (input.expectedInteractionMode !== undefined &&
                  existing.interactionMode !== input.expectedInteractionMode)
              ) {
                return yield* taskError(
                  "Scheduled task changed since it was loaded; retry the operation.",
                  { taskId: input.id },
                );
              }
              const nextEnabled = input.enabled ?? existing.enabled;
              const nextSchedule = schedule ?? existing.schedule;
              const nextThreadId =
                input.threadId !== undefined ? input.threadId : existing.threadId;
              const nextProjectId = input.nextProjectId ?? existing.projectId;
              // Patches merge with whatever concurrent edits already
              // committed, so the resulting pair must still be dispatchable:
              // a move keeps an existing threadId only when that thread
              // belongs to the destination project, and a binding update
              // keeps the current project. Passing `threadId: null` in the
              // same patch is the explicit unbind that lets a bound task move.
              // Like upsert, only a pair this write changes is validated, so
              // a patch that repeats the stored binding of a since-deleted
              // thread does not lose the unrelated edits it carries.
              const bindingChanged =
                nextThreadId !== existing.threadId || nextProjectId !== existing.projectId;
              if (nextThreadId !== null && bindingChanged) {
                yield* requireThreadInProject(input.id, nextProjectId, nextThreadId);
              }
              // An enabled task must additionally reject an archived (or
              // otherwise undispatchable) destination — including on edits
              // that leave the binding untouched, so a concurrent enable
              // cannot slip a binding past the check.
              if (nextEnabled && nextThreadId !== null) {
                yield* ensureBindableTarget({
                  projectId: nextProjectId,
                  threadId: nextThreadId,
                  taskId: input.id,
                });
              }
              const patch: Record<string, unknown> = {};
              if (input.title !== undefined) patch.title = input.title;
              if (input.prompt !== undefined) patch.prompt = input.prompt;
              if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
              if (schedule !== undefined) {
                patch.schedule_json = yield* encodeScheduleJson(schedule);
                if (schedule.type === "webhook") {
                  // Same rules as upsert: the URL token survives every save
                  // (only rotate changes it), and an omitted secret keeps the
                  // stored one.
                  const provided =
                    signatureInput?.secretRef === undefined ? signatureInput?.secret : consumedRef;
                  const secret =
                    signatureInput == null ? null : (provided ?? row.webhook_secret ?? null);
                  if (signatureInput != null && secret === null) {
                    return yield* taskError("A webhook signature check needs a signing secret.", {
                      taskId: input.id,
                    });
                  }
                  patch.webhook_token = row.webhook_token ?? (yield* newWebhookToken);
                  patch.webhook_secret = secret;
                } else {
                  patch.webhook_token = null;
                  patch.webhook_secret = null;
                }
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
              // An enabled row whose stored enablement a committed archive
              // already voided (pause still queued) holds an overdue due
              // time. Any update that escapes that pause — an explicit
              // enabled:true re-affirmation, or a rebind/unbind that
              // refreshes the watermark — is a resume: restart the interval
              // rather than firing the stale due time. Invalidation is
              // judged on the *stored* binding: an archive on the
              // replacement thread says nothing about whether this task's
              // enablement survived, and a move off a voided binding must
              // not smuggle the overdue due time onto the new thread.
              const resumeAfterArchive =
                existing.enabled &&
                nextEnabled &&
                (input.enabled === true || nextThreadId !== existing.threadId) &&
                (yield* enablementInvalidatedByArchive({
                  id: input.id,
                  threadId: existing.threadId,
                }));
              // Mirror the upsert rule: only a real schedule/enabled change
              // restarts the run clock — other edits retain the pending due
              // time.
              if (input.enabled !== undefined || schedule !== undefined) {
                if (
                  nextEnabled !== existing.enabled ||
                  !isSameSchedule(existing.schedule, nextSchedule) ||
                  resumeAfterArchive
                ) {
                  patch.next_run_at = nextRunAt(
                    { enabled: nextEnabled, schedule: nextSchedule },
                    now,
                  );
                }
              } else if (resumeAfterArchive) {
                patch.next_run_at = nextRunAt(
                  { enabled: nextEnabled, schedule: nextSchedule },
                  now,
                );
              }
              patch.updated_at = iso(now);
              // The read above and this write share one write-locked
              // transaction, so no other write can land between them.
              // enabled_seq marks when the current enabled binding was last
              // affirmed — the archive pause uses it to spare an explicit
              // post-unarchive re-enable. A rebind of an enabled task starts
              // a new binding earlier archives never saw, and an explicit
              // enabled: true re-affirms even when the flag is already set
              // (the pause may not have landed between archive and
              // unarchive). Edits that omit enabled preserve the marker.
              if (
                nextEnabled !== existing.enabled ||
                nextThreadId !== existing.threadId ||
                input.enabled === true
              ) {
                patch.enabled_seq = nextEnabled ? yield* latestEventSeq : null;
              }
              const written = yield* sql<ScheduledTaskRow>`
                UPDATE scheduled_tasks
                SET ${sql.update(patch)}
                WHERE task_id = ${input.id} AND project_id = ${input.projectId}
                RETURNING *
              `.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not update schedule task.", { taskId: input.id, cause }),
                ),
              );
              const updatedRow = written[0];
              if (updatedRow === undefined) return null;
              return yield* decodeRow(updatedRow, yield* readWebhookOrigin);
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
              const existing = yield* decodeRow(row, yield* readWebhookOrigin);
              // Re-enabling is the explicit reverse of the archive pause —
              // the bound thread must accept runs again, which rules out
              // archived, deleted, and cross-project targets. The check uses
              // the row inside this transaction: a binding a concurrent
              // update committed while the task was disabled is still caught.
              if (input.enabled && existing.threadId !== null) {
                yield* ensureBindableTarget({
                  projectId: existing.projectId,
                  threadId: existing.threadId,
                  taskId: input.id,
                });
              }
              if (existing.enabled === input.enabled) {
                // An explicit enable on an already-enabled task still
                // re-watermarks: archive then unarchive can commit while the
                // archive event is still queued, and the delayed pause must
                // not undo an enable the user asked for after the unarchive.
                if (input.enabled) {
                  const enabledSeq = yield* latestEventSeq;
                  if (yield* enablementInvalidatedByArchive(existing)) {
                    // The stored enablement was already voided by that
                    // committed archive — this affirmation is a resume, so
                    // the interval restarts from now instead of firing the
                    // overdue due time the voided enablement left behind.
                    const now = yield* localNow;
                    const next = nextRunAt({ enabled: true, schedule: existing.schedule }, now);
                    yield* sql`
                      UPDATE scheduled_tasks
                      SET enabled_seq = ${enabledSeq},
                          next_run_at = ${next},
                          updated_at = ${iso(now)}
                      WHERE task_id = ${input.id} AND enabled = 1
                    `.pipe(
                      Effect.mapError((cause) =>
                        taskError("Could not update schedule task.", {
                          taskId: input.id,
                          cause,
                        }),
                      ),
                    );
                    return {
                      task: { ...existing, nextRunAt: next, updatedAt: iso(now) },
                      changed: true,
                    } as const;
                  }
                  yield* sql`
                    UPDATE scheduled_tasks
                    SET enabled_seq = ${enabledSeq}
                    WHERE task_id = ${input.id} AND enabled = 1
                  `.pipe(
                    Effect.mapError((cause) =>
                      taskError("Could not update schedule task.", {
                        taskId: input.id,
                        cause,
                      }),
                    ),
                  );
                }
                return { task: existing, changed: false } as const;
              }
              const now = yield* localNow;
              const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
              const enabledSeq = input.enabled ? yield* latestEventSeq : null;
              const updated = yield* sql<{ task_id: string }>`
                UPDATE scheduled_tasks
                SET enabled = ${input.enabled ? 1 : 0},
                    enabled_seq = ${enabledSeq},
                    next_run_at = ${next},
                    updated_at = ${iso(now)}
                WHERE task_id = ${input.id}
                RETURNING task_id
              `.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not update schedule task.", { taskId: input.id, cause }),
                ),
              );
              if (updated.length === 0) return null;
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
        yield* Ref.update(webhookRateWindows, (windows) => {
          const next = new Map(windows);
          next.delete(input.id);
          return next;
        });
        yield* Ref.update(webhookPermits, (permits) => {
          const next = new Map(permits);
          next.delete(input.id);
          return next;
        });
        yield* notifyChanged;
        return Option.some({ id: input.id });
      });

    const runNow: ScheduledTaskService["Service"]["runNow"] = (input: ScheduledTaskRunNowInput) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
        if (task.schedule.type === "webhook") {
          // There is no request to render the prompt from.
          return yield* taskError("Webhook tasks run when their URL receives a request.", {
            taskId: input.id,
          });
        }
        const next = yield* runTask(task, "manual", undefined, input.projectId).pipe(
          Effect.mapError((cause) =>
            taskError("Could not run schedule task.", { taskId: input.id, cause }),
          ),
        );
        return { task: next };
      });

    const rotateWebhookToken: ScheduledTaskService["Service"]["rotateWebhookToken"] = (input) =>
      Effect.gen(function* () {
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
      missingFields: Option.getOrElse(decodeMissingFieldsJson(row.missing_fields_json), () => []),
      error: row.error,
    });

    const listWebhookDeliveries: ScheduledTaskService["Service"]["listWebhookDeliveries"] = (
      input,
    ) =>
      sql<WebhookDeliveryRow>`
        SELECT * FROM scheduled_task_webhook_deliveries
        WHERE task_id = ${input.id}
        ORDER BY received_at DESC, rowid DESC
      `.pipe(
        Effect.map((rows) => ({ deliveries: rows.map(decodeDeliverySummary) })),
        Effect.mapError((cause) =>
          taskError("Could not list webhook deliveries.", { taskId: input.id, cause }),
        ),
      );

    const getWebhookDelivery: ScheduledTaskService["Service"]["getWebhookDelivery"] = (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<WebhookDeliveryRow>`
          SELECT * FROM scheduled_task_webhook_deliveries
          WHERE task_id = ${input.id} AND delivery_id = ${input.deliveryId}
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not load webhook delivery.", { taskId: input.id, cause }),
          ),
        );
        const row = rows[0];
        if (row === undefined) {
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
      const truncated = input.request.body.byteLength > WEBHOOK_DELIVERY_LOG_BODY_LIMIT;
      const loggedBody = truncated
        ? new TextDecoder().decode(input.request.body.subarray(0, WEBHOOK_DELIVERY_LOG_BODY_LIMIT))
        : input.request.bodyText;
      return sql
        .withTransaction(
          Effect.gen(function* () {
            // Conditional on the task existing, so a delivery racing a delete
            // cannot leave rows that a recreated task with the same id would show.
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
            yield* sql`
            DELETE FROM scheduled_task_webhook_deliveries
            WHERE task_id = ${input.taskId}
              AND delivery_id NOT IN (
                SELECT delivery_id FROM scheduled_task_webhook_deliveries
                WHERE task_id = ${input.taskId}
                -- rowid breaks timestamp ties in arrival order; delivery ids are random.
                ORDER BY received_at DESC, rowid DESC
                LIMIT ${WEBHOOK_DELIVERY_RETENTION}
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

    /**
     * Sliding one-minute window counting every request with a valid token,
     * including ones the signature check later rejects.
     */
    const takeRateSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(
        webhookRateWindows,
        (
          windows,
        ): readonly [
          "allowed" | "first_rejected" | "rejected",
          ReadonlyMap<ScheduledTaskId, RateWindow>,
        ] => {
          const current = windows.get(id);
          const recent = (current?.accepted ?? []).filter((at) => nowMs - at < 60_000);
          if (recent.length >= WEBHOOK_RATE_LIMIT_PER_MINUTE) {
            const first = current?.rejectedLogged !== true;
            return [
              first ? "first_rejected" : "rejected",
              new Map(windows).set(id, { accepted: recent, rejectedLogged: true }),
            ];
          }
          return [
            "allowed",
            new Map(windows).set(id, { accepted: [...recent, nowMs], rejectedLogged: false }),
          ];
        },
      );

    const webhookPermit = (id: ScheduledTaskId) =>
      Effect.gen(function* () {
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

    // Detached from the request so the HTTP response does not wait for the
    // run; scoped to the service so shutdown interrupts it.
    const serviceScope = yield* Effect.scope;

    /**
     * Records one handled request on the span and in metrics. `outcome` is
     * finer than the result tag: it separates a full queue and an oversized
     * prompt from the rest, which is what an operator needs to act on.
     */
    const observeDelivery = (
      request: WebhookTriggerRequest,
      outcome: WebhookDeliveryOutcome,
      receivedAt: DateTime.DateTime | undefined,
      now: DateTime.DateTime | undefined,
    ) =>
      Effect.gen(function* () {
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

    const triggerWebhookUnobserved = (request: WebhookTriggerRequest) =>
      Effect.gen(function* () {
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
            ? `delivery:${yield* crypto.randomUUIDv4.pipe(
                Effect.mapError((cause) => taskError("Could not generate delivery id.", { cause })),
              )}`
            : `delivery:relay:${request.relayDeliveryId}`,
        );
        // A held request may already have reached this environment directly
        // before a timeout; it runs once. Claimed in its own table, kept longer
        // than the relay holds a request, because the delivery log is trimmed.
        // A rate-limited delivery stays held on the relay, so it must give up
        // its claim or the next pass would treat it as already delivered.
        const releaseClaim = <A>(result: A) =>
          request.relayDeliveryId === undefined
            ? Effect.succeed(result)
            : sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE relay_delivery_id = ${request.relayDeliveryId}
              `.pipe(Effect.ignore, Effect.as(result));
        // From the claim until the run is forked nothing may interrupt: a
        // request dropped in between (the relay hangs up after its timeout)
        // would leave a claimed delivery that never runs, or a queue slot
        // that is never released. Everything in here is local and quick.
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
                // A held request this environment already ran: accepted, not run twice.
                yield* observe("duplicate");
                return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
              }
              // Older claims can no longer be replayed by the relay.
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

            // Only the first rejected request in a window is logged, so a flood
            // cannot write rows or push the real deliveries out of the log.
            const slot = yield* takeRateSlot(task.id, DateTime.toEpochMillis(now));
            if (slot !== "allowed") {
              if (slot === "first_rejected") yield* log("rate_limited");
              yield* observe("rate_limited");
              return yield* releaseClaim({
                _tag: "rate_limited" as const,
                outcome: "rate_limited" as const,
              });
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

            const rendered = renderWebhookPrompt(task.prompt, request);
            // A provider refuses a turn this long, so it is not started. The
            // delivery is not retryable, so the claim is kept. Providers trim
            // the prompt before checking, so whitespace around it is free.
            if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
              yield* log("dispatch_failed", {
                signatureVerified: signature !== null,
                missing: rendered.missing,
                renderedPrompt: rendered.prompt,
                error: "The filled-in prompt is too long.",
              });
              yield* observe("prompt_too_long");
              return { _tag: "accepted" as const, deliveryId, outcome: "prompt_too_long" as const };
            }
            // Bound the deliveries one task holds, so steady traffic to a stuck
            // task cannot pile up parked fibers. A refused request is not logged,
            // so it cannot push real deliveries out of the log.
            const queueKey = `${task.id}\u0000${task.createdAt}`;
            const queued = yield* Ref.modify(webhookQueued, (counts) => {
              const count = counts.get(queueKey) ?? 0;
              return count >= WEBHOOK_MAX_QUEUED_PER_TASK
                ? ([false, counts] as const)
                : ([true, new Map(counts).set(queueKey, count + 1)] as const);
            });
            if (!queued) {
              // The task is busy with WEBHOOK_MAX_QUEUED_PER_TASK deliveries already.
              yield* observe("queue_full");
              return yield* releaseClaim({
                _tag: "rate_limited" as const,
                outcome: "queue_full" as const,
              });
            }
            // Entries leave the map when their count reaches zero, so a deleted
            // task's key does not linger once its last delivery finishes.
            const release = Ref.update(webhookQueued, (counts) => {
              const next = new Map(counts);
              const count = (next.get(queueKey) ?? 1) - 1;
              if (count <= 0) next.delete(queueKey);
              else next.set(queueKey, count);
              return next;
            });
            yield* log("accepted", {
              signatureVerified: signature !== null,
              missing: rendered.missing,
              renderedPrompt: rendered.prompt,
            }).pipe(Effect.onError(() => release));
            yield* observe("accepted");
            const permit = yield* webhookPermit(task.id);
            const runOutcome = (outcome: "started" | "skipped" | "failed") =>
              Effect.all([
                Effect.annotateCurrentSpan({ "scheduled_task.webhook.run_outcome": outcome }),
                Metrics.increment(Metrics.webhookRunsTotal, { outcome }),
              ]);
            yield* runTask(task, "webhook", { deliveryId, prompt: rendered.prompt }).pipe(
              Effect.flatMap((completed) =>
                completed.lastRunStatus === "failed"
                  ? runOutcome("failed").pipe(
                      Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                    )
                  : runOutcome("started"),
              ),
              Effect.catchTags({
                WebhookDeliverySkipped: (skipped) =>
                  runOutcome("skipped").pipe(
                    Effect.andThen(markDeliveryFailed(deliveryId, skipped.reason)),
                  ),
              }),
              // The log is readable over RPC, so it gets a fixed reason; the
              // cause, which can carry request data, stays in the server log.
              Effect.catchCause((cause) =>
                Effect.logWarning("Webhook dispatch failed", { taskId: task.id, cause }).pipe(
                  Effect.andThen(runOutcome("failed")),
                  Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                ),
              ),
              permit.withPermits(1),
              // Its own trace: the request that triggered it has already been answered.
              Effect.withSpan("ScheduledTaskService.runWebhookDelivery", {
                root: true,
                attributes: {
                  "scheduled_task.id": task.id,
                  "scheduled_task.webhook.delivery_id": deliveryId,
                },
              }),
              Effect.ensuring(release),
              Effect.forkIn(serviceScope),
            );
            return { _tag: "accepted" as const, deliveryId, outcome: "accepted" as const };
          }),
        );
      });

    return ScheduledTaskService.of({
      list,
      subscribeList,
      upsert,
      update,
      setEnabled,
      delete: deleteTask,
      runNow,
      rotateWebhookToken,
      listWebhookDeliveries,
      getWebhookDelivery,
      triggerWebhook,
      pauseForThread: pauseTasksBoundTo,
    });
  }),
);
