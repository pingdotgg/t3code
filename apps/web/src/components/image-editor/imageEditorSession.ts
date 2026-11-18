import { m } from "~/i18n/messages";
import { msg } from "gt-react";
import { SnapShotSource } from "@t3tools/contracts";
import { Schema } from "effect";

import { dataUrlToFile, readFileAsDataUrl } from "../../lib/imageCompression";
import { updateImageEditorObject, type ImageEditorDocument } from "./imageEditorDocument";

export interface ImageEditorSession {
  readonly originalFile: File;
  readonly originalSource?: SnapShotSource;
  readonly document: ImageEditorDocument;
  readonly stagedRequest?: StagedImageEditRequest;
  readonly options?: ImageEditorOptions;
}

const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
const Rectangle = {
  x: Schema.Finite,
  y: Schema.Finite,
  width: Positive,
  height: Positive,
};
const ObjectFields = {
  ...Rectangle,
  id: Schema.String.check(Schema.isMinLength(1)),
  rotation: Schema.Finite,
  color: Schema.String.check(Schema.isPattern(/^#[a-f0-9]{6}$/i)),
  strokeWidth: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
};
const EditorObject = Schema.Union([
  Schema.Struct({
    ...ObjectFields,
    kind: Schema.Literals(["freehand", "remove", "arrow"]),
    points: Schema.Array(Point).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({ ...ObjectFields, kind: Schema.Literals(["rectangle", "ellipse"]) }),
  Schema.Struct({
    ...ObjectFields,
    kind: Schema.Literal("text"),
    text: Schema.String,
    fontFamily: Schema.String,
    fontSize: Positive,
    align: Schema.Literals(["left", "center", "right"]),
    letterSpacing: Schema.Finite,
    wordSpacing: Schema.optionalKey(Schema.Finite),
    lineHeight: Positive,
    stretch: Positive,
    curve: Schema.Finite,
  }),
  Schema.Struct({ ...ObjectFields, kind: Schema.Literal("pin"), comment: Schema.String }),
]);
const EditorDocument = Schema.Struct({
  width: Positive,
  height: Positive,
  objects: Schema.Array(EditorObject),
  crop: Schema.NullOr(Schema.Struct(Rectangle)),
}).check(
  Schema.makeFilter((document) => {
    if (new Set(document.objects.map((object) => object.id)).size !== document.objects.length) {
      return m(msg("Editable image layers must have distinct identifiers."));
    }
    const crop = document.crop;
    return (
      crop === null ||
      (crop.x >= 0 &&
        crop.y >= 0 &&
        crop.x + crop.width <= document.width + 0.001 &&
        crop.y + crop.height <= document.height + 0.001) ||
      m(msg("The crop must fit inside the source image."))
    );
  }),
);

const OriginalDataUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    const match =
      /^data:((?:image\/[a-z0-9.+-]+|application\/octet-stream)(?:;charset=[a-z0-9-]+)?);base64,([a-z0-9+/]*={0,2})$/i.exec(
        value,
      );
    const payload = match?.[2];
    return (
      (payload !== undefined && payload.length > 0 && payload.length % 4 === 0) ||
      m(msg("The original image must be stored as a base64 image data URL."))
    );
  }),
);

export const ImageEditorOptions = Schema.Struct({
  instructions: Schema.String,
  removeBackground: Schema.Boolean,
  aspectRatio: Schema.String,
});
export type ImageEditorOptions = typeof ImageEditorOptions.Type;

export const StagedImageEditRequest = Schema.Struct({
  options: Schema.optionalKey(ImageEditorOptions),
  imageIds: Schema.Array(Schema.String),
  prompt: Schema.String,
  animation: Schema.optionalKey(
    Schema.Struct({ originalId: Schema.String, context: Schema.String }),
  ),
  editor: Schema.optionalKey(
    Schema.Struct({
      originalId: Schema.String,
      originalName: Schema.String,
      document: EditorDocument,
    }),
  ),
});
export type StagedImageEditRequest = typeof StagedImageEditRequest.Type;

/** Stored layers refer to the already cropped and resized clean attachment, without copying its bytes. */
export function imageEditorDocumentForAttachment(
  document: ImageEditorDocument,
  size: { width: number; height: number },
): ImageEditorDocument {
  const frame = document.crop ?? { x: 0, y: 0, width: document.width, height: document.height };
  const scaleX = size.width / frame.width;
  const scaleY = size.height / frame.height;
  return {
    ...size,
    crop: null,
    objects: document.objects.map(
      (object) =>
        updateImageEditorObject({ ...document, objects: [object] }, object.id, {
          x: (object.x - frame.x) * scaleX,
          y: (object.y - frame.y) * scaleY,
          width: object.width * scaleX,
          height: object.height * scaleY,
          strokeWidth: object.strokeWidth * Math.min(scaleX, scaleY),
        }).objects[0]!,
    ),
  };
}

export const PersistedImageEditorSession = Schema.Struct({
  document: EditorDocument,
  originalDataUrl: OriginalDataUrl,
  originalName: Schema.String,
  originalSource: Schema.optionalKey(SnapShotSource),
  stagedRequest: Schema.optionalKey(StagedImageEditRequest),
  options: Schema.optionalKey(ImageEditorOptions),
});
export type PersistedImageEditorSession = typeof PersistedImageEditorSession.Type;

const decodeSession = Schema.decodeUnknownSync(PersistedImageEditorSession);

export async function serializeImageEditorSession(
  session: ImageEditorSession,
): Promise<PersistedImageEditorSession> {
  return decodeSession({
    document: session.document,
    originalDataUrl: await readFileAsDataUrl(session.originalFile),
    originalName: session.originalFile.name,
    ...(session.originalSource ? { originalSource: session.originalSource } : {}),
    ...(session.stagedRequest ? { stagedRequest: session.stagedRequest } : {}),
    ...(session.options ? { options: session.options } : {}),
  });
}

export function hydrateImageEditorSession(
  persisted: PersistedImageEditorSession,
): ImageEditorSession {
  const session = decodeSession(persisted);
  const mimeType = session.originalDataUrl.slice(5, session.originalDataUrl.indexOf(";base64,"));
  return {
    document: session.document,
    originalFile: dataUrlToFile(session.originalDataUrl, session.originalName, mimeType),
    ...(session.originalSource ? { originalSource: session.originalSource } : {}),
    ...(session.stagedRequest ? { stagedRequest: session.stagedRequest } : {}),
    ...(session.options ? { options: session.options } : {}),
  };
}
