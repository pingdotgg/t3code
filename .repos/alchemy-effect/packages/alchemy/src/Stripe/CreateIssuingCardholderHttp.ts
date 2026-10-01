import { CreateIssuingCardholder as createIssuingCardholderOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateIssuingCardholder } from "./CreateIssuingCardholder.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateIssuingCardholder}. Provide it on
 * the Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.CreateIssuingCardholder
 */
export const CreateIssuingCardholderHttp = Layer.effect(
  CreateIssuingCardholder,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateIssuingCardholder",
    operation: createIssuingCardholderOp,
    permissions: ["issuing_write"],
  }),
);
