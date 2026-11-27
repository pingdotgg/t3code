import * as container from "@distilled.cloud/gcp/container_v1";
import * as Layer from "effect/Layer";
import { makeContainerClusterHttpBinding } from "./BindingHttp.ts";
import { GetCluster } from "./GetCluster.ts";

/**
 * HTTP implementation of {@link GetCluster}.
 *
 * @layer
 * @provides GCP.Container.GetCluster
 */
export const GetClusterHttp = Layer.effect(
  GetCluster,
  makeContainerClusterHttpBinding({
    tag: "GCP.Container.GetCluster",
    iam: { role: "roles/container.clusterViewer" },
    operation: container.getProjectsLocationsClusters,
  }),
);
