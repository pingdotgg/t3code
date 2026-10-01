import { GetCoupon } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveCoupon } from "./RetrieveCoupon.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveCoupon}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveCoupon
 */
export const RetrieveCouponHttp = Layer.effect(
  RetrieveCoupon,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveCoupon",
    operation: GetCoupon,
    idField: "coupon",
    permissions: ["coupons_read"],
  }),
);
