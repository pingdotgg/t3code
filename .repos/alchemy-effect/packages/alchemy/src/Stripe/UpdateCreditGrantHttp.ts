import { UpdateBillingCreditGrant } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";
import { UpdateCreditGrant } from "./UpdateCreditGrant.ts";

/**
 * HTTP implementation of {@link UpdateCreditGrant}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.UpdateCreditGrant
 */
export const UpdateCreditGrantHttp = Layer.effect(
  UpdateCreditGrant,
  makeHttpStripeIdBinding({
    tag: "Stripe.UpdateCreditGrant",
    operation: UpdateBillingCreditGrant,
    idField: "id",
    permissions: ["credit_grants_write"],
  }),
);
