import { GetTaxRegistration } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveTaxRegistration } from "./RetrieveTaxRegistration.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveTaxRegistration}. Provide it on
 * the Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveTaxRegistration
 */
export const RetrieveTaxRegistrationHttp = Layer.effect(
  RetrieveTaxRegistration,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveTaxRegistration",
    operation: GetTaxRegistration,
    idField: "id",
    permissions: ["tax_read"],
  }),
);
