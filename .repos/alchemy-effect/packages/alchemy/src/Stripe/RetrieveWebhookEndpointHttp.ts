import { GetWebhookEndpoint } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveWebhookEndpoint } from "./RetrieveWebhookEndpoint.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveWebhookEndpoint}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveWebhookEndpoint
 */
export const RetrieveWebhookEndpointHttp = Layer.effect(
  RetrieveWebhookEndpoint,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveWebhookEndpoint",
    operation: GetWebhookEndpoint,
    idField: "webhook_endpoint",
    permissions: ["webhook_endpoints_read"],
  }),
);
