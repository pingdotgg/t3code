import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DetectModerationLabels` — detect unsafe or inappropriate content (explicit nudity, violence, etc.) in an image for content moderation.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DetectModerationLabels` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DetectModerationLabelsHttp)`.
 *
 * @binding
 * @section Image Analysis
 * @example Moderate an Uploaded Image
 * ```typescript
 * // init
 * const detectModerationLabels = yield* AWS.Rekognition.DetectModerationLabels();
 *
 * // runtime
 * const result = yield* detectModerationLabels({
 *   Image: { Bytes: imageBytes },
 *   MinConfidence: 60,
 * });
 * const flagged = (result.ModerationLabels ?? []).length > 0;
 * ```
 */
export interface DetectModerationLabels extends Binding.Service<
  DetectModerationLabels,
  "AWS.Rekognition.DetectModerationLabels",
  () => Effect.Effect<
    (
      request: rekognition.DetectModerationLabelsRequest,
    ) => Effect.Effect<
      rekognition.DetectModerationLabelsResponse,
      rekognition.DetectModerationLabelsError
    >
  >
> {}
export const DetectModerationLabels = Binding.Service<DetectModerationLabels>(
  "AWS.Rekognition.DetectModerationLabels",
);
