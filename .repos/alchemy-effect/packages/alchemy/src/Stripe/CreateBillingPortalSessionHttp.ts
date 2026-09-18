import { CreateBillingPortalSession as createBillingPortalSessionOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateBillingPortalSession } from "./CreateBillingPortalSession.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateBillingPortalSession}. Provide it on
 * the Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.CreateBillingPortalSession
 */
export const CreateBillingPortalSessionHttp = Layer.effect(
  CreateBillingPortalSession,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateBillingPortalSession",
    operation: createBillingPortalSessionOp,
    permissions: ["billing_portal_write"],
  }),
);
