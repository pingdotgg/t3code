import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Layer from "effect/Layer";
import { makeTopicNameHttpBinding } from "./BindingHttp.ts";
import { GetTopic } from "./GetTopic.ts";

/**
 * HTTP implementation of {@link GetTopic}.
 *
 * @layer
 * @provides GCP.PubSubLite.GetTopic
 */
export const GetTopicHttp = Layer.effect(
  GetTopic,
  makeTopicNameHttpBinding({
    tag: "GCP.PubSubLite.GetTopic",
    iam: { role: "roles/pubsublite.viewer" },
    operation: pubsublite.getAdminProjectsLocationsTopics,
  }),
);
