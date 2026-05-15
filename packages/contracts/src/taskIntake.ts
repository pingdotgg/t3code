import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "./orchestration.ts";

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

export const TaskIntakeLinkedAttachment = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString),
  url: TrimmedNonEmptyString,
  type: Schema.optional(Schema.Literals(["image", "file", "video", "audio"])),
  mimeType: Schema.optional(TrimmedNonEmptyString),
  sizeBytes: Schema.optional(Schema.Number),
});
export type TaskIntakeLinkedAttachment = typeof TaskIntakeLinkedAttachment.Type;

export const TaskIntakeImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString,
  url: Schema.optional(TrimmedNonEmptyString),
});
export type TaskIntakeImageAttachment = typeof TaskIntakeImageAttachment.Type;

export const TaskIntakeAttachment = Schema.Union([
  TaskIntakeImageAttachment,
  TaskIntakeLinkedAttachment,
]);
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
