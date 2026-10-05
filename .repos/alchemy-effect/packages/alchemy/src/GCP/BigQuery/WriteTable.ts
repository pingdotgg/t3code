import type * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Table } from "./Table.ts";

/** Per-row errors from a `tabledata.insertAll` request. */
export class InsertRowsFailed extends Data.TaggedError(
  "GCP.BigQuery.InsertRowsFailed",
)<{
  insertErrors: ReadonlyArray<{
    /** Index of the rejected row in the request. */
    index: number | undefined;
    errors: ReadonlyArray<bigquery.ErrorProto>;
  }>;
}> {}

export interface InsertRowsOptions {
  /**
   * Per-row `insertId`s for best-effort de-duplication; must match `rows`
   * in length.
   */
  insertIds?: string[];
}

/** Write-only client for one BigQuery table. */
export interface WriteTableClient {
  /**
   * Stream rows into the table (`tabledata.insertAll`). Values are plain
   * JavaScript (`Date` → timestamp, `Uint8Array` → bytes, `bigint` →
   * integer string). Fails with {@link InsertRowsFailed} when any row is
   * rejected.
   */
  insert(
    rows: ReadonlyArray<Record<string, unknown>>,
    options?: InsertRowsOptions,
  ): Effect.Effect<
    void,
    bigquery.InsertAllTabledataError | InsertRowsFailed,
    RuntimeContext
  >;
}

/**
 * Write access to a BigQuery {@link Table}: streaming `insert`. Grants
 * `roles/bigquery.dataEditor` on the table only.
 *
 * ### Writing rows
 * **Example:** Stream rows with de-duplication ids
 * ```typescript
 * const events = yield* GCP.BigQuery.WriteTable(table);
 * yield* events.insert(
 *   [{ id: "a", score: 1, at: new Date() }],
 *   { insertIds: ["a"] },
 * );
 * // …provided with Effect.provide(GCP.BigQuery.WriteTableHttp)
 * ```
 *
 * @binding
 * @category BigQuery
 */
export interface WriteTable extends Binding.Service<
  WriteTable,
  "GCP.BigQuery.WriteTable",
  (table: Table) => Effect.Effect<WriteTableClient>
> {}

export const WriteTable = Binding.Service<WriteTable>(
  "GCP.BigQuery.WriteTable",
);
