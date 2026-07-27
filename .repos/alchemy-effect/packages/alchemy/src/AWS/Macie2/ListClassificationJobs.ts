import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListClassificationJobs`.
 *
 * Retrieves a subset of information about one or more classification jobs.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListClassificationJobsHttp)`.
 * @binding
 * @section Classification Jobs & Export
 * @example List Classification Jobs
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listClassificationJobs = yield* AWS.Macie2.ListClassificationJobs();
 *
 * // runtime
 * const { items } = yield* listClassificationJobs();
 * ```
 */
export interface ListClassificationJobs extends Binding.Service<
  ListClassificationJobs,
  "AWS.Macie2.ListClassificationJobs",
  () => Effect.Effect<
    (
      request?: macie2.ListClassificationJobsRequest,
    ) => Effect.Effect<
      macie2.ListClassificationJobsResponse,
      macie2.ListClassificationJobsError
    >
  >
> {}
export const ListClassificationJobs = Binding.Service<ListClassificationJobs>(
  "AWS.Macie2.ListClassificationJobs",
);
