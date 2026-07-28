import * as Schema from "effect/Schema";

import { MessageId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 20 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_DATA_URL_CHARS = 28_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
const CHAT_ATTACHMENT_NAME_MAX_CHARS = 255;
const CHAT_ATTACHMENT_MIME_MAX_CHARS = 100;

const ChatAttachmentName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_NAME_MAX_CHARS),
  Schema.isPattern(/^[^/\\\p{Cc}]+$/u),
);

const ChatAttachmentMimeType = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_MIME_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
);

export const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: ChatAttachmentName,
  mimeType: ChatAttachmentMimeType.check(Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: ChatAttachmentName,
  mimeType: ChatAttachmentMimeType.check(Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_DATA_URL_CHARS)),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

const chatFileAttachment = <Type extends "file" | "pdf" | "video">(type: Type) =>
  Schema.Struct({
    type: Schema.Literal(type),
    id: ChatAttachmentId,
    name: ChatAttachmentName,
    mimeType:
      type === "pdf"
        ? ChatAttachmentMimeType.check(Schema.isPattern(/^application\/pdf$/i))
        : type === "video"
          ? ChatAttachmentMimeType.check(Schema.isPattern(/^video\//i))
          : ChatAttachmentMimeType,
    sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  });

const uploadChatFileAttachment = <Type extends "file" | "pdf" | "video">(type: Type) =>
  Schema.Struct({
    type: Schema.Literal(type),
    name: ChatAttachmentName,
    mimeType:
      type === "pdf"
        ? ChatAttachmentMimeType.check(Schema.isPattern(/^application\/pdf$/i))
        : type === "video"
          ? ChatAttachmentMimeType.check(Schema.isPattern(/^video\//i))
          : ChatAttachmentMimeType,
    sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
    dataUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_DATA_URL_CHARS)),
  });

export const ChatFileAttachment = chatFileAttachment("file");
export type ChatFileAttachment = typeof ChatFileAttachment.Type;
export const ChatPdfAttachment = chatFileAttachment("pdf");
export type ChatPdfAttachment = typeof ChatPdfAttachment.Type;
export const ChatVideoAttachment = chatFileAttachment("video");
export type ChatVideoAttachment = typeof ChatVideoAttachment.Type;

export const UploadChatFileAttachment = uploadChatFileAttachment("file");
export type UploadChatFileAttachment = typeof UploadChatFileAttachment.Type;
export const UploadChatPdfAttachment = uploadChatFileAttachment("pdf");
export type UploadChatPdfAttachment = typeof UploadChatPdfAttachment.Type;
export const UploadChatVideoAttachment = uploadChatFileAttachment("video");
export type UploadChatVideoAttachment = typeof UploadChatVideoAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatPdfAttachment,
  ChatVideoAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;

export const UploadChatAttachment = Schema.Union([
  UploadChatImageAttachment,
  UploadChatFileAttachment,
  UploadChatPdfAttachment,
  UploadChatVideoAttachment,
]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const PersistChatAttachmentsInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  attachments: Schema.Array(UploadChatAttachment),
});
export type PersistChatAttachmentsInput = typeof PersistChatAttachmentsInput.Type;

export const PersistChatAttachmentsResult = Schema.Struct({
  attachments: Schema.Array(ChatAttachment),
});
export type PersistChatAttachmentsResult = typeof PersistChatAttachmentsResult.Type;

export class PersistChatAttachmentsError extends Schema.TaggedErrorClass<PersistChatAttachmentsError>()(
  "PersistChatAttachmentsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
