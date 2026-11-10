import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Layer from "effect/Layer";
import { makeAlloyDbBackupHttpBinding } from "./BindingHttp.ts";
import { GetBackup } from "./GetBackup.ts";

/**
 * HTTP implementation of {@link GetBackup}.
 *
 * @layer
 * @provides GCP.AlloyDB.GetBackup
 */
export const GetBackupHttp = Layer.effect(
  GetBackup,
  makeAlloyDbBackupHttpBinding({
    tag: "GCP.AlloyDB.GetBackup",
    iam: { role: "roles/alloydb.viewer" },
    operation: alloydb.getProjectsLocationsBackups,
  }),
);
