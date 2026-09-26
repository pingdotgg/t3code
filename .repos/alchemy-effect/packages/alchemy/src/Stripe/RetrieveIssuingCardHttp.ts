import { GetIssuingCard } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveIssuingCard } from "./RetrieveIssuingCard.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveIssuingCard}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveIssuingCard
 */
export const RetrieveIssuingCardHttp = Layer.effect(
  RetrieveIssuingCard,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveIssuingCard",
    operation: GetIssuingCard,
    idField: "card",
    permissions: ["issuing_read"],
  }),
);
