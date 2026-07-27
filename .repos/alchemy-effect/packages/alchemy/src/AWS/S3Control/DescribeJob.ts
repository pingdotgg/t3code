import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as sts from "@distilled.cloud/aws/sts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `s3:DescribeJob` (S3 Batch Operations).
 *
 * Reads an S3 Batch Operations job's configuration, status and progress
 * summary — e.g. a controller polling a bulk copy it submitted with
 * {@link CreateJob}. The account id is resolved once via
 * `sts:GetCallerIdentity`. Provide the implementation with
 * `Effect.provide(AWS.S3Control.DescribeJobHttp)`.
 * @binding
 * @section Running Batch Operations Jobs
 * @example Poll a Job's Status
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeJob = yield* AWS.S3Control.DescribeJob();
 *
 * // runtime
 * const { Job } = yield* describeJob({ JobId: jobId });
 * // Job?.Status === "Complete"
 * ```
 */
export interface DescribeJob extends Binding.Service<
  DescribeJob,
  "AWS.S3Control.DescribeJob",
  () => Effect.Effect<
    (
      request: Omit<s3control.DescribeJobRequest, "AccountId">,
    ) => Effect.Effect<
      s3control.DescribeJobResult,
      s3control.DescribeJobError | sts.GetCallerIdentityError
    >
  >
> {}
export const DescribeJob = Binding.Service<DescribeJob>(
  "AWS.S3Control.DescribeJob",
);
