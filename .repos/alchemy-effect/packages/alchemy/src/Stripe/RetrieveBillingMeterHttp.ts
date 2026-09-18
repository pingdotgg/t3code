import { GetBillingMeter } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveBillingMeter } from "./RetrieveBillingMeter.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveBillingMeter}.
 *
 * @layer
 * @provides Stripe.RetrieveBillingMeter
 */
export const RetrieveBillingMeterHttp = Layer.effect(
  RetrieveBillingMeter,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveBillingMeter",
    operation: GetBillingMeter,
    idField: "id",
    permissions: ["billing_meters_read"],
  }),
);
