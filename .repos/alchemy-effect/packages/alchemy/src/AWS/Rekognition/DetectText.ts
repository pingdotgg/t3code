import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DetectText` — detect and extract lines and words of text in an image.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DetectText` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DetectTextHttp)`.
 *
 * @binding
 * @section Image Analysis
 * @example Extract Text from an Image
 * ```typescript
 * // init
 * const detectText = yield* AWS.Rekognition.DetectText();
 *
 * // runtime
 * const result = yield* detectText({ Image: { Bytes: imageBytes } });
 * const lines = (result.TextDetections ?? [])
 *   .filter((t) => t.Type === "LINE")
 *   .map((t) => t.DetectedText);
 * ```
 */
export interface DetectText extends Binding.Service<
  DetectText,
  "AWS.Rekognition.DetectText",
  () => Effect.Effect<
    (
      request: rekognition.DetectTextRequest,
    ) => Effect.Effect<
      rekognition.DetectTextResponse,
      rekognition.DetectTextError
    >
  >
> {}
export const DetectText = Binding.Service<DetectText>(
  "AWS.Rekognition.DetectText",
);
