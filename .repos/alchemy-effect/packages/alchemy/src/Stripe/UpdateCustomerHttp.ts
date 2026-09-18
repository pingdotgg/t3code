import { UpdateCustomer as updateCustomerOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";
import { UpdateCustomer } from "./UpdateCustomer.ts";

/**
 * HTTP implementation of {@link UpdateCustomer}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.UpdateCustomer
 */
export const UpdateCustomerHttp = Layer.effect(
  UpdateCustomer,
  makeHttpStripeIdBinding({
    tag: "Stripe.UpdateCustomer",
    operation: updateCustomerOp,
    idField: "customer",
    permissions: ["customers_write"],
  }),
);
