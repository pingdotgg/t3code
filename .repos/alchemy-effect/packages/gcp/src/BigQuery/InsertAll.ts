import type * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Table } from "./Table.ts";

export interface InsertAllRequest extends Omit<
  bigquery.InsertAllTabledataRequest,
  "projectId" | "datasetId" | "tableId"
> {}

/**
 * Runtime binding for BigQuery `tabledata.insertAll`.
 *
 * Bind this operation to a {@link Table} in a Function/Action init phase.
 * Provide {@link InsertAllHttp}.
 *
 * ### Inserting Rows
 * **Example:** Stream a row
 * ```typescript
 * const insertAll = yield* GCP.BigQuery.InsertAll(events);
 * yield* insertAll({
 *   body: { rows: [{ json: { id: "1" } }] },
 * });
 * ```
 *
 * @binding
 * @category BigQuery
 */
export interface InsertAll extends Binding.Service<
  InsertAll,
  "GCP.BigQuery.InsertAll",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: InsertAllRequest,
    ) => Effect.Effect<
      bigquery.TableDataInsertAllResponse,
      bigquery.InsertAllTabledataError,
      RuntimeContext
    >
  >
> {}

export const InsertAll = Binding.Service<InsertAll>("GCP.BigQuery.InsertAll");
