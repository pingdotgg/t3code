import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:GetPersonTracking` — get the results of an asynchronous the path of persons detection job started by StartPersonTracking.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetPersonTracking` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetPersonTrackingHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Poll Person Tracking Results
 * ```typescript
 * // init
 * const getPersonTracking = yield* AWS.Rekognition.GetPersonTracking();
 *
 * // runtime
 * const results = yield* getPersonTracking({ JobId: jobId });
 * if (results.JobStatus === "SUCCEEDED") {
 *   // consume the detections
 * }
 * ```
 */
export interface GetPersonTracking extends Binding.Service<
  GetPersonTracking,
  "AWS.Rekognition.GetPersonTracking",
  () => Effect.Effect<
    (
      request: rekognition.GetPersonTrackingRequest,
    ) => Effect.Effect<
      rekognition.GetPersonTrackingResponse,
      rekognition.GetPersonTrackingError
    >
  >
> {}
export const GetPersonTracking = Binding.Service<GetPersonTracking>(
  "AWS.Rekognition.GetPersonTracking",
);
