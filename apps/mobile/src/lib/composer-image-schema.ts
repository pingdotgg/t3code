import { PreviewAnnotationPayloadSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

const PersistedDraftComposerImageMarkupOriginalSchema = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
  previewUri: Schema.optional(Schema.String),
});

const DraftComposerImageMarkupOriginalSchema = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
  previewUri: Schema.String,
});

const PersistedDraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.optional(Schema.String),
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
  markup: Schema.optional(
    Schema.Struct({
      annotation: PreviewAnnotationPayloadSchema,
      original: PersistedDraftComposerImageMarkupOriginalSchema,
    }),
  ),
});

const RuntimeDraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
  markup: Schema.optional(
    Schema.Struct({
      annotation: PreviewAnnotationPayloadSchema,
      original: DraftComposerImageMarkupOriginalSchema,
    }),
  ),
});

/**
 * Keeps preview URIs available in memory while avoiding repeated base64 blobs
 * in persisted drafts and outbox entries. A missing preview URI decodes to the
 * durable data URL; non-data previews such as picker file URIs round-trip.
 */
export const DraftComposerImageAttachmentSchema = PersistedDraftComposerImageAttachmentSchema.pipe(
  Schema.decodeTo(
    RuntimeDraftComposerImageAttachmentSchema,
    SchemaTransformation.transformOrFail({
      decode: (attachment) =>
        Effect.succeed({
          ...attachment,
          previewUri: attachment.previewUri ?? attachment.dataUrl,
          ...(attachment.markup
            ? {
                markup: {
                  ...attachment.markup,
                  original: {
                    ...attachment.markup.original,
                    previewUri:
                      attachment.markup.original.previewUri ?? attachment.markup.original.dataUrl,
                  },
                },
              }
            : {}),
        } as typeof RuntimeDraftComposerImageAttachmentSchema.Encoded),
      encode: (attachment) =>
        Effect.succeed({
          ...attachment,
          ...(attachment.previewUri === attachment.dataUrl
            ? { previewUri: undefined }
            : { previewUri: attachment.previewUri }),
          ...(attachment.markup
            ? {
                markup: {
                  ...attachment.markup,
                  original: {
                    ...attachment.markup.original,
                    ...(attachment.markup.original.previewUri === attachment.markup.original.dataUrl
                      ? { previewUri: undefined }
                      : { previewUri: attachment.markup.original.previewUri }),
                  },
                },
              }
            : {}),
        } as typeof PersistedDraftComposerImageAttachmentSchema.Encoded),
    }),
  ),
);
