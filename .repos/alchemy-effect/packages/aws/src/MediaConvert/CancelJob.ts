import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `mediaconvert:CancelJob` — permanently cancel a
 * submitted transcode job that has not finished (canceled jobs cannot be
 * restarted).
 *
 * Job ids are server-assigned at runtime, so the binding takes no arguments
 * and grants `mediaconvert:CancelJob` on `*`. Provide the implementation
 * with `Effect.provide(AWS.MediaConvert.CancelJobHttp)`.
 *
 * ### Tracking Jobs
 * **Example:** Cancel an In-Flight Job
 * ```typescript
 * // init
 * const cancelJob = yield* AWS.MediaConvert.CancelJob();
 *
 * // runtime
 * yield* cancelJob({ Id: jobId }).pipe(
 *   // already finished / already gone — nothing to cancel
 *   Effect.catchTag(["NotFoundException", "ConflictException"], () => Effect.void),
 * );
 * ```
 *
 * @binding
 */
export interface CancelJob extends Binding.Service<
  CancelJob,
  "AWS.MediaConvert.CancelJob",
  () => Effect.Effect<
    (
      request: mediaconvert.CancelJobRequest,
    ) => Effect.Effect<mediaconvert.CancelJobResponse, mediaconvert.CancelJobError>
  >
> {}
export const CancelJob = Binding.Service<CancelJob>("AWS.MediaConvert.CancelJob");
