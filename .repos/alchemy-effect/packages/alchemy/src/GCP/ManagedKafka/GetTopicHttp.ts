import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import { makeManagedKafkaHttpBinding } from "./BindingHttp.ts";
import type { ClustersTopic } from "./ClustersTopic.ts";
import { GetTopic } from "./GetTopic.ts";

/**
 * HTTP implementation of {@link GetTopic}.
 *
 * @layer
 * @provides GCP.ManagedKafka.GetTopic
 */
export const GetTopicHttp: Layer.Layer<
  GetTopic,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetTopic,
  makeManagedKafkaHttpBinding<ClustersTopic>()<
    kafka.GetProjectsLocationsClustersTopicsRequest,
    kafka.Topic,
    kafka.GetProjectsLocationsClustersTopicsError
  >({
    tag: "GCP.ManagedKafka.GetTopic",
    iam: { role: "roles/managedkafka.viewer", scopeByCondition: true },
    operation: kafka.getProjectsLocationsClustersTopics,
  }),
);
