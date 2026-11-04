import * as Layer from "effect/Layer";
import { ReadTable } from "./ReadTable.ts";
import { makeBigQueryTableBinding, readTableIam } from "./TableHttp.ts";

/**
 * HTTP implementation of {@link ReadTable} over the BigQuery REST API.
 *
 * @layer
 * @provides GCP.BigQuery.ReadTable
 * @category BigQuery
 */
export const ReadTableHttp = Layer.effect(
  ReadTable,
  makeBigQueryTableBinding({
    tag: "GCP.BigQuery.ReadTable",
    iam: readTableIam,
    makeClient: (helpers, table) => helpers.makeRead(table),
  }),
);
