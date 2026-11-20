import * as Schema from "effect/Schema";

// No GT import: the native WebView sends this code across `postMessage` and each client translates it.
const CODES = ["model-invalid", "model-webgl-unavailable"] as const;

export type ModelPreviewErrorCode = (typeof CODES)[number];

/** A model the preview cannot show; `message` stays English for logs. */
export class ModelPreviewError extends Schema.TaggedError<ModelPreviewError>()(
  "ModelPreviewError",
  { code: Schema.Literals(CODES) },
) {
  override get message(): string {
    return this.code === "model-invalid"
      ? "This 3D model could not be read."
      : "3D previews need WebGL, which is unavailable.";
  }
}

export const isModelPreviewError = Schema.is(ModelPreviewError);
