import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t3tools/contracts";

export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
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
