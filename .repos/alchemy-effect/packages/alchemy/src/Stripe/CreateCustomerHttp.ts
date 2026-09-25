import { CreateCustomer as createCustomerOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateCustomer } from "./CreateCustomer.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateCustomer}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.CreateCustomer
 */
export const CreateCustomerHttp = Layer.effect(
  CreateCustomer,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateCustomer",
    operation: createCustomerOp,
    permissions: ["customers_write"],
  }),
);
