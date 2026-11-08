import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Layer from "effect/Layer";
import { makeAlloyDbClusterHttpBinding } from "./BindingHttp.ts";
import { GetCluster } from "./GetCluster.ts";

/**
 * HTTP implementation of {@link GetCluster}.
 *
 * @layer
 * @provides GCP.AlloyDB.GetCluster
 */
export const GetClusterHttp = Layer.effect(
  GetCluster,
  makeAlloyDbClusterHttpBinding({
    tag: "GCP.AlloyDB.GetCluster",
    iam: { role: "roles/alloydb.viewer" },
    operation: alloydb.getProjectsLocationsClusters,
  }),
);
