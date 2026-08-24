import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:GetContentModeration` — get the results of an asynchronous inappropriate or offensive content detection job started by StartContentModeration.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetContentModeration` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetContentModerationHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Poll Content Moderation Results
 * ```typescript
 * // init
 * const getContentModeration = yield* AWS.Rekognition.GetContentModeration();
 *
 * // runtime
 * const results = yield* getContentModeration({ JobId: jobId });
 * if (results.JobStatus === "SUCCEEDED") {
 *   // consume the detections
 * }
 * ```
 */
export interface GetContentModeration extends Binding.Service<
  GetContentModeration,
  "AWS.Rekognition.GetContentModeration",
  () => Effect.Effect<
    (
      request: rekognition.GetContentModerationRequest,
    ) => Effect.Effect<
      rekognition.GetContentModerationResponse,
      rekognition.GetContentModerationError
    >
  >
> {}
export const GetContentModeration = Binding.Service<GetContentModeration>(
  "AWS.Rekognition.GetContentModeration",
);
