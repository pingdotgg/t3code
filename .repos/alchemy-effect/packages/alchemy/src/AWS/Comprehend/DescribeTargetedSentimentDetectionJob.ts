import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DescribeTargetedSentimentDetectionJob` — get the
 * properties (status, input/output config, timings) of an asynchronous
 * targeted-sentiment detection job started with {@link StartTargetedSentimentDetectionJob}.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example Poll a TargetedSentimentDetection Job
 * ```typescript
 * // init
 * const describeTargetedSentimentDetectionJob = yield* AWS.Comprehend.DescribeTargetedSentimentDetectionJob();
 *
 * // runtime
 * const job = yield* describeTargetedSentimentDetectionJob({ JobId: jobId });
 * // job.TargetedSentimentDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
 * ```
 */
export interface DescribeTargetedSentimentDetectionJob extends Binding.Service<
  DescribeTargetedSentimentDetectionJob,
  "AWS.Comprehend.DescribeTargetedSentimentDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.DescribeTargetedSentimentDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.DescribeTargetedSentimentDetectionJobResponse,
      comprehend.DescribeTargetedSentimentDetectionJobError
    >
  >
> {}
export const DescribeTargetedSentimentDetectionJob =
  Binding.Service<DescribeTargetedSentimentDetectionJob>(
    "AWS.Comprehend.DescribeTargetedSentimentDetectionJob",
  );
