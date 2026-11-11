import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `mediaconvert:GetJob` — poll the status and full JSON
 * of a submitted transcode job from runtime code.
 *
 * Job ids are server-assigned at runtime, so the binding takes no arguments
 * and grants `mediaconvert:GetJob` on `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaConvert.GetJobHttp)`.
 *
 * ### Tracking Jobs
 * **Example:** Poll a Job's Status
 * ```typescript
 * // init
 * const getJob = yield* AWS.MediaConvert.GetJob();
 *
 * // runtime
 * const { Job } = yield* getJob({ Id: jobId });
 * if (Job?.Status === "COMPLETE") { ... }
 * ```
 *
 * @binding
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
