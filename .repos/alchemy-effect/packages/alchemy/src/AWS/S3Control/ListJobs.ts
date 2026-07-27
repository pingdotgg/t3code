import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as sts from "@distilled.cloud/aws/sts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `s3:ListJobs` (S3 Batch Operations).
 *
 * Lists the account's current jobs and the jobs that ended within the last
 * 90 days, optionally filtered by status — e.g. an operations dashboard
 * summarizing in-flight bulk operations. The account id is resolved once
 * via `sts:GetCallerIdentity`. Provide the implementation with
 * `Effect.provide(AWS.S3Control.ListJobsHttp)`.
 * @binding
 * @section Running Batch Operations Jobs
 * @example List Active Jobs
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listJobs = yield* AWS.S3Control.ListJobs();
 *
 * // runtime
 * const { Jobs } = yield* listJobs({ JobStatuses: ["Active"] });
 * ```
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "AWS.S3Control.ListJobs",
  () => Effect.Effect<
    (
      request?: Omit<s3control.ListJobsRequest, "AccountId">,
    ) => Effect.Effect<
      s3control.ListJobsResult,
      s3control.ListJobsError | sts.GetCallerIdentityError
    >
  >
> {}
export const ListJobs = Binding.Service<ListJobs>("AWS.S3Control.ListJobs");
