import { GetBillingCreditGrant } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveCreditGrant } from "./RetrieveCreditGrant.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveCreditGrant}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveCreditGrant
 */
export const RetrieveCreditGrantHttp = Layer.effect(
  RetrieveCreditGrant,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveCreditGrant",
    operation: GetBillingCreditGrant,
    idField: "id",
    permissions: ["credit_grants_read"],
  }),
);
