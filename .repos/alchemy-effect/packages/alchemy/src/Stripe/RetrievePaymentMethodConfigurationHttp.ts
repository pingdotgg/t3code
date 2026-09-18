import { GetPaymentMethodConfiguration } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrievePaymentMethodConfiguration } from "./RetrievePaymentMethodConfiguration.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrievePaymentMethodConfiguration}.
 *
 * @layer
 * @provides Stripe.RetrievePaymentMethodConfiguration
 */
export const RetrievePaymentMethodConfigurationHttp = Layer.effect(
  RetrievePaymentMethodConfiguration,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrievePaymentMethodConfiguration",
    operation: GetPaymentMethodConfiguration,
    idField: "configuration",
    permissions: ["payment_method_configurations_read"],
  }),
);
