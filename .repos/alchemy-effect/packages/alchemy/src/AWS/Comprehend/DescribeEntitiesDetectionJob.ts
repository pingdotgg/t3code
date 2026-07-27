import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DescribeEntitiesDetectionJob` — get the
 * properties (status, input/output config, timings) of an asynchronous
 * entity detection job started with {@link StartEntitiesDetectionJob}.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example Poll a EntitiesDetection Job
 * ```typescript
 * // init
 * const describeEntitiesDetectionJob = yield* AWS.Comprehend.DescribeEntitiesDetectionJob();
 *
 * // runtime
 * const job = yield* describeEntitiesDetectionJob({ JobId: jobId });
 * // job.EntitiesDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
 * ```
 */
export interface DescribeEntitiesDetectionJob extends Binding.Service<
  DescribeEntitiesDetectionJob,
  "AWS.Comprehend.DescribeEntitiesDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.DescribeEntitiesDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.DescribeEntitiesDetectionJobResponse,
      comprehend.DescribeEntitiesDetectionJobError
    >
  >
> {}
export const DescribeEntitiesDetectionJob =
  Binding.Service<DescribeEntitiesDetectionJob>(
    "AWS.Comprehend.DescribeEntitiesDetectionJob",
  );
