import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Retrieves the status, configuration, and error report of a Location batch metadata job.
 *
 * Runtime binding for the `GetJob` operation (IAM action
 * `geo:GetJob`), account-scoped — batch jobs are created at runtime so the
 * grant is on `*`. Provide the implementation with
 * `Effect.provide(AWS.Location.GetJobHttp)`.
 *
 * ### Managing Batch Jobs
 * **Example:** Poll a Batch Job
 * ```typescript
 * const getJob = yield* Location.GetJob();
 *
 * const job = yield* getJob({ JobId: jobId });
 * // job.Status → "IN_PROGRESS" | "SUCCEEDED" | …
 * ```
 *
 * @binding
 */
export interface GetJob extends Binding.Service<
  GetJob,
  "AWS.Location.GetJob",
  () => Effect.Effect<
    (
      request: location.GetJobRequest,
    ) => Effect.Effect<location.GetJobResponse, location.GetJobError>
  >
> {}
export const GetJob = Binding.Service<GetJob>("AWS.Location.GetJob");
