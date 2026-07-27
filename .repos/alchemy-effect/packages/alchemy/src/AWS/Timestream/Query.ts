import type * as TSQ from "@distilled.cloud/aws/timestream-query";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface QueryRequest extends TSQ.QueryRequest {}

/**
 * Runtime binding for `timestream-query:Query` — run SQL queries against a
 * Timestream {@link Table}.
 *
 * Bind the operation to a table inside a function runtime to get a callable
 * that grants `timestream:Select` on the table (plus the unscoped
 * `timestream:DescribeEndpoints` the endpoint-discovery flow needs). The
 * query string itself still references the database and table by name.
 *
 * Provide `Timestream.QueryHttp` on the Function to implement the binding.
 *
 * @binding
 * @section Querying Data
 * @example Count rows in a table
 * ```typescript
 * // init — bind the operation to the table
 * const query = yield* Timestream.Query(table);
 *
 * // runtime — run a SQL query
 * const result = yield* query({
 *   QueryString: `SELECT COUNT(*) AS c FROM "${databaseName}"."${tableName}"`,
 * });
 * // result.Rows / result.ColumnInfo hold the result set
 * ```
 */
export interface Query extends Binding.Service<
  Query,
  "AWS.Timestream.Query",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: QueryRequest,
    ) => Effect.Effect<
      TSQ.QueryResponse,
      TSQ.QueryError | TSQ.DescribeEndpointsError
    >
  >
> {}

export const Query = Binding.Service<Query>("AWS.Timestream.Query");
