import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DescribeEventsDetectionJob` — get the
 * properties (status, input/output config, timings) of an asynchronous
 * event detection job started with {@link StartEventsDetectionJob}.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example Poll a EventsDetection Job
 * ```typescript
 * // init
 * const describeEventsDetectionJob = yield* AWS.Comprehend.DescribeEventsDetectionJob();
 *
 * // runtime
 * const job = yield* describeEventsDetectionJob({ JobId: jobId });
 * // job.EventsDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
 * ```
 */
export interface DescribeEventsDetectionJob extends Binding.Service<
  DescribeEventsDetectionJob,
  "AWS.Comprehend.DescribeEventsDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.DescribeEventsDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.DescribeEventsDetectionJobResponse,
      comprehend.DescribeEventsDetectionJobError
    >
  >
> {}
export const DescribeEventsDetectionJob =
  Binding.Service<DescribeEventsDetectionJob>(
    "AWS.Comprehend.DescribeEventsDetectionJob",
  );
