import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t3tools/contracts";

export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  // Accept future file-backed records before enabling the new image writers.
  fileUri: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  dataUrl: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  uploadedAttachmentId: Schema.optional(Schema.String),
  uploadEnvironmentId: Schema.optional(EnvironmentId),
}).check(
  Schema.makeFilter(
    ({ fileUri, dataUrl }) =>
      fileUri !== undefined ||
      dataUrl !== undefined ||
      "Image attachment has no file or inline bytes.",
  ),
);

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
