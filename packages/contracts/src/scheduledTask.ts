import * as Schema from "effect/Schema";

import {
  CommandId,
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** 24-hour "HH:MM" wall-clock time. Mirrors `parseTimeOfDay` on the server. */
const TimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
).annotate({ description: "Local wall-clock time in 24-hour HH:MM form, such as 09:30." });

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000;

const ScheduledTaskIntervalMs = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "Positive interval in milliseconds.",
});

const ScheduledTaskIntervalSchedule = Schema.Struct({
  type: Schema.Literal("interval").annotate({
    description: "Select interval scheduling.",
  }),
  everyMs: ScheduledTaskIntervalMs,
}).annotate({
  description: "Run repeatedly after a fixed number of milliseconds.",
});

const ScheduledTaskFixedTimeSchedule = Schema.Struct({
  type: Schema.Literal("fixed_time").annotate({
    description: "Select a fixed local wall-clock time.",
  }),
  timeOfDay: TimeOfDay,
  weekdays: Schema.optional(
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).annotate({
        description: "Weekday number where 0 is Sunday and 6 is Saturday.",
      }),
    ).annotate({
      description: "Optional weekdays; omit to run every day.",
    }),
  ),
}).annotate({
  description: "Run at a fixed local wall-clock time on selected weekdays.",
});

const ScheduledTaskWebhookSignatureFields = {
  header: TrimmedNonEmptyString.annotate({
    description: "Request header carrying the signature, such as x-hub-signature-256.",
  }),
  encoding: Schema.Literals(["hex", "base64"]).annotate({
    description: "How the HMAC-SHA256 digest is encoded in the header.",
  }),
  prefix: Schema.String.annotate({
    description: "Text before the digest in the header value, such as 'sha256='. Empty for none.",
  }),
};

/** HMAC-SHA256 over the raw request body. The secret is never part of the read model. */
export const ScheduledTaskWebhookSignature = Schema.Struct(
  ScheduledTaskWebhookSignatureFields,
).annotate({ description: "Optional HMAC-SHA256 signature check over the raw request body." });
export type ScheduledTaskWebhookSignature = typeof ScheduledTaskWebhookSignature.Type;

/** Matches how long the relay holds a request for an offline environment. */
export const MAX_WEBHOOK_DELIVERY_AGE_MINUTES = 24 * 60;

const WebhookMaxDeliveryAgeMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_WEBHOOK_DELIVERY_AGE_MINUTES }),
).annotate({
  description:
    "Skip requests the relay held longer than this many minutes while the environment was offline. Null runs every request.",
});

const ScheduledTaskWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook").annotate({
    description: "Run when the task's webhook URL receives a request.",
  }),
  signature: Schema.NullOr(ScheduledTaskWebhookSignature),
  // Optional so rows saved before this setting existed still decode.
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
}).annotate({
  description:
    "Run on each request to the task's webhook URL. The prompt may use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} and {{request}} placeholders.",
});

const ScheduledTaskUpsertWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook").annotate({
    description: "Run when the task's webhook URL receives a request.",
  }),
  signature: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ...ScheduledTaskWebhookSignatureFields,
        secret: Schema.optional(TrimmedNonEmptyString).annotate({
          description: "Shared signing secret. Omit to keep the stored secret.",
        }),
        secretRef: Schema.optional(SecretRef).annotate({
          description:
            "A secret the user entered through request_secret, used instead of secret. It is consumed by this save.",
        }),
      }),
    ),
  ).annotate({
    description: "Signature check; omit or null to accept requests by URL token only.",
  }),
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
}).annotate({
  description:
    "Run on each request to the task's webhook URL. The prompt may use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} and {{request}} placeholders.",
});

/**
 * Read model for persisted schedules. Keep accepting legacy sub-minute rows so
 * users can list, disable, edit, or delete them after the write minimum changes.
 */
export const ScheduledTaskSchedule = Schema.Union([
  ScheduledTaskIntervalSchedule,
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskWebhookSchedule,
]).annotate({
  description:
    "Structured trigger. Pass an object with type 'interval', 'fixed_time' or 'webhook'.",
});
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

/** Mutation model: newly created or updated interval schedules run at most once per minute. */
export const ScheduledTaskUpsertSchedule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval").annotate({
      description: "Select interval scheduling.",
    }),
    everyMs: ScheduledTaskIntervalMs.check(
      Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS),
    ).annotate({
      description: "Interval in milliseconds, with a minimum of 60000 (one minute).",
    }),
  }).annotate({
    description: "Run repeatedly after a fixed number of milliseconds.",
  }),
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskUpsertWebhookSchedule,
]).annotate({
  description: "Writable trigger. Pass an object with type 'interval', 'fixed_time' or 'webhook'.",
});
export type ScheduledTaskUpsertSchedule = typeof ScheduledTaskUpsertSchedule.Type;

export const ScheduledTaskRunStatus = Schema.Literals(["never", "running", "succeeded", "failed"]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

/** Where a webhook task receives requests. Present only on webhook tasks. */
export const ScheduledTaskWebhookEndpoint = Schema.Struct({
  /** Environment-relative path including the secret token; works on any origin that reaches the environment. */
  path: TrimmedNonEmptyString,
  /** Public T3 Connect URL, or null when the environment is not linked to T3 Connect. */
  url: Schema.NullOr(TrimmedNonEmptyString),
  hasSecret: Schema.Boolean,
});
export type ScheduledTaskWebhookEndpoint = typeof ScheduledTaskWebhookEndpoint.Type;

export const ScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  webhook: Schema.optional(ScheduledTaskWebhookEndpoint),
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskListInput = Schema.Struct({});
export type ScheduledTaskListInput = typeof ScheduledTaskListInput.Type;

export const ScheduledTaskListResult = Schema.Struct({
  // Trigger types grow over time; a client must not lose the whole list over
  // one task it cannot decode.
  tasks: ForwardCompatibleArray(ScheduledTask),
});
export type ScheduledTaskListResult = typeof ScheduledTaskListResult.Type;

export const ScheduledTaskUpsertInput = Schema.Struct({
  id: Schema.optional(ScheduledTaskId),
  requireExisting: Schema.optional(Schema.Boolean).annotate({
    description: "Reject the save if the task no longer exists, for edits from a client form.",
  }),
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskUpsertSchedule,
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type ScheduledTaskUpsertInput = typeof ScheduledTaskUpsertInput.Type;

/**
 * Sparse workspace-strategy merge: only the provided keys are applied to the
 * live strategy inside the update transaction, so two clients editing
 * disjoint controls (for example `baseRef` and `startFromOrigin`) keep both
 * changes instead of the second whole-object write reverting the first. A
 * strategy `type` change must send the complete `workspaceStrategy` instead.
 */
export const ScheduledTaskWorkspaceStrategyPatch = Schema.Struct({
  branch: Schema.optional(TrimmedNonEmptyString),
  worktreePath: Schema.optional(TrimmedNonEmptyString),
  baseRef: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskWorkspaceStrategyPatch = typeof ScheduledTaskWorkspaceStrategyPatch.Type;

/**
 * Atomic partial update: only the provided fields are written, and only while
 * the task still exists in `projectId`. Implemented as a targeted UPDATE —
 * never an insert — so an edit racing a delete cannot resurrect the task and
 * disjoint concurrent edits keep their own columns.
 */
export const ScheduledTaskUpdateInput = Schema.Struct({
  id: ScheduledTaskId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.optional(Schema.Boolean),
  schedule: Schema.optional(ScheduledTaskUpsertSchedule),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
  workspaceStrategyPatch: Schema.optional(ScheduledTaskWorkspaceStrategyPatch),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  /** Moves the task to another project; `projectId` stays the lookup scope. */
  nextProjectId: Schema.optional(ProjectId),
  // Preconditions checked inside the write transaction: when provided, the
  // update is rejected if the stored modes no longer match, so a caller
  // authorized against these modes cannot patch a task raised since.
  expectedRuntimeMode: Schema.optional(RuntimeMode),
  expectedInteractionMode: Schema.optional(ProviderInteractionMode),
});
export type ScheduledTaskUpdateInput = typeof ScheduledTaskUpdateInput.Type;

/** Older servers can save through upsert, but cannot merge edits atomically after this snapshot. */
export function scheduledTaskLegacyUpsert(
  task: ScheduledTask,
  patch: ScheduledTaskUpdateInput,
): ScheduledTaskUpsertInput {
  const sparse = patch.workspaceStrategyPatch;
  return {
    id: task.id,
    requireExisting: true,
    creationSource: task.creationSource,
    title: patch.title ?? task.title,
    prompt: patch.prompt ?? task.prompt,
    enabled: patch.enabled ?? task.enabled,
    schedule: patch.schedule ?? task.schedule,
    projectId: patch.nextProjectId ?? task.projectId,
    threadId: patch.threadId === undefined ? task.threadId : patch.threadId,
    workspaceStrategy: patch.workspaceStrategy ?? {
      ...task.workspaceStrategy,
      ...(sparse?.branch !== undefined ? { branch: sparse.branch } : {}),
      ...(sparse?.worktreePath !== undefined ? { worktreePath: sparse.worktreePath } : {}),
      ...(sparse?.baseRef !== undefined ? { baseRef: sparse.baseRef } : {}),
      ...(sparse?.startFromOrigin !== undefined ? { startFromOrigin: sparse.startFromOrigin } : {}),
    },
    modelSelection: patch.modelSelection ?? task.modelSelection,
    runtimeMode: patch.runtimeMode ?? task.runtimeMode,
    interactionMode: task.interactionMode,
  };
}

/** Partial update that flips only the enabled flag — never overwrites other fields. */
export const ScheduledTaskSetEnabledInput = Schema.Struct({
  id: ScheduledTaskId,
  enabled: Schema.Boolean,
});
export type ScheduledTaskSetEnabledInput = typeof ScheduledTaskSetEnabledInput.Type;

export const ScheduledTaskDeleteInput = Schema.Struct({
  id: ScheduledTaskId,
  /**
   * When set, the delete is scoped to this project: the row is deleted only if
   * it still belongs to `projectId`, so a concurrent project move turns the
   * delete into a typed not-found rather than a cross-project delete.
   */
  projectId: Schema.optional(ProjectId),
});
export type ScheduledTaskDeleteInput = typeof ScheduledTaskDeleteInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({
  id: ScheduledTaskId,
  /**
   * When set, the dispatch re-read inside the mark-running transaction also
   * requires `project_id = projectId`, so a concurrent project move turns the
   * manual run into a typed not-found instead of firing under the old
   * project's authority.
   */
  projectId: Schema.optional(ProjectId),
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

export const ScheduledTaskRotateWebhookTokenInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRotateWebhookTokenInput = typeof ScheduledTaskRotateWebhookTokenInput.Type;

export const ScheduledTaskWebhookDeliveryId = TrimmedNonEmptyString.pipe(
  Schema.brand("ScheduledTaskWebhookDeliveryId"),
);
export type ScheduledTaskWebhookDeliveryId = typeof ScheduledTaskWebhookDeliveryId.Type;

export const ScheduledTaskWebhookDeliveryOutcome = Schema.Literals([
  "accepted",
  "dispatch_failed",
  "rejected_signature",
  "disabled",
  "rate_limited",
  "expired",
]);
export type ScheduledTaskWebhookDeliveryOutcome = typeof ScheduledTaskWebhookDeliveryOutcome.Type;

export const ScheduledTaskWebhookDeliverySummary = Schema.Struct({
  id: ScheduledTaskWebhookDeliveryId,
  taskId: ScheduledTaskId,
  receivedAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  contentType: Schema.NullOr(Schema.String),
  bodyBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: ScheduledTaskWebhookDeliveryOutcome,
  /** True when a configured signature matched; false when none was configured. */
  signatureVerified: Schema.Boolean,
  /** Template placeholders that had no value in this request and rendered empty. */
  missingFields: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type ScheduledTaskWebhookDeliverySummary = typeof ScheduledTaskWebhookDeliverySummary.Type;

export const ScheduledTaskWebhookDelivery = Schema.Struct({
  ...ScheduledTaskWebhookDeliverySummary.fields,
  query: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  /** Body as UTF-8 text, cut at the log limit; see bodyTruncated. */
  body: Schema.String,
  bodyTruncated: Schema.Boolean,
  renderedPrompt: Schema.NullOr(Schema.String),
});
export type ScheduledTaskWebhookDelivery = typeof ScheduledTaskWebhookDelivery.Type;

export const ScheduledTaskListWebhookDeliveriesInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskListWebhookDeliveriesInput =
  typeof ScheduledTaskListWebhookDeliveriesInput.Type;

export const ScheduledTaskListWebhookDeliveriesResult = Schema.Struct({
  deliveries: Schema.Array(ScheduledTaskWebhookDeliverySummary),
});
export type ScheduledTaskListWebhookDeliveriesResult =
  typeof ScheduledTaskListWebhookDeliveriesResult.Type;

export const ScheduledTaskGetWebhookDeliveryInput = Schema.Struct({
  id: ScheduledTaskId,
  deliveryId: ScheduledTaskWebhookDeliveryId,
});
export type ScheduledTaskGetWebhookDeliveryInput = typeof ScheduledTaskGetWebhookDeliveryInput.Type;

export const ScheduledTaskGetWebhookDeliveryResult = Schema.Struct({
  delivery: ScheduledTaskWebhookDelivery,
});
export type ScheduledTaskGetWebhookDeliveryResult =
  typeof ScheduledTaskGetWebhookDeliveryResult.Type;

export const ScheduledTaskMutationResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskMutationResult = typeof ScheduledTaskMutationResult.Type;

export const ScheduledTaskDeleteResult = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteResult = typeof ScheduledTaskDeleteResult.Type;

export const ScheduledTaskRunNowResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskRunNowResult = typeof ScheduledTaskRunNowResult.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  {
    message: Schema.String,
    taskId: Schema.optional(ScheduledTaskId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
