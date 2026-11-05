import { CreateCheckoutSession as createCheckoutSessionOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateCheckoutSession } from "./CreateCheckoutSession.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateCheckoutSession}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Checkout
 * @provides Stripe.CreateCheckoutSession
 */
export const CreateCheckoutSessionHttp = Layer.effect(
  CreateCheckoutSession,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateCheckoutSession",
    operation: createCheckoutSessionOp,
    permissions: ["checkout_sessions_write"],
  }),
);
