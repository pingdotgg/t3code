import { GetIssuingPersonalizationDesign } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveIssuingPersonalizationDesign } from "./RetrieveIssuingPersonalizationDesign.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveIssuingPersonalizationDesign}.
 * Provide it on the Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveIssuingPersonalizationDesign
 */
export const RetrieveIssuingPersonalizationDesignHttp = Layer.effect(
  RetrieveIssuingPersonalizationDesign,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveIssuingPersonalizationDesign",
    operation: GetIssuingPersonalizationDesign,
    idField: "personalization_design",
    permissions: ["issuing_read"],
  }),
);
