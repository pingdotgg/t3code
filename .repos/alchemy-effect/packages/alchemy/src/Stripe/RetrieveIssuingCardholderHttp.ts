import { GetIssuingCardholder } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveIssuingCardholder } from "./RetrieveIssuingCardholder.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveIssuingCardholder}. Provide it on
 * the Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveIssuingCardholder
 */
export const RetrieveIssuingCardholderHttp = Layer.effect(
  RetrieveIssuingCardholder,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveIssuingCardholder",
    operation: GetIssuingCardholder,
    idField: "cardholder",
    permissions: ["issuing_read"],
  }),
);
