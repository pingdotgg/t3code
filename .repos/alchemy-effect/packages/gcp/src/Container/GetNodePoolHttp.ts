import * as container from "@distilled.cloud/gcp/container_v1";
import * as Layer from "effect/Layer";
import { makeContainerNodePoolHttpBinding } from "./BindingHttp.ts";
import { GetNodePool } from "./GetNodePool.ts";

/**
 * HTTP implementation of {@link GetNodePool}.
 *
 * @layer
 * @provides GCP.Container.GetNodePool
 */
export const GetNodePoolHttp = Layer.effect(
  GetNodePool,
  makeContainerNodePoolHttpBinding({
    tag: "GCP.Container.GetNodePool",
    iam: { role: "roles/container.clusterViewer" },
    operation: container.getProjectsLocationsClustersNodePools,
  }),
);
