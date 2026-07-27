import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DescribeKeyPhrasesDetectionJob` — get the
 * properties (status, input/output config, timings) of an asynchronous
 * key-phrase detection job started with {@link StartKeyPhrasesDetectionJob}.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example Poll a KeyPhrasesDetection Job
 * ```typescript
 * // init
 * const describeKeyPhrasesDetectionJob = yield* AWS.Comprehend.DescribeKeyPhrasesDetectionJob();
 *
 * // runtime
 * const job = yield* describeKeyPhrasesDetectionJob({ JobId: jobId });
 * // job.KeyPhrasesDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
 * ```
 */
export interface DescribeKeyPhrasesDetectionJob extends Binding.Service<
  DescribeKeyPhrasesDetectionJob,
  "AWS.Comprehend.DescribeKeyPhrasesDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.DescribeKeyPhrasesDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.DescribeKeyPhrasesDetectionJobResponse,
      comprehend.DescribeKeyPhrasesDetectionJobError
    >
  >
> {}
export const DescribeKeyPhrasesDetectionJob =
  Binding.Service<DescribeKeyPhrasesDetectionJob>(
    "AWS.Comprehend.DescribeKeyPhrasesDetectionJob",
  );
