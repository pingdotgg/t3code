import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediaconvert:ListJobs` — list your most recent
 * transcode jobs from runtime code, optionally filtered by queue or status.
 *
 * The binding takes no arguments and grants `mediaconvert:ListJobs` on `*`.
 * Provide the implementation with
 * `Effect.provide(AWS.MediaConvert.ListJobsHttp)`.
 *
 * @binding
 * @section Tracking Jobs
 * @example List In-Flight Jobs
 * ```typescript
 * // init
 * const listJobs = yield* AWS.MediaConvert.ListJobs();
 *
 * // runtime
 * const { Jobs } = yield* listJobs({ Status: "PROGRESSING" });
 * ```
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "AWS.MediaConvert.ListJobs",
  () => Effect.Effect<
    (
      request?: mediaconvert.ListJobsRequest,
    ) => Effect.Effect<
      mediaconvert.ListJobsResponse,
      mediaconvert.ListJobsError
    >
  >
> {}
export const ListJobs = Binding.Service<ListJobs>("AWS.MediaConvert.ListJobs");
