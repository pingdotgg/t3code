import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as sts from "@distilled.cloud/aws/sts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `s3:UpdateJobStatus` (S3 Batch Operations).
 *
 * Confirms a suspended job so it runs (`Ready`) or cancels it
 * (`Cancelled`) — e.g. an approval workflow that releases a bulk delete
 * only after a human signs off. The account id is resolved once via
 * `sts:GetCallerIdentity`. Provide the implementation with
 * `Effect.provide(AWS.S3Control.UpdateJobStatusHttp)`.
 * @binding
 * @section Running Batch Operations Jobs
 * @example Cancel a Job
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateJobStatus = yield* AWS.S3Control.UpdateJobStatus();
 *
 * // runtime
 * yield* updateJobStatus({
 *   JobId: jobId,
 *   RequestedJobStatus: "Cancelled",
 *   StatusUpdateReason: "superseded by newer manifest",
 * });
 * ```
 */
export interface UpdateJobStatus extends Binding.Service<
  UpdateJobStatus,
  "AWS.S3Control.UpdateJobStatus",
  () => Effect.Effect<
    (
      request: Omit<s3control.UpdateJobStatusRequest, "AccountId">,
    ) => Effect.Effect<
      s3control.UpdateJobStatusResult,
      s3control.UpdateJobStatusError | sts.GetCallerIdentityError
    >
  >
> {}
export const UpdateJobStatus = Binding.Service<UpdateJobStatus>(
  "AWS.S3Control.UpdateJobStatus",
);
