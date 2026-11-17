import * as Schema from "effect/Schema";
import {
  EventId,
  NonNegativeInt,
  ProjectId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "./baseSchemas.ts";
import { OrchestrationV2ProviderFailureClass } from "./orchestrationV2.ts";

const common = {
  schemaVersion: Schema.Literal(1),
  deliveryId: Schema.String,
  eventId: EventId,
  sequence: NonNegativeInt,
  occurredAt: Schema.String,
  projectId: ProjectId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
};

/** Notifications identify committed transitions. Read context and respond through MCP. */
export const ThreadWebhookEvent = Schema.Union([
  Schema.Struct({
    ...common,
    type: Schema.Literals(["thread.user-input.requested", "thread.approval.requested"]),
    requestId: RuntimeRequestId,
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("thread.run.terminal"),
    runId: RunId,
    status: Schema.Literals(["completed", "failed", "interrupted", "cancelled", "rolled_back"]),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("thread.provider-error"),
    turnItemId: TurnItemId,
    failureClass: OrchestrationV2ProviderFailureClass,
    status: Schema.Literals(["running", "failed"]),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("thread.goal.blocked"),
    providerThreadId: ProviderThreadId,
    runId: Schema.Null,
    status: Schema.Literals(["usage_limited", "budget_limited"]),
  }),
]);
export type ThreadWebhookEvent = typeof ThreadWebhookEvent.Type;
