import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Layer from "effect/Layer";
import { makeTopicHttpBinding } from "./BindingHttp.ts";
import { Publish } from "./Publish.ts";

/**
 * HTTP implementation of {@link Publish}.
 *
 * @layer
 * @provides GCP.PubSub.Publish
 */
export const PublishHttp = Layer.effect(
  Publish,
  makeTopicHttpBinding({
    tag: "GCP.PubSub.Publish",
    iam: { role: "roles/pubsub.publisher", on: "pubsub.topic" },
    operation: pubsub.publishProjectsTopics,
  }),
);
