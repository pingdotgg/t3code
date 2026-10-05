import type * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Dataset } from "./Dataset.ts";

export interface QueryRequest extends bigquery.QueryRequest {}

/**
 * Runtime binding for BigQuery `jobs.query`.
 *
 * Bind this operation to a {@link Dataset} in a Function/Action init phase.
 * Provide {@link QueryHttp}. Unqualified table names resolve against the
 * bound dataset. GoogleSQL is the default (`useLegacySql: false`).
 *
 * ### Querying
 * **Example:** Run a GoogleSQL query
 * ```typescript
 * const query = yield* GCP.BigQuery.Query(dataset);
 * const result = yield* query({ query: "SELECT 1 AS n" });
 * ```
 *
 * @binding
 * @category BigQuery
 */
export interface Query extends Binding.Service<
  Query,
  "GCP.BigQuery.Query",
  (
    dataset: Dataset,
  ) => Effect.Effect<
    (
      request: QueryRequest,
    ) => Effect.Effect<
      bigquery.QueryResponse,
      bigquery.QueryJobsError,
      RuntimeContext
    >
  >
> {}

export const Query = Binding.Service<Query>("GCP.BigQuery.Query");
