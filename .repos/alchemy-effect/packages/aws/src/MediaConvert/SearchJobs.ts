import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `mediaconvert:SearchJobs` — search your recent
 * transcode jobs by input file, queue, or status from runtime code (e.g.
 * "did we already transcode this upload?").
 *
 * The binding takes no arguments and grants `mediaconvert:SearchJobs` on
 * `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaConvert.SearchJobsHttp)`.
 *
 * ### Tracking Jobs
 * **Example:** Find Jobs for an Input File
 * ```typescript
 * // init
 * const searchJobs = yield* AWS.MediaConvert.SearchJobs();
 *
 * // runtime
 * const { Jobs } = yield* searchJobs({
 *   InputFile: `s3://${bucket}/${key}`,
 *   Status: "COMPLETE",
 * });
 * ```
 *
 * @binding
 */
export interface SearchJobs extends Binding.Service<
  SearchJobs,
  "AWS.MediaConvert.SearchJobs",
  () => Effect.Effect<
    (
      request?: mediaconvert.SearchJobsRequest,
    ) => Effect.Effect<mediaconvert.SearchJobsResponse, mediaconvert.SearchJobsError>
  >
> {}
export const SearchJobs = Binding.Service<SearchJobs>("AWS.MediaConvert.SearchJobs");
