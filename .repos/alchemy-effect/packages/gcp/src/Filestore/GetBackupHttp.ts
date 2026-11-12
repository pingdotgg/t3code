import * as file from "@distilled.cloud/gcp/file_v1";
import * as Layer from "effect/Layer";
import { makeFilestoreBackupHttpBinding } from "./BindingHttp.ts";
import { GetBackup } from "./GetBackup.ts";

/**
 * HTTP implementation of {@link GetBackup}.
 *
 * @layer
 * @provides GCP.Filestore.GetBackup
 */
export const GetBackupHttp = Layer.effect(
  GetBackup,
  makeFilestoreBackupHttpBinding({
    tag: "GCP.Filestore.GetBackup",
    iam: { role: "roles/file.viewer" },
    operation: file.getProjectsLocationsBackups,
  }),
);
