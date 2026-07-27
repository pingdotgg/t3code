import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

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
 * @binding
 * @section Tracking Jobs
 * @example Query Errored Jobs
 * ```typescript
 * // init
 * const startJobsQuery = yield* AWS.MediaConvert.StartJobsQuery();
 *
 * // runtime
 * const { Id } = yield* startJobsQuery({
 *   FilterList: [{ Type: "STATUS", Inputs: ["ERROR"] }],
 * });
 * ```
 */
export interface StartJobsQuery extends Binding.Service<
  StartJobsQuery,
  "AWS.MediaConvert.StartJobsQuery",
  () => Effect.Effect<
    (
      request?: mediaconvert.StartJobsQueryRequest,
    ) => Effect.Effect<
      mediaconvert.StartJobsQueryResponse,
      mediaconvert.StartJobsQueryError
    >
  >
> {}
export const StartJobsQuery = Binding.Service<StartJobsQuery>(
  "AWS.MediaConvert.StartJobsQuery",
);
