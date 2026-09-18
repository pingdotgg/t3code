import { GetPlan } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrievePlan } from "./RetrievePlan.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrievePlan}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrievePlan
 */
export const RetrievePlanHttp = Layer.effect(
  RetrievePlan,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrievePlan",
    operation: GetPlan,
    idField: "plan",
    permissions: ["plans_read"],
  }),
);
