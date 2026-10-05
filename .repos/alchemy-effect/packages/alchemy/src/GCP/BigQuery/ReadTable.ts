import type * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Table } from "./Table.ts";

/** A query job did not finish within the client's bounded wait. */
export class QueryNotComplete extends Data.TaggedError(
  "GCP.BigQuery.QueryNotComplete",
)<{
  jobId: string | undefined;
}> {}

export interface ListTableOptions {
  /** Maximum rows per page. */
  maxResults?: number;
  /** Page token from a previous `list`. */
  pageToken?: string;
}

export interface ListTableResult {
  /** Rows decoded with the table schema (see {@link ReadTable}). */
  rows: Record<string, unknown>[];
  /** Pass to the next `list` call; `undefined` on the last page. */
  nextPageToken: string | undefined;
}

/** Read-only client for one BigQuery table. */
export interface ReadTableClient {
  /**
   * One page of table rows (`tabledata.list`), including rows still in the
   * streaming buffer.
   */
  list(
    options?: ListTableOptions,
  ): Effect.Effect<
    ListTableResult,
    bigquery.GetTablesError | bigquery.ListTabledataError,
    RuntimeContext
  >;
  /**
   * Run a GoogleSQL query and return every result row. Unqualified table
   * names resolve against the bound table's dataset; `params` become named
   * parameters (`@name`) typed `STRING`, `INT64`/`FLOAT64`, or `BOOL`.
   */
  query(
    sql: string,
    params?: Record<string, string | number | boolean>,
  ): Effect.Effect<
    Record<string, unknown>[],
    | bigquery.QueryJobsError
    | bigquery.GetQueryResultsJobsError
    | QueryNotComplete,
    RuntimeContext
  >;
}

/**
 * Read access to a BigQuery {@link Table}: `list` rows and run `query`
 * jobs. Grants `roles/bigquery.dataViewer` on the table and
 * `roles/bigquery.jobUser` on the project (job creation is project-only).
 *
 * Rows are decoded with the schema: `INTEGER` → `number` (`bigint` beyond
 * the safe range), `FLOAT` → `number`, `BOOLEAN` → `boolean`, `TIMESTAMP` →
 * `Date`, `BYTES` → `Uint8Array`, `JSON` → parsed value, `RECORD` → object,
 * `REPEATED` → array; `NUMERIC`, `DATE`, `DATETIME`, `TIME`, and `GEOGRAPHY`
 * stay strings.
 *
 * ### Reading rows
 * **Example:** Page through a table
 * ```typescript
 * const events = yield* GCP.BigQuery.ReadTable(table);
 * const { rows, nextPageToken } = yield* events.list({ maxResults: 100 });
 * // …provided with Effect.provide(GCP.BigQuery.ReadTableHttp)
 * ```
 *
 * ### Querying
 * **Example:** Parameterized query
 * ```typescript
 * const events = yield* GCP.BigQuery.ReadTable(table);
 * const tableId = yield* table.tableId;
 * return Effect.gen(function* () {
 *   const rows = yield* events.query(
 *     `SELECT id, score FROM \`${yield* tableId}\` WHERE score > @min`,
 *     { min: 10 },
 *   );
 * });
 * ```
 *
 * @binding
 * @category BigQuery
 */
export interface ReadTable extends Binding.Service<
  ReadTable,
  "GCP.BigQuery.ReadTable",
  (table: Table) => Effect.Effect<ReadTableClient>
> {}

export const ReadTable = Binding.Service<ReadTable>("GCP.BigQuery.ReadTable");
