import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { InsertAll } from "./InsertAll.ts";

/**
 * HTTP implementation of {@link InsertAll}.
 *
 * @layer
 * @provides GCP.BigQuery.InsertAll
 */
export const InsertAllHttp = Layer.effect(
  InsertAll,
  makeTableHttpBinding({
    tag: "GCP.BigQuery.InsertAll",
    // bigquery.tables.updateData
    iam: { role: "roles/bigquery.dataEditor", on: "bigquery.table" },
    operation: bigquery.insertAllTabledata,
  }),
);
