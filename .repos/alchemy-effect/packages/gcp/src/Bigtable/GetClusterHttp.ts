import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Layer from "effect/Layer";
import { makeBigtableClusterHttpBinding } from "./BindingHttp.ts";
import { GetCluster } from "./GetCluster.ts";

/**
 * HTTP implementation of {@link GetCluster}.
 *
 * @layer
 * @provides GCP.Bigtable.GetCluster
 */
export const GetClusterHttp = Layer.effect(
  GetCluster,
  makeBigtableClusterHttpBinding({
    tag: "GCP.Bigtable.GetCluster",
    iam: { role: "roles/bigtable.viewer", on: "bigtable.instance" },
    operation: bigtable.getProjectsInstancesClusters,
  }),
);
