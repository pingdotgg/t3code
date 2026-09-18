import { GetCustomer } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveCustomer } from "./RetrieveCustomer.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveCustomer}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveCustomer
 */
export const RetrieveCustomerHttp = Layer.effect(
  RetrieveCustomer,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveCustomer",
    operation: GetCustomer,
    idField: "customer",
    permissions: ["customers_read"],
  }),
);
