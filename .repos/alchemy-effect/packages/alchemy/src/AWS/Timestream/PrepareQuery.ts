import type * as TSQ from "@distilled.cloud/aws/timestream-query";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface PrepareQueryRequest extends TSQ.PrepareQueryRequest {}

/**
 * Runtime binding for `timestream-query:PrepareQuery` — validate a SQL query
 * against a Timestream {@link Table} and inspect its result schema and
 * parameter mappings without running it.
 *
 * Bind the operation to the table the SQL reads so the host is granted
 * `timestream:PrepareQuery` and `timestream:Select` on it (plus the unscoped
 * `timestream:DescribeEndpoints` the endpoint-discovery flow needs). The
 * query string itself still references the database and table by name.
 *
 * Provide `Timestream.PrepareQueryHttp` on the Function to implement the
 * binding.
 *
 * @binding
 * @section Querying Data
 * @example Validate a query before running it
 * ```typescript
 * // init — bind the operation to the table the SQL reads
 * const prepareQuery = yield* Timestream.PrepareQuery(table);
 *
 * // runtime — validate only; Columns/Parameters describe the result shape
 * const prepared = yield* prepareQuery({
 *   QueryString: `SELECT COUNT(*) AS c FROM "${databaseName}"."${tableName}"`,
 *   ValidateOnly: true,
 * });
 * // prepared.Columns[0].Name === "c"
 * ```
 */
export interface PrepareQuery extends Binding.Service<
  PrepareQuery,
  "AWS.Timestream.PrepareQuery",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: PrepareQueryRequest,
    ) => Effect.Effect<
      TSQ.PrepareQueryResponse,
      TSQ.PrepareQueryError | TSQ.DescribeEndpointsError
    >
  >
> {}

export const PrepareQuery = Binding.Service<PrepareQuery>(
  "AWS.Timestream.PrepareQuery",
);
