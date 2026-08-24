import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DescribeSentimentDetectionJob` — get the
 * properties (status, input/output config, timings) of an asynchronous
 * sentiment detection job started with {@link StartSentimentDetectionJob}.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example Poll a SentimentDetection Job
 * ```typescript
 * // init
 * const describeSentimentDetectionJob = yield* AWS.Comprehend.DescribeSentimentDetectionJob();
 *
 * // runtime
 * const job = yield* describeSentimentDetectionJob({ JobId: jobId });
 * // job.SentimentDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
 * ```
 */
export interface DescribeSentimentDetectionJob extends Binding.Service<
  DescribeSentimentDetectionJob,
  "AWS.Comprehend.DescribeSentimentDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.DescribeSentimentDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.DescribeSentimentDetectionJobResponse,
      comprehend.DescribeSentimentDetectionJobError
    >
  >
> {}
export const DescribeSentimentDetectionJob =
  Binding.Service<DescribeSentimentDetectionJob>(
    "AWS.Comprehend.DescribeSentimentDetectionJob",
  );
