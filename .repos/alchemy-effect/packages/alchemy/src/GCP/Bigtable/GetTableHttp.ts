import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Layer from "effect/Layer";
import { makeBigtableTableHttpBinding } from "./BindingHttp.ts";
import { GetTable } from "./GetTable.ts";

/**
 * HTTP implementation of {@link GetTable}.
 *
 * @layer
 * @provides GCP.Bigtable.GetTable
 */
export const GetTableHttp = Layer.effect(
  GetTable,
  makeBigtableTableHttpBinding({
    tag: "GCP.Bigtable.GetTable",
    iam: { role: "roles/bigtable.viewer", on: "bigtable.table" },
    operation: bigtable.getProjectsInstancesTables,
  }),
);
