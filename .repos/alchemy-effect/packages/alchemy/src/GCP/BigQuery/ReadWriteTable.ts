import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReadTableClient } from "./ReadTable.ts";
import type { Table } from "./Table.ts";
import type { WriteTableClient } from "./WriteTable.ts";

export interface ReadWriteTableClient
  extends ReadTableClient, WriteTableClient {}

/**
 * Read and write access to a BigQuery {@link Table}. Grants
 * `roles/bigquery.dataEditor` on the table and `roles/bigquery.jobUser` on
 * the project (job creation is project-only).
 *
 * ### Reading and writing
 * **Example:** Insert then aggregate
 * ```typescript
 * const events = yield* GCP.BigQuery.ReadWriteTable(table);
 * const tableId = yield* table.tableId;
 * return Effect.gen(function* () {
 *   yield* events.insert([{ id: "a", score: 3 }]);
 *   const [total] = yield* events.query(
 *     `SELECT SUM(score) AS total FROM \`${yield* tableId}\``,
 *   );
 * });
 * // …provided with Effect.provide(GCP.BigQuery.ReadWriteTableHttp)
 * ```
 *
 * @binding
 * @category BigQuery
 */
export interface ReadWriteTable extends Binding.Service<
  ReadWriteTable,
  "GCP.BigQuery.ReadWriteTable",
  (table: Table) => Effect.Effect<ReadWriteTableClient>
> {}

export const ReadWriteTable = Binding.Service<ReadWriteTable>(
  "GCP.BigQuery.ReadWriteTable",
);
