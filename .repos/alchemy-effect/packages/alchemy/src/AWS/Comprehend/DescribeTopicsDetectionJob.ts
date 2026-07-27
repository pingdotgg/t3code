import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DescribeTopicsDetectionJob` — get the
 * properties (status, input/output config, timings) of an asynchronous
 * topic modeling job started with {@link StartTopicsDetectionJob}.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example Poll a TopicsDetection Job
 * ```typescript
 * // init
 * const describeTopicsDetectionJob = yield* AWS.Comprehend.DescribeTopicsDetectionJob();
 *
 * // runtime
 * const job = yield* describeTopicsDetectionJob({ JobId: jobId });
 * // job.TopicsDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
 * ```
 */
export interface DescribeTopicsDetectionJob extends Binding.Service<
  DescribeTopicsDetectionJob,
  "AWS.Comprehend.DescribeTopicsDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.DescribeTopicsDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.DescribeTopicsDetectionJobResponse,
      comprehend.DescribeTopicsDetectionJobError
    >
  >
> {}
export const DescribeTopicsDetectionJob =
  Binding.Service<DescribeTopicsDetectionJob>(
    "AWS.Comprehend.DescribeTopicsDetectionJob",
  );
