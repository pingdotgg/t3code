import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:ListJobs`.
 *
 * Enumerates the account's import/export jobs, optionally filtered to
 * one data set or revision.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.ListJobsHttp)`.
 * ### Import & Export Jobs
 * **Example:** List A Data Set's Jobs
 * ```typescript
 * const listJobs = yield* AWS.DataExchange.ListJobs();
 *
 * // runtime
 * const { Jobs } = yield* listJobs({ DataSetId: dataSetId });
 * ```
 *
 * @binding
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "AWS.DataExchange.ListJobs",
  () => Effect.Effect<
    (
      request?: dataexchange.ListJobsRequest,
    ) => Effect.Effect<
      dataexchange.ListJobsResponse,
      dataexchange.ListJobsError
    >
  >
> {}
export const ListJobs = Binding.Service<ListJobs>("AWS.DataExchange.ListJobs");
