import * as Layer from "effect/Layer";
import { makeBigQueryTableBinding, writeTableIam } from "./TableHttp.ts";
import { WriteTable } from "./WriteTable.ts";

/**
 * HTTP implementation of {@link WriteTable} over the BigQuery REST API.
 *
 * @layer
 * @provides GCP.BigQuery.WriteTable
 * @category BigQuery
 */
export const WriteTableHttp = Layer.effect(
  WriteTable,
  makeBigQueryTableBinding({
    tag: "GCP.BigQuery.WriteTable",
    iam: writeTableIam,
    makeClient: (helpers, table) => helpers.makeWrite(table),
  }),
);
