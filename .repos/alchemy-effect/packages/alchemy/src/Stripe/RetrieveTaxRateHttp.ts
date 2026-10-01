import { GetTaxRate } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveTaxRate } from "./RetrieveTaxRate.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveTaxRate}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveTaxRate
 */
export const RetrieveTaxRateHttp = Layer.effect(
  RetrieveTaxRate,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveTaxRate",
    operation: GetTaxRate,
    idField: "tax_rate",
    permissions: ["tax_read"],
  }),
);
