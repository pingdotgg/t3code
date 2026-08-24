import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:GetCelebrityRecognition` — get the results of an asynchronous celebrities detection job started by StartCelebrityRecognition.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetCelebrityRecognition` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetCelebrityRecognitionHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Poll Celebrity Recognition Results
 * ```typescript
 * // init
 * const getCelebrityRecognition = yield* AWS.Rekognition.GetCelebrityRecognition();
 *
 * // runtime
 * const results = yield* getCelebrityRecognition({ JobId: jobId });
 * if (results.JobStatus === "SUCCEEDED") {
 *   // consume the detections
 * }
 * ```
 */
export interface GetCelebrityRecognition extends Binding.Service<
  GetCelebrityRecognition,
  "AWS.Rekognition.GetCelebrityRecognition",
  () => Effect.Effect<
    (
      request: rekognition.GetCelebrityRecognitionRequest,
    ) => Effect.Effect<
      rekognition.GetCelebrityRecognitionResponse,
      rekognition.GetCelebrityRecognitionError
    >
  >
> {}
export const GetCelebrityRecognition = Binding.Service<GetCelebrityRecognition>(
  "AWS.Rekognition.GetCelebrityRecognition",
);
