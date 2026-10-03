import { GetApplePayDomain } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveApplePayDomain } from "./RetrieveApplePayDomain.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveApplePayDomain}. Provide it on
 * the Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveApplePayDomain
 */
export const RetrieveApplePayDomainHttp = Layer.effect(
  RetrieveApplePayDomain,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveApplePayDomain",
    operation: GetApplePayDomain,
    idField: "domain",
    permissions: ["apple_pay_domains_read"],
  }),
);
