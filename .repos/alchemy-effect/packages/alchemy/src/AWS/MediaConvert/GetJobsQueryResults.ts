import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediaconvert:GetJobsQueryResults` — fetch the results
 * of an asynchronous jobs query started with {@link StartJobsQuery}.
 *
 * The binding takes no arguments and grants
 * `mediaconvert:GetJobsQueryResults` on `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaConvert.GetJobsQueryResultsHttp)`.
 *
 * @binding
 * @section Tracking Jobs
 * @example Fetch Query Results
 * ```typescript
 * // init
 * const getJobsQueryResults = yield* AWS.MediaConvert.GetJobsQueryResults();
 *
 * // runtime
 * const results = yield* getJobsQueryResults({ Id: queryId });
 * if (results.Status === "COMPLETE") {
 *   const jobs = results.Jobs ?? [];
 * }
 * ```
 */
export interface GetJobsQueryResults extends Binding.Service<
  GetJobsQueryResults,
  "AWS.MediaConvert.GetJobsQueryResults",
  () => Effect.Effect<
    (
      request: mediaconvert.GetJobsQueryResultsRequest,
    ) => Effect.Effect<
      mediaconvert.GetJobsQueryResultsResponse,
      mediaconvert.GetJobsQueryResultsError
    >
  >
> {}
export const GetJobsQueryResults = Binding.Service<GetJobsQueryResults>(
  "AWS.MediaConvert.GetJobsQueryResults",
);
