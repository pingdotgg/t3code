import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Layer from "effect/Layer";
import { makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import { GetSubscription } from "./GetSubscription.ts";

/**
 * HTTP implementation of {@link GetSubscription}.
 *
 * @layer
 * @provides GCP.PubSubLite.GetSubscription
 */
export const GetSubscriptionHttp = Layer.effect(
  GetSubscription,
  makeSubscriptionHttpBinding({
    tag: "GCP.PubSubLite.GetSubscription",
    iam: { role: "roles/pubsublite.viewer" },
    field: "name",
    operation: pubsublite.getAdminProjectsLocationsSubscriptions,
  }),
);
