import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetExadbVmCluster } from "./GetExadbVmCluster.ts";

/**
 * HTTP implementation of {@link GetExadbVmCluster}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetExadbVmCluster
 */
export const GetExadbVmClusterHttp = Layer.effect(
  GetExadbVmCluster,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetExadbVmCluster",
    operation: oracle.getProjectsLocationsExadbVmClusters,
    iam: { role: "roles/oracledatabase.exadbVmClusterViewer" },
  }),
);
