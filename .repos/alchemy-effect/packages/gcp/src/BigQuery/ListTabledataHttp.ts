import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { ListTabledata } from "./ListTabledata.ts";

/**
 * HTTP implementation of {@link ListTabledata}.
 *
 * @layer
 * @provides GCP.BigQuery.ListTabledata
 */
export const ListTabledataHttp = Layer.effect(
  ListTabledata,
  makeTableHttpBinding({
    tag: "GCP.BigQuery.ListTabledata",
    // bigquery.tables.getData
    iam: { role: "roles/bigquery.dataViewer", on: "bigquery.table" },
    operation: bigquery.listTabledata,
  }),
);
