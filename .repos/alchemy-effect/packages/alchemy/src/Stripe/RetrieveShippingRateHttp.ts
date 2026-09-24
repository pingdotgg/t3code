import { GetShippingRate } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveShippingRate } from "./RetrieveShippingRate.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveShippingRate}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveShippingRate
 */
export const RetrieveShippingRateHttp = Layer.effect(
  RetrieveShippingRate,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveShippingRate",
    operation: GetShippingRate,
    idField: "shipping_rate_token",
    permissions: ["shipping_rates_read"],
  }),
);
