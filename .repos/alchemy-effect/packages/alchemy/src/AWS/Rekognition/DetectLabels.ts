import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DetectLabels` — detect real-world
 * entities (objects, scenes, concepts) in a JPEG or PNG image.
 *
 * Rekognition is a pure pay-per-call service with no resource to manage:
 * the binding takes no arguments and grants the function
 * `rekognition:DetectLabels` (the action has no resource-level IAM).
 * Pass the image as raw bytes (`Image.Bytes`) or as an S3 object
 * reference (`Image.S3Object`) — raw distilled types, no marshalling.
 * Provide the implementation with
 * `Effect.provide(AWS.Rekognition.DetectLabelsHttp)`.
 *
 * @binding
 * @section Detecting Labels
 * @example Detect Labels in Image Bytes
 * ```typescript
 * // init
 * const detectLabels = yield* AWS.Rekognition.DetectLabels();
 *
 * // runtime
 * const result = yield* detectLabels({
 *   Image: { Bytes: imageBytes },
 *   MaxLabels: 10,
 *   MinConfidence: 50,
 * });
 * const names = (result.Labels ?? []).map((label) => label.Name);
 * ```
 */
export interface DetectLabels extends Binding.Service<
  DetectLabels,
  "AWS.Rekognition.DetectLabels",
  () => Effect.Effect<
    (
      request: rekognition.DetectLabelsRequest,
    ) => Effect.Effect<
      rekognition.DetectLabelsResponse,
      rekognition.DetectLabelsError
    >
  >
> {}
export const DetectLabels = Binding.Service<DetectLabels>(
  "AWS.Rekognition.DetectLabels",
);
