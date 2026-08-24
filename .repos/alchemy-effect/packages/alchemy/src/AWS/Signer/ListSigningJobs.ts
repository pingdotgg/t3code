import type * as signer from "@distilled.cloud/aws/signer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `signer:ListSigningJobs`.
 *
 * Lists the account's signing jobs, filterable by status, platform,
 * requester, revocation state, and signature expiry window. Account-level
 * operation — the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Signer.ListSigningJobsHttp)`.
 * @binding
 * @section Observing Signing Jobs
 * @example List In-Progress Jobs
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listSigningJobs = yield* AWS.Signer.ListSigningJobs();
 *
 * // runtime
 * const { jobs } = yield* listSigningJobs({ status: "InProgress" });
 * ```
 */
export interface ListSigningJobs extends Binding.Service<
  ListSigningJobs,
  "AWS.Signer.ListSigningJobs",
  () => Effect.Effect<
    (
      request?: signer.ListSigningJobsRequest,
    ) => Effect.Effect<
      signer.ListSigningJobsResponse,
      signer.ListSigningJobsError
    >
  >
> {}
export const ListSigningJobs = Binding.Service<ListSigningJobs>(
  "AWS.Signer.ListSigningJobs",
);
