import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:GetSegmentDetection` — get the results of an asynchronous technical cues and shot segments detection job started by StartSegmentDetection.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetSegmentDetection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetSegmentDetectionHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Poll Segment Detection Results
 * ```typescript
 * // init
 * const getSegmentDetection = yield* AWS.Rekognition.GetSegmentDetection();
 *
 * // runtime
 * const results = yield* getSegmentDetection({ JobId: jobId });
 * if (results.JobStatus === "SUCCEEDED") {
 *   // consume the detections
 * }
 * ```
 */
export interface GetSegmentDetection extends Binding.Service<
  GetSegmentDetection,
  "AWS.Rekognition.GetSegmentDetection",
  () => Effect.Effect<
    (
      request: rekognition.GetSegmentDetectionRequest,
    ) => Effect.Effect<
      rekognition.GetSegmentDetectionResponse,
      rekognition.GetSegmentDetectionError
    >
  >
> {}
export const GetSegmentDetection = Binding.Service<GetSegmentDetection>(
  "AWS.Rekognition.GetSegmentDetection",
);
