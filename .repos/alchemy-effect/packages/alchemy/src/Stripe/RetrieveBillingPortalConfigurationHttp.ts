import { GetBillingPortalConfiguration } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveBillingPortalConfiguration } from "./RetrieveBillingPortalConfiguration.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveBillingPortalConfiguration}.
 *
 * @layer
 * @provides Stripe.RetrieveBillingPortalConfiguration
 */
export const RetrieveBillingPortalConfigurationHttp = Layer.effect(
  RetrieveBillingPortalConfiguration,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveBillingPortalConfiguration",
    operation: GetBillingPortalConfiguration,
    idField: "configuration",
    permissions: ["billing_portal_read"],
  }),
);
