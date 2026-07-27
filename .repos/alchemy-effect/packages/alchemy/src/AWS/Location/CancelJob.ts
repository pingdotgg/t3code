import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Cancels a running Location batch metadata job.
 *
 * Runtime binding for the `CancelJob` operation (IAM action
 * `geo:CancelJob`), account-scoped — batch jobs are created at runtime so the
 * grant is on `*`. Provide the implementation with
 * `Effect.provide(AWS.Location.CancelJobHttp)`.
 *
 * @binding
 * @section Managing Batch Jobs
 * @example Cancel a Batch Job
 * ```typescript
 * const cancelJob = yield* Location.CancelJob();
 *
 * yield* cancelJob({ JobId: jobId });
 * ```
 */
export interface CancelJob extends Binding.Service<
  CancelJob,
  "AWS.Location.CancelJob",
  () => Effect.Effect<
    (
      request: location.CancelJobRequest,
    ) => Effect.Effect<location.CancelJobResponse, location.CancelJobError>
  >
> {}
export const CancelJob = Binding.Service<CancelJob>("AWS.Location.CancelJob");
