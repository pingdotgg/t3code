import type {
  CheckoutSession,
  CreateCheckoutSessionError,
  CreateCheckoutSessionRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * Create a Stripe Checkout Session over HTTP. This is how a Worker starts
 * a purchase: create the session for a Price, then redirect the buyer to
 * `session.url`. Stripe hosts the payment page and sends
 * `checkout.session.completed` when it succeeds.
 *
 * Account-scoped — binds the API key onto the host, not a specific
 * resource.
 *
 * ### Starting a subscription checkout
 * **Example:** Redirect a buyer to hosted Checkout
 * ```typescript
 * const createCheckout = yield* Stripe.CreateCheckoutSession();
 *
 * // inside a Worker route
 * const session = yield* createCheckout({
 *   mode: "subscription",
 *   line_items: [{ price: price.id, quantity: 1 }],
 *   customer: customerId,
 *   success_url: `${origin}/welcome`,
 *   cancel_url: `${origin}/pricing`,
 * });
 * // redirect to session.url
 * ```
 *
 * @binding
 * @product Checkout
 */
export interface CreateCheckoutSession extends Binding.Service<
  CreateCheckoutSession,
  "Stripe.CreateCheckoutSession",
  () => Effect.Effect<
    (
      request: CreateCheckoutSessionRequest,
    ) => Effect.Effect<
      CheckoutSession,
      CreateCheckoutSessionError,
      RuntimeContext
    >
  >
> {}

export const CreateCheckoutSession = Binding.Service<CreateCheckoutSession>(
  "Stripe.CreateCheckoutSession",
);
