import type * as signer from "@distilled.cloud/aws/signer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `signer:DescribeSigningJob`.
 *
 * Reads a signing job by the `jobId` returned from `StartSigningJob` /
 * `SignPayload` — its status (`InProgress`, `Succeeded`, `Failed`), the
 * signed object's S3 location, and the signature expiry. Account-level
 * operation — job ids are chosen per request at runtime, so the binding takes
 * no resource argument. Provide the implementation with
 * `Effect.provide(AWS.Signer.DescribeSigningJobHttp)`.
 * @binding
 * @section Observing Signing Jobs
 * @example Wait for a Job to Finish
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeSigningJob = yield* AWS.Signer.DescribeSigningJob();
 *
 * // runtime
 * const job = yield* describeSigningJob({ jobId });
 * const signedKey = job.signedObject?.s3?.key;
 * ```
 */
export interface DescribeSigningJob extends Binding.Service<
  DescribeSigningJob,
  "AWS.Signer.DescribeSigningJob",
  () => Effect.Effect<
    (
      request: signer.DescribeSigningJobRequest,
    ) => Effect.Effect<
      signer.DescribeSigningJobResponse,
      signer.DescribeSigningJobError
    >
  >
> {}
export const DescribeSigningJob = Binding.Service<DescribeSigningJob>(
  "AWS.Signer.DescribeSigningJob",
);
