import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Layer from "effect/Layer";
import { makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import { Pull } from "./Pull.ts";

/**
 * HTTP implementation of {@link Pull}.
 *
 * @layer
 * @provides GCP.PubSub.Pull
 */
export const PullHttp = Layer.effect(
  Pull,
  makeSubscriptionHttpBinding({
    tag: "GCP.PubSub.Pull",
    iam: { role: "roles/pubsub.subscriber", on: "pubsub.subscription" },
    operation: pubsub.pullProjectsSubscriptions,
  }),
);
