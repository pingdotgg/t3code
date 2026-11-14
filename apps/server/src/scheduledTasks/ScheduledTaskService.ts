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
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as DueHint from "../scheduling/DueHint.ts";
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
  encodePendingTask,
  decodePendingRequest,
  dedupeError,
} from "./webhookDedupe.ts";
import { describeFailedWebhookFilter, findFailedWebhookFilter } from "./webhookFilter.ts";
import { constantTimeEquals, verifyWebhookSignature } from "./webhookVerification.ts";
import { decodeRow } from "./ScheduledTaskServiceParts.ts";
import { listDueTasks } from "./ScheduledTaskServiceParts2.ts";
import { nextRunAt } from "./ScheduledTaskServiceParts3.ts";
import { nextRunAfterRun } from "./ScheduledTaskServiceParts4.ts";
import type { ScheduledTaskRow } from "./ScheduledTaskServiceParts5.ts";
import type { WebhookDeliveryRow } from "./ScheduledTaskServiceParts6.ts";
import type { WebhookTriggerResult } from "./ScheduledTaskServiceParts7.ts";
import type { WebhookDeliveryOutcome } from "./ScheduledTaskServiceParts8.ts";

import { makeScheduledTaskState } from "./ScheduledTaskService-part3.ts";
import { makeScheduledTaskStage2 } from "./ScheduledTaskService-part4.ts";
import { makeScheduledTaskStage3 } from "./ScheduledTaskService-part5.ts";
import { makeScheduledTaskStage4 } from "./ScheduledTaskService-part6.ts";
import { makeScheduledTaskFlows } from "./ScheduledTaskService-part7.ts";

export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";
export const isScheduledTaskError = Schema.is(ScheduledTaskError);
export const PROMPT_TOO_LONG = "The filled-in prompt is too long.";
export const WEBHOOK_DELIVERY_RETENTION = 50;
export const WEBHOOK_DEDUPE_DELIVERY_RETENTION = 20;
export const WEBHOOK_FILTERED_DELIVERY_RETENTION = 20;
export const WEBHOOK_DEDUPE_LOG_PER_MINUTE = 10;
export const WEBHOOK_FILTERED_LOG_PER_MINUTE = 10;
export const WEBHOOK_DELIVERY_LOG_BODY_LIMIT = 64 * 1024;
export const WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT = 64 * 1024;
export const WEBHOOK_MAX_QUEUED_PER_TASK = 20;
// Enforce the relay's per-task/minute limit here too; tunnel hostnames are public.
export const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;
export const LEGACY_DELIVERY_OUTCOMES: ReadonlySet<string> = new Set([
  "accepted",
  "dispatch_failed",
  "rejected_signature",
  "disabled",
  "rate_limited",
  "expired",
]);

export interface WebhookOrigin {
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

export class WebhookDeliverySkipped extends Data.TaggedError("WebhookDeliverySkipped")<{
  readonly reason: string;
}> {}

export interface RateWindow {
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

export const webhookFilters = (filters: ReadonlyArray<ScheduledTaskWebhookFilter> | undefined) =>
  filters?.length ? { filters } : {};

export const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
export const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
export const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
export const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
export const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);
const HeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const MissingFieldsJson = Schema.fromJsonString(Schema.Array(Schema.String));
export const decodeHeadersJson = Schema.decodeUnknownOption(HeadersJson);
export const decodeMissingFieldsJson = Schema.decodeUnknownOption(MissingFieldsJson);
export const encodeHeadersJson = Schema.encodeSync(HeadersJson);
export const encodeMissingFieldsJson = Schema.encodeSync(MissingFieldsJson);

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

export function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

export function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

export const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

export function requireFutureOnce(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  now: DateTime.DateTime,
  taskId: ScheduledTaskId,
) {
  return task.enabled && task.schedule.type === "once" && nextRunAt(task, now) === null
    ? taskError("The run time has passed. Pick a time in the future.", { taskId })
    : Effect.void;
}

export function errorMessage(error: unknown): string {
  const failure = Cause.isCause(error) ? Cause.squash(error) : error;
  return failure instanceof Error ? failure.message : String(failure);
}

function webhookPath(taskId: string, token: string): string {
  return `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(taskId)}/${token}`;
}

export function webhookEndpoint(
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
export const layer = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const s1 = yield* makeScheduledTaskState();
    const s2 = yield* makeScheduledTaskStage2(s1);
    const s3 = yield* makeScheduledTaskStage3(s2);
    const s4 = yield* makeScheduledTaskStage4(s3);
    const s5 = yield* makeScheduledTaskFlows(s4);
    const shape = s5;
    return ScheduledTaskService.of(shape);
  }),
);
export * from "./ScheduledTaskServiceParts2.ts";
export * from "./ScheduledTaskServiceParts5.ts";
export * from "./ScheduledTaskServiceParts7.ts";
export * from "./ScheduledTaskServiceParts8.ts";

