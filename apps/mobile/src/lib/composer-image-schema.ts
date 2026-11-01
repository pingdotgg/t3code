import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { EnvironmentId, PastedTextAttachmentSource } from "@t3tools/contracts";

export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
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
  source: Schema.optional(PastedTextAttachmentSource),
  uploadedAttachmentId: Schema.optional(Schema.String),
  uploadEnvironmentId: Schema.optional(EnvironmentId),
});

export const DraftComposerAttachmentSchema = Schema.Union([
  DraftComposerImageAttachmentSchema,
  DraftComposerFileAttachmentSchema,
]);

const PersistedComposerImageSchema = DraftComposerImageAttachmentSchema.mapFields((fields) => ({
  ...fields,
  previewUri: Schema.optional(Schema.String),
}))
  .check(
    Schema.makeFilter(
      ({ previewUri, fileUri, dataUrl }) =>
        previewUri !== undefined ||
        (fileUri === undefined && dataUrl?.startsWith("data:") === true) ||
        "Image attachment has no preview.",
    ),
  )
  .pipe(
    Schema.decodeTo(Schema.toType(DraftComposerImageAttachmentSchema), {
      decode: SchemaGetter.transform((image) => ({
        ...image,
        previewUri: image.previewUri ?? image.dataUrl!,
      })),
      // Rollbacks can load an older bundle whose image schema requires previewUri.
      encode: SchemaGetter.transform((image) => image),
    }),
  );

export const PersistedComposerAttachmentSchema = Schema.Union([
  PersistedComposerImageSchema,
  DraftComposerFileAttachmentSchema,
]);
