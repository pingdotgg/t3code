import { CreateIssuingCard as createIssuingCardOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateIssuingCard } from "./CreateIssuingCard.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateIssuingCard}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.CreateIssuingCard
 */
export const CreateIssuingCardHttp = Layer.effect(
  CreateIssuingCard,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateIssuingCard",
    operation: createIssuingCardOp,
    permissions: ["issuing_write"],
  }),
);
