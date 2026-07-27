import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartJob` request with `ExecutionRoleArn` injected from the bound
 * execution role.
 */
export interface StartJobRequest extends Omit<
  location.StartJobRequest,
  "ExecutionRoleArn"
> {}

/**
 * Starts a Location batch metadata job (e.g. batch address validation over
 * an S3 input file).
 *
 * Runtime binding for the `StartJob` operation (IAM action `geo:StartJob`).
 * Bind the IAM {@link Role} Location assumes to read the S3 input and write
 * the S3 output — its ARN is injected as `ExecutionRoleArn` and the host is
 * additionally granted `iam:PassRole` on it. Jobs are named at runtime so
 * the `geo:StartJob` grant is on `*`. Provide the implementation with
 * `Effect.provide(AWS.Location.StartJobHttp)`.
 *
 * @binding
 * @section Managing Batch Jobs
 * @example Start a Batch Job
 * ```typescript
 * const startJob = yield* Location.StartJob(jobsRole);
 *
 * const job = yield* startJob({
 *   Action: "ValidateAddress",
 *   InputOptions: { Format: "CSV", Location: "s3://my-bucket/addresses.csv" },
 *   OutputOptions: { Format: "CSV", Location: "s3://my-bucket/results/" },
 * });
 * // job.JobId → poll with Location.GetJob
 * ```
 */
export interface StartJob extends Binding.Service<
  StartJob,
  "AWS.Location.StartJob",
  (
    executionRole: Role,
  ) => Effect.Effect<
    (
      request: StartJobRequest,
    ) => Effect.Effect<location.StartJobResponse, location.StartJobError>
  >
> {}
export const StartJob = Binding.Service<StartJob>("AWS.Location.StartJob");
