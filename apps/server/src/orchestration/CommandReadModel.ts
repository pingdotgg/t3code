import {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

// This process-local model is for command decisions. Content belongs in the
// SQL projections; omitting it here makes accidental content reads a type error.
export const CommandMessage = Schema.Struct(
  Struct.pick(OrchestrationMessage.fields, ["id", "role", "turnId", "createdAt", "updatedAt"]),
);
export type CommandMessage = typeof CommandMessage.Type;

export const CommandCheckpoint = Schema.Struct(
  Struct.omit(OrchestrationCheckpointSummary.fields, ["files"]),
);
export const CommandProposedPlan = Schema.Struct(
  Struct.pick(OrchestrationProposedPlan.fields, ["id", "turnId", "createdAt", "updatedAt"]),
);
export const CommandActivity = Schema.Struct({
  ...Struct.pick(OrchestrationThreadActivity.fields, [
    "id",
    "kind",
    "turnId",
    "sequence",
    "createdAt",
  ]),
  requestId: Schema.NullOr(Schema.String),
  responseMode: Schema.NullOr(Schema.Literal("message")),
  staleFailure: Schema.Boolean,
});
export type CommandActivity = typeof CommandActivity.Type;

export const CommandThread = Schema.Struct({
  ...OrchestrationThread.fields,
  messages: Schema.Array(CommandMessage),
  activities: Schema.Array(CommandActivity),
  checkpoints: Schema.Array(CommandCheckpoint),
  proposedPlans: Schema.Array(CommandProposedPlan),
});
export type CommandThread = typeof CommandThread.Type;
export const CommandReadModel = Schema.Struct({
  ...OrchestrationReadModel.fields,
  threads: Schema.Array(CommandThread),
});
export type CommandReadModel = typeof CommandReadModel.Type;

export const MAX_COMMAND_MESSAGES = 2_000;
export const MAX_COMMAND_ACTIVITIES = 500;
export const MAX_COMMAND_CHECKPOINTS = 500;
export const MAX_COMMAND_PLANS = 200;

/** Startup restores decision history only for live threads updated within this
 * window of the newest thread activity. Older and archived threads start empty,
 * as they did before this model existed, so boot memory follows recent work
 * instead of every thread ever created. */
export const COMMAND_HISTORY_RESTORE_WINDOW = Duration.days(7);

/** Reduces activity bodies to the request facts used by the decider and retention. */
export function toCommandActivity(
  activity: Pick<
    OrchestrationThreadActivity,
    "id" | "kind" | "turnId" | "sequence" | "createdAt" | "payload"
  >,
): CommandActivity {
  const isRequestActivity =
    activity.kind === "approval.requested" ||
    activity.kind === "approval.resolved" ||
    activity.kind === "user-input.requested" ||
    activity.kind === "user-input.resolved" ||
    activity.kind === "provider.approval.respond.failed" ||
    activity.kind === "provider.user-input.respond.failed";
  const payload =
    isRequestActivity && Predicate.isObject(activity.payload) ? activity.payload : null;
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : "";
  return {
    id: activity.id,
    kind: activity.kind,
    turnId: activity.turnId,
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    createdAt: activity.createdAt,
    requestId: typeof payload?.requestId === "string" ? payload.requestId : null,
    responseMode: payload?.responseMode === "message" ? "message" : null,
    staleFailure:
      detail.includes("stale pending approval request") ||
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("stale pending user-input request") ||
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request"),
  };
}
