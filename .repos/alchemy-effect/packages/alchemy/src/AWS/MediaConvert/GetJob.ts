import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediaconvert:GetJob` — poll the status and full JSON
 * of a submitted transcode job from runtime code.
 *
 * Job ids are server-assigned at runtime, so the binding takes no arguments
 * and grants `mediaconvert:GetJob` on `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaConvert.GetJobHttp)`.
 *
 * @binding
 * @section Tracking Jobs
 * @example Poll a Job's Status
 * ```typescript
 * // init
 * const getJob = yield* AWS.MediaConvert.GetJob();
 *
 * // runtime
 * const { Job } = yield* getJob({ Id: jobId });
 * if (Job?.Status === "COMPLETE") { ... }
 * ```
 */
export interface GetJob extends Binding.Service<
  GetJob,
  "AWS.MediaConvert.GetJob",
  () => Effect.Effect<
    (
      request: mediaconvert.GetJobRequest,
    ) => Effect.Effect<mediaconvert.GetJobResponse, mediaconvert.GetJobError>
  >
> {}
export const GetJob = Binding.Service<GetJob>("AWS.MediaConvert.GetJob");
