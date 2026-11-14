import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetExascaleDbStorageVault } from "./GetExascaleDbStorageVault.ts";

/**
 * HTTP implementation of {@link GetExascaleDbStorageVault}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetExascaleDbStorageVault
 */
export const GetExascaleDbStorageVaultHttp = Layer.effect(
  GetExascaleDbStorageVault,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetExascaleDbStorageVault",
    operation: oracle.getProjectsLocationsExascaleDbStorageVaults,
    iam: { role: "roles/oracledatabase.exascaleDbStorageVaultViewer" },
  }),
);
