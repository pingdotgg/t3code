import type {
  Coupon as StripeCoupon,
  GetCouponError,
  GetCouponRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Coupon } from "./Coupon.ts";

export interface RetrieveCouponRequest extends Omit<GetCouponRequest, "coupon"> {}

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
 * @product Product
 */
export interface RetrieveCoupon extends Binding.Service<
  RetrieveCoupon,
  "Stripe.RetrieveCoupon",
  (
    coupon: Coupon,
  ) => Effect.Effect<
    (request?: RetrieveCouponRequest) => Effect.Effect<StripeCoupon, GetCouponError, RuntimeContext>
  >
> {}

export const RetrieveCoupon = Binding.Service<RetrieveCoupon>("Stripe.RetrieveCoupon");
