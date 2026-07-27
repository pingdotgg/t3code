import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:GetFaceLivenessSessionResults` — get the confidence score, status, and audit images of a completed Face Liveness session.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetFaceLivenessSessionResults` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetFaceLivenessSessionResultsHttp)`.
 *
 * @binding
 * @section Face Liveness
 * @example Fetch Liveness Results
 * ```typescript
 * // init
 * const getFaceLivenessSessionResults = yield* AWS.Rekognition.GetFaceLivenessSessionResults();
 *
 * // runtime
 * const results = yield* getFaceLivenessSessionResults({
 *   SessionId: sessionId,
 * });
 * const isLive = results.Status === "SUCCEEDED" && (results.Confidence ?? 0) > 80;
 * ```
 */
export interface GetFaceLivenessSessionResults extends Binding.Service<
  GetFaceLivenessSessionResults,
  "AWS.Rekognition.GetFaceLivenessSessionResults",
  () => Effect.Effect<
    (
      request: rekognition.GetFaceLivenessSessionResultsRequest,
    ) => Effect.Effect<
      rekognition.GetFaceLivenessSessionResultsResponse,
      rekognition.GetFaceLivenessSessionResultsError
    >
  >
> {}
export const GetFaceLivenessSessionResults =
  Binding.Service<GetFaceLivenessSessionResults>(
    "AWS.Rekognition.GetFaceLivenessSessionResults",
  );
