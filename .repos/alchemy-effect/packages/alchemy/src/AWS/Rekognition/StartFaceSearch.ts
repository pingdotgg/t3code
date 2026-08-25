import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartFaceSearch` — start an asynchronous search of a stored video for faces matching a face collection.
 *
 * Rekognition Video jobs read the video from S3 and run asynchronously —
 * poll the paired `Get*` binding with the returned `JobId`, or pass a
 * `NotificationChannel` (SNS topic + IAM role the caller must be allowed
 * to pass) to be notified on completion.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartFaceSearch` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartFaceSearchHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Start a Video Face Search
 * ```typescript
 * // init
 * const startFaceSearch = yield* AWS.Rekognition.StartFaceSearch();
 *
 * // runtime
 * const started = yield* startFaceSearch({
 *   Video: { S3Object: { Bucket: "videos", Name: "lobby.mp4" } },
 *   CollectionId: "tenant-42",
 * });
 * // started.JobId
 * ```
 */
export interface StartFaceSearch extends Binding.Service<
  StartFaceSearch,
  "AWS.Rekognition.StartFaceSearch",
  () => Effect.Effect<
    (
      request: rekognition.StartFaceSearchRequest,
    ) => Effect.Effect<
      rekognition.StartFaceSearchResponse,
      rekognition.StartFaceSearchError
    >
  >
> {}
export const StartFaceSearch = Binding.Service<StartFaceSearch>(
  "AWS.Rekognition.StartFaceSearch",
);
