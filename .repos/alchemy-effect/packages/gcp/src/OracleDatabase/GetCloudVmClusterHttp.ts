import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetCloudVmCluster } from "./GetCloudVmCluster.ts";

/**
 * HTTP implementation of {@link GetCloudVmCluster}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetCloudVmCluster
 */
export const GetCloudVmClusterHttp = Layer.effect(
  GetCloudVmCluster,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetCloudVmCluster",
    operation: oracle.getProjectsLocationsCloudVmClusters,
    iam: { role: "roles/oracledatabase.cloudVmClusterViewer" },
  }),
);
