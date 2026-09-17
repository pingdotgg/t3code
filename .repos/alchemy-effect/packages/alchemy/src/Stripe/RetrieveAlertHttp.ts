import { GetBillingAlert } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveAlert } from "./RetrieveAlert.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveAlert}.
 *
 * @layer
 * @provides Stripe.RetrieveAlert
 */
export const RetrieveAlertHttp = Layer.effect(
  RetrieveAlert,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveAlert",
    operation: GetBillingAlert,
    idField: "id",
    permissions: ["billing_meters_read"],
  }),
);
