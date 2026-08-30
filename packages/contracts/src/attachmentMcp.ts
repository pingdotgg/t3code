import * as Schema from "effect/Schema";

import {
  ChatAttachmentId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "./chatAttachment.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AttachmentMcpPrepareUploadInput = Schema.Struct({
  type: Schema.optional(Schema.Literals(["image", "file"])),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  ),
}).check(
  Schema.makeFilter((input) => {
    if (input.type === "file") return true;
    if (
      !PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.includes(
        input.mimeType as (typeof PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES)[number],
      )
    ) {
      return `Image mimeType must be one of: ${PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.join(", ")}.`;
    }
    return (
      input.sizeBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ||
      `Images must not exceed ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES} bytes.`
    );
  }),
);
export type AttachmentMcpPrepareUploadInput = typeof AttachmentMcpPrepareUploadInput.Type;

export const AttachmentMcpPrepareUploadResult = Schema.Struct({
  attachmentId: ChatAttachmentId,
  type: Schema.Literals(["image", "file"]),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
  upload: Schema.Struct({
    method: Schema.Literal("PUT"),
    relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
    expiresAt: IsoDateTime,
  }),
});
export type AttachmentMcpPrepareUploadResult = typeof AttachmentMcpPrepareUploadResult.Type;

export const AttachmentMcpDiscardUploadInput = Schema.Struct({
  attachmentId: ChatAttachmentId,
  uploadRelativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type AttachmentMcpDiscardUploadInput = typeof AttachmentMcpDiscardUploadInput.Type;

export const AttachmentMcpDiscardUploadResult = Schema.Struct({
  attachmentId: ChatAttachmentId,
  discarded: Schema.Boolean,
});
export type AttachmentMcpDiscardUploadResult = typeof AttachmentMcpDiscardUploadResult.Type;

export class AttachmentMcpFailure extends Schema.TaggedErrorClass<AttachmentMcpFailure>()(
  "AttachmentMcpFailure",
  {
    code: Schema.Literals(["capability_denied", "invalid_attachment", "upload_error"]),
    message: Schema.String,
  },
) {}
