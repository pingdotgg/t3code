import type {
  GetWebhookEndpointError,
  GetWebhookEndpointRequest,
  WebhookEndpoint as StripeWebhookEndpoint,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { WebhookEndpoint } from "./WebhookEndpoint.ts";

export interface RetrieveWebhookEndpointRequest extends Omit<
  GetWebhookEndpointRequest,
  "webhook_endpoint"
> {}

/**
 * Retrieve a bound Stripe Webhook Endpoint over HTTP.
 *
 * ### Reading a Webhook Endpoint
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveWebhookEndpoint(hook);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveWebhookEndpoint extends Binding.Service<
  RetrieveWebhookEndpoint,
  "Stripe.RetrieveWebhookEndpoint",
  (
    webhookEndpoint: WebhookEndpoint,
  ) => Effect.Effect<
    (
      request?: RetrieveWebhookEndpointRequest,
    ) => Effect.Effect<
      StripeWebhookEndpoint,
      GetWebhookEndpointError,
      RuntimeContext
    >
  >
> {}

export const RetrieveWebhookEndpoint = Binding.Service<RetrieveWebhookEndpoint>(
  "Stripe.RetrieveWebhookEndpoint",
);
