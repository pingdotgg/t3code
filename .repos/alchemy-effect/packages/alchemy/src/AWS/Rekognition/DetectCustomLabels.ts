import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DetectCustomLabels` — detect custom labels in an image using a trained and running Rekognition Custom Labels model version.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DetectCustomLabels` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DetectCustomLabelsHttp)`.
 *
 * @binding
 * @section Custom Labels
 * @example Detect Custom Labels
 * ```typescript
 * // init
 * const detectCustomLabels = yield* AWS.Rekognition.DetectCustomLabels();
 *
 * // runtime
 * const result = yield* detectCustomLabels({
 *   ProjectVersionArn: modelArn,
 *   Image: { Bytes: imageBytes },
 *   MinConfidence: 70,
 * });
 * const labels = (result.CustomLabels ?? []).map((l) => l.Name);
 * ```
 */
export interface DetectCustomLabels extends Binding.Service<
  DetectCustomLabels,
  "AWS.Rekognition.DetectCustomLabels",
  () => Effect.Effect<
    (
      request: rekognition.DetectCustomLabelsRequest,
    ) => Effect.Effect<
      rekognition.DetectCustomLabelsResponse,
      rekognition.DetectCustomLabelsError
    >
  >
> {}
export const DetectCustomLabels = Binding.Service<DetectCustomLabels>(
  "AWS.Rekognition.DetectCustomLabels",
);
