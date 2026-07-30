import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as sts from "@distilled.cloud/aws/sts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `s3:UpdateJobPriority` (S3 Batch Operations).
 *
 * Re-prioritizes an existing job relative to the account's other jobs —
 * e.g. bumping an urgent restore ahead of routine re-tagging runs. The
 * account id is resolved once via `sts:GetCallerIdentity`. Provide the
 * implementation with `Effect.provide(AWS.S3Control.UpdateJobPriorityHttp)`.
 * @binding
 * @section Running Batch Operations Jobs
 * @example Bump a Job's Priority
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateJobPriority = yield* AWS.S3Control.UpdateJobPriority();
 *
 * // runtime
 * const updated = yield* updateJobPriority({ JobId: jobId, Priority: 10 });
 * // updated.Priority === 10
 * ```
 */
export interface UpdateJobPriority extends Binding.Service<
  UpdateJobPriority,
  "AWS.S3Control.UpdateJobPriority",
  () => Effect.Effect<
    (
      request: Omit<s3control.UpdateJobPriorityRequest, "AccountId">,
    ) => Effect.Effect<
      s3control.UpdateJobPriorityResult,
      s3control.UpdateJobPriorityError | sts.GetCallerIdentityError
    >
  >
> {}
export const UpdateJobPriority = Binding.Service<UpdateJobPriority>(
  "AWS.S3Control.UpdateJobPriority",
);
