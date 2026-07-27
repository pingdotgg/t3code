import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `translate:StopTextTranslationJob` — stop an
 * asynchronous batch translation job that is in progress. An `IN_PROGRESS`
 * job is marked `STOP_REQUESTED` and later `STOPPED`; a job that completes
 * first ends `COMPLETED`.
 *
 * @binding
 * @section Batch Translation Jobs
 * @example Stop a batch translation job
 * ```typescript
 * // init
 * const stopJob = yield* AWS.Translate.StopTextTranslationJob();
 *
 * // runtime
 * const result = yield* stopJob({ JobId: job.JobId! });
 * // result.JobStatus === "STOP_REQUESTED"
 * ```
 */
export interface StopTextTranslationJob extends Binding.Service<
  StopTextTranslationJob,
  "AWS.Translate.StopTextTranslationJob",
  () => Effect.Effect<
    (
      request: translate.StopTextTranslationJobRequest,
    ) => Effect.Effect<
      translate.StopTextTranslationJobResponse,
      translate.StopTextTranslationJobError
    >
  >
> {}
export const StopTextTranslationJob = Binding.Service<StopTextTranslationJob>(
  "AWS.Translate.StopTextTranslationJob",
);
