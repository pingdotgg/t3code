import * as container from "@distilled.cloud/gcp/container_v1";
import * as Layer from "effect/Layer";
import { makeContainerClustersNodePoolHttpBinding } from "./BindingHttp.ts";
import { GetClustersNodePool } from "./GetClustersNodePool.ts";

/**
 * HTTP implementation of {@link GetClustersNodePool}.
 *
 * @layer
 * @provides GCP.Container.GetClustersNodePool
 */
export const GetClustersNodePoolHttp = Layer.effect(
  GetClustersNodePool,
  makeContainerClustersNodePoolHttpBinding({
    tag: "GCP.Container.GetClustersNodePool",
    iam: { role: "roles/container.clusterViewer" },
    operation: container.getProjectsZonesClustersNodePools,
  }),
);
