import type {
  Coupon as StripeCoupon,
  GetCouponError,
  GetCouponRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Coupon } from "./Coupon.ts";

export interface RetrieveCouponRequest extends Omit<
  GetCouponRequest,
  "coupon"
> {}

/**
 * Retrieve a bound Stripe Coupon over HTTP.
 *
 * ### Reading a Coupon
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveCoupon(coupon);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveCoupon extends Binding.Service<
  RetrieveCoupon,
  "Stripe.RetrieveCoupon",
  (
    coupon: Coupon,
  ) => Effect.Effect<
    (
      request?: RetrieveCouponRequest,
    ) => Effect.Effect<StripeCoupon, GetCouponError, RuntimeContext>
  >
> {}

export const RetrieveCoupon = Binding.Service<RetrieveCoupon>(
  "Stripe.RetrieveCoupon",
);
