import type * as batch from "@distilled.cloud/aws/batch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { JobQueue } from "./JobQueue.ts";

export interface DescribeJobsRequest extends batch.DescribeJobsRequest {}

/**
 * Describe submitted AWS Batch jobs (status polling from runtime code).
 * `batch:DescribeJobs` has no resource-level IAM, so the policy is
 * service-scoped; the queue anchors the binding's identity.
 *
 * @binding
 * @section Describing Jobs
 * @example Poll a job's status
 * ```typescript
 * const describeJobs = yield* Batch.DescribeJobs(queue);
 * const { jobs } = yield* describeJobs({ jobs: [jobId] });
 * const status = jobs?.[0]?.status;
 * ```
 */
export interface DescribeJobs extends Binding.Service<
  DescribeJobs,
  "AWS.Batch.DescribeJobs",
  (
    queue: JobQueue,
  ) => Effect.Effect<
    (
      request: DescribeJobsRequest,
    ) => Effect.Effect<batch.DescribeJobsResponse, batch.DescribeJobsError>
  >
> {}
export const DescribeJobs = Binding.Service<DescribeJobs>(
  "AWS.Batch.DescribeJobs",
);
