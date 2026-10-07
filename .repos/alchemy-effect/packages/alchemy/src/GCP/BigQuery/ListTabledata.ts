import type * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Table } from "./Table.ts";

export interface ListTabledataRequest extends Omit<
  bigquery.ListTabledataRequest,
  "projectId" | "datasetId" | "tableId"
> {}

/**
 * Runtime binding for BigQuery `tabledata.list`.
 *
 * Bind this operation to a {@link Table} in a Function/Action init phase.
 * Provide {@link ListTabledataHttp}.
 *
 * ### Listing Rows
 * **Example:** List table rows
 * ```typescript
 * const listRows = yield* GCP.BigQuery.ListTabledata(events);
 * const page = yield* listRows({ maxResults: 100 });
 * ```
 *
 * @binding
 * @category BigQuery
 */
export interface ListTabledata extends Binding.Service<
  ListTabledata,
  "GCP.BigQuery.ListTabledata",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request?: ListTabledataRequest,
    ) => Effect.Effect<
      bigquery.TableDataList,
      bigquery.ListTabledataError,
      RuntimeContext
    >
  >
> {}

export const ListTabledata = Binding.Service<ListTabledata>(
  "GCP.BigQuery.ListTabledata",
);
