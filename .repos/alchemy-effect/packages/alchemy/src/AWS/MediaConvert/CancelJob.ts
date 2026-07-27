import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediaconvert:CancelJob` — permanently cancel a
 * submitted transcode job that has not finished (canceled jobs cannot be
 * restarted).
 *
 * Job ids are server-assigned at runtime, so the binding takes no arguments
 * and grants `mediaconvert:CancelJob` on `*`. Provide the implementation
 * with `Effect.provide(AWS.MediaConvert.CancelJobHttp)`.
 *
 * @binding
 * @section Tracking Jobs
 * @example Cancel an In-Flight Job
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
 */
export interface CancelJob extends Binding.Service<
  CancelJob,
  "AWS.MediaConvert.CancelJob",
  () => Effect.Effect<
    (
      request: mediaconvert.CancelJobRequest,
    ) => Effect.Effect<
      mediaconvert.CancelJobResponse,
      mediaconvert.CancelJobError
    >
  >
> {}
export const CancelJob = Binding.Service<CancelJob>(
  "AWS.MediaConvert.CancelJob",
);
