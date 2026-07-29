import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:ListMediaAnalysisJobs` — list the media analysis jobs in the account.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:ListMediaAnalysisJobs` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.ListMediaAnalysisJobsHttp)`.
 *
 * @binding
 * @section Media Analysis Jobs
 * @example List Media Analysis Jobs
 * ```typescript
 * // init
 * const listMediaAnalysisJobs = yield* AWS.Rekognition.ListMediaAnalysisJobs();
 *
 * // runtime
 * const page = yield* listMediaAnalysisJobs({ MaxResults: 10 });
 * // page.MediaAnalysisJobs
 * ```
 */
export interface ListMediaAnalysisJobs extends Binding.Service<
  ListMediaAnalysisJobs,
  "AWS.Rekognition.ListMediaAnalysisJobs",
  () => Effect.Effect<
    (
      request?: rekognition.ListMediaAnalysisJobsRequest,
    ) => Effect.Effect<
      rekognition.ListMediaAnalysisJobsResponse,
      rekognition.ListMediaAnalysisJobsError
    >
  >
> {}
export const ListMediaAnalysisJobs = Binding.Service<ListMediaAnalysisJobs>(
  "AWS.Rekognition.ListMediaAnalysisJobs",
);
