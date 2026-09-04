import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t3tools/contracts";

export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  // New attachments persist an owned file path; drafts saved by older app
  // versions carry inline dataUrl bytes instead and must keep decoding.
  fileUri: Schema.optional(Schema.String),
  dataUrl: Schema.optional(Schema.String),
  uploadedAttachmentId: Schema.optional(Schema.String),
  uploadEnvironmentId: Schema.optional(EnvironmentId),
});

export const DraftComposerFileAttachmentSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("file"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  fileUri: Schema.String,
  uploadedAttachmentId: Schema.optional(Schema.String),
  uploadEnvironmentId: Schema.optional(EnvironmentId),
});

export const DraftComposerAttachmentSchema = Schema.Union([
  DraftComposerImageAttachmentSchema,
  DraftComposerFileAttachmentSchema,
]);
