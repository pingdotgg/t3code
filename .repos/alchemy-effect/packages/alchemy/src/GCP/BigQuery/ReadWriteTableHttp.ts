import * as Layer from "effect/Layer";
import { ReadWriteTable } from "./ReadWriteTable.ts";
import { makeBigQueryTableBinding, readWriteTableIam } from "./TableHttp.ts";

/**
 * HTTP implementation of {@link ReadWriteTable} over the BigQuery REST API.
 *
 * @layer
 * @provides GCP.BigQuery.ReadWriteTable
 * @category BigQuery
 */
export const ReadWriteTableHttp = Layer.effect(
  ReadWriteTable,
  makeBigQueryTableBinding({
    tag: "GCP.BigQuery.ReadWriteTable",
    iam: readWriteTableIam,
    makeClient: (helpers, table) => ({
      ...helpers.makeRead(table),
      ...helpers.makeWrite(table),
    }),
  }),
);
