import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:GetLabelDetection` — get the results of an asynchronous labels detection job started by StartLabelDetection.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetLabelDetection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetLabelDetectionHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Poll Label Detection Results
 * ```typescript
 * // init
 * const getLabelDetection = yield* AWS.Rekognition.GetLabelDetection();
 *
 * // runtime
 * const results = yield* getLabelDetection({ JobId: jobId });
 * if (results.JobStatus === "SUCCEEDED") {
 *   // consume the detections
 * }
 * ```
 */
export interface GetLabelDetection extends Binding.Service<
  GetLabelDetection,
  "AWS.Rekognition.GetLabelDetection",
  () => Effect.Effect<
    (
      request: rekognition.GetLabelDetectionRequest,
    ) => Effect.Effect<
      rekognition.GetLabelDetectionResponse,
      rekognition.GetLabelDetectionError
    >
  >
> {}
export const GetLabelDetection = Binding.Service<GetLabelDetection>(
  "AWS.Rekognition.GetLabelDetection",
);
