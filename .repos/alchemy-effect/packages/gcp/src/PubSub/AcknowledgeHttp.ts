import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Layer from "effect/Layer";
import { Acknowledge } from "./Acknowledge.ts";
import { makeSubscriptionHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link Acknowledge}.
 *
 * @layer
 * @provides GCP.PubSub.Acknowledge
 */
export const AcknowledgeHttp = Layer.effect(
  Acknowledge,
  makeSubscriptionHttpBinding({
    tag: "GCP.PubSub.Acknowledge",
    iam: { role: "roles/pubsub.subscriber", on: "pubsub.subscription" },
    operation: pubsub.acknowledgeProjectsSubscriptions,
  }),
);
