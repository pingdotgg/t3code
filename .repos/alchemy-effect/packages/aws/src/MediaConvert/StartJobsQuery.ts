import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `mediaconvert:StartJobsQuery` — start an asynchronous,
 * filtered query over your job history (the async counterpart of
 * `SearchJobs` for larger result sets). Retrieve the results with
 * {@link GetJobsQueryResults} using the returned query `Id`.
 *
 * The binding takes no arguments and grants `mediaconvert:StartJobsQuery`
 * on `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaConvert.StartJobsQueryHttp)`.
 *
 * ### Tracking Jobs
 * **Example:** Query Errored Jobs
 * ```typescript
 * // init
 * const startJobsQuery = yield* AWS.MediaConvert.StartJobsQuery();
 *
 * // runtime
 * const { Id } = yield* startJobsQuery({
 *   FilterList: [{ Type: "STATUS", Inputs: ["ERROR"] }],
 * });
 * ```
 *
 * @binding
 */
export interface StartJobsQuery extends Binding.Service<
  StartJobsQuery,
  "AWS.MediaConvert.StartJobsQuery",
  () => Effect.Effect<
    (
      request?: mediaconvert.StartJobsQueryRequest,
    ) => Effect.Effect<mediaconvert.StartJobsQueryResponse, mediaconvert.StartJobsQueryError>
  >
> {}
export const StartJobsQuery = Binding.Service<StartJobsQuery>("AWS.MediaConvert.StartJobsQuery");
