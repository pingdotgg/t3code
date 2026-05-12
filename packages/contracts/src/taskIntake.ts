import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TaskIntakeSource = Schema.Literals(["slack", "linear", "support_email", "webhook"]);
export type TaskIntakeSource = typeof TaskIntakeSource.Type;

export const TaskIntakeExternalLinkKind = Schema.Literals([
  "linear_issue",
  "slack_thread",
  "support_email_thread",
  "webhook_event",
]);
export type TaskIntakeExternalLinkKind = typeof TaskIntakeExternalLinkKind.Type;

export const TaskIntakeActor = Schema.Struct({
  externalId: Schema.optional(TrimmedNonEmptyString),
  displayName: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});
export type TaskIntakeActor = typeof TaskIntakeActor.Type;

export const TaskIntakeAttachment = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString),
  url: TrimmedNonEmptyString,
});
export type TaskIntakeAttachment = typeof TaskIntakeAttachment.Type;

export const TaskIntakeConversationRef = Schema.Struct({
  source: TaskIntakeSource,
  externalLinkKind: TaskIntakeExternalLinkKind,
  externalId: TrimmedNonEmptyString,
  url: Schema.optional(TrimmedNonEmptyString),
  teamId: Schema.optional(TrimmedNonEmptyString),
  channelId: Schema.optional(TrimmedNonEmptyString),
  issueId: Schema.optional(TrimmedNonEmptyString),
  commentId: Schema.optional(TrimmedNonEmptyString),
  emailMessageId: Schema.optional(TrimmedNonEmptyString),
});
export type TaskIntakeConversationRef = typeof TaskIntakeConversationRef.Type;

export const TaskIntakeMessage = Schema.Struct({
  eventId: TrimmedNonEmptyString,
  source: TaskIntakeSource,
  conversation: TaskIntakeConversationRef,
  messageId: TrimmedNonEmptyString,
  actor: Schema.optional(TaskIntakeActor),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(TaskIntakeAttachment)),
  receivedAt: IsoDateTime,
  url: Schema.optional(TrimmedNonEmptyString),
});
export type TaskIntakeMessage = typeof TaskIntakeMessage.Type;

export const TaskIntakeReply = Schema.Struct({
  source: TaskIntakeSource,
  conversation: TaskIntakeConversationRef,
  body: Schema.String,
  idempotencyKey: TrimmedNonEmptyString,
});
export type TaskIntakeReply = typeof TaskIntakeReply.Type;

export const TaskIntakeResolution = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ignore"),
    reason: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("needs_input"),
    reason: TrimmedNonEmptyString,
    reply: TaskIntakeReply,
  }),
  Schema.Struct({
    type: Schema.Literal("create_task"),
    initialPrompt: Schema.String,
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("route_existing_task"),
    taskId: TrimmedNonEmptyString,
  }),
]);
export type TaskIntakeResolution = typeof TaskIntakeResolution.Type;

export const TaskIntakeDeliveryResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("posted"),
    externalMessageId: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    error: TrimmedNonEmptyString,
  }),
]);
export type TaskIntakeDeliveryResult = typeof TaskIntakeDeliveryResult.Type;
