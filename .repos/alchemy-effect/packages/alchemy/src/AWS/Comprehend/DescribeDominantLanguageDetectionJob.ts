import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DescribeDominantLanguageDetectionJob` — get the
 * properties (status, input/output config, timings) of an asynchronous
 * dominant-language detection job started with {@link StartDominantLanguageDetectionJob}.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example Poll a DominantLanguageDetection Job
 * ```typescript
 * // init
 * const describeDominantLanguageDetectionJob = yield* AWS.Comprehend.DescribeDominantLanguageDetectionJob();
 *
 * // runtime
 * const job = yield* describeDominantLanguageDetectionJob({ JobId: jobId });
 * // job.DominantLanguageDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
 * ```
 */
export interface DescribeDominantLanguageDetectionJob extends Binding.Service<
  DescribeDominantLanguageDetectionJob,
  "AWS.Comprehend.DescribeDominantLanguageDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.DescribeDominantLanguageDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.DescribeDominantLanguageDetectionJobResponse,
      comprehend.DescribeDominantLanguageDetectionJobError
    >
  >
> {}
export const DescribeDominantLanguageDetectionJob =
  Binding.Service<DescribeDominantLanguageDetectionJob>(
    "AWS.Comprehend.DescribeDominantLanguageDetectionJob",
  );
