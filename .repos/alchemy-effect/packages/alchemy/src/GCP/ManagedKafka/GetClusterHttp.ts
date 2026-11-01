import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import { makeManagedKafkaHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";
import { GetCluster } from "./GetCluster.ts";

/**
 * HTTP implementation of {@link GetCluster}.
 *
 * @layer
 * @provides GCP.ManagedKafka.GetCluster
 */
export const GetClusterHttp: Layer.Layer<
  GetCluster,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetCluster,
  makeManagedKafkaHttpBinding<Cluster>()<
    kafka.GetProjectsLocationsClustersRequest,
    kafka.Cluster,
    kafka.GetProjectsLocationsClustersError
  >({
    tag: "GCP.ManagedKafka.GetCluster",
    iam: { role: "roles/managedkafka.viewer", scopeByCondition: true },
    operation: kafka.getProjectsLocationsClusters,
  }),
);
