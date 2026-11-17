import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `mediaconvert:GetJobsQueryResults` — fetch the results
 * of an asynchronous jobs query started with {@link StartJobsQuery}.
 *
 * The binding takes no arguments and grants
 * `mediaconvert:GetJobsQueryResults` on `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaConvert.GetJobsQueryResultsHttp)`.
 *
 * ### Tracking Jobs
 * **Example:** Fetch Query Results
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
 *
 * @binding
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
