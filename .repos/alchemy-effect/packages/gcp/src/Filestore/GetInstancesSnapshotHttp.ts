import * as file from "@distilled.cloud/gcp/file_v1";
import * as Layer from "effect/Layer";
import { makeFilestoreSnapshotHttpBinding } from "./BindingHttp.ts";
import { GetInstancesSnapshot } from "./GetInstancesSnapshot.ts";

/**
 * HTTP implementation of {@link GetInstancesSnapshot}.
 *
 * @layer
 * @provides GCP.Filestore.GetInstancesSnapshot
 */
export const GetInstancesSnapshotHttp = Layer.effect(
  GetInstancesSnapshot,
  makeFilestoreSnapshotHttpBinding({
    tag: "GCP.Filestore.GetInstancesSnapshot",
    iam: { role: "roles/file.viewer" },
    operation: file.getProjectsLocationsInstancesSnapshots,
  }),
);
