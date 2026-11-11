import * as Layer from "effect/Layer";
import { makeReadSubscriptionBinding } from "./AccessHttp.ts";
import { ReadSubscription } from "./ReadSubscription.ts";

/**
 * HTTP implementation of {@link ReadSubscription} over the Pub/Sub REST API.
 *
 * @layer
 * @provides GCP.PubSub.ReadSubscription
 * @category PubSub
 */
export const ReadSubscriptionHttp = Layer.effect(ReadSubscription, makeReadSubscriptionBinding);
