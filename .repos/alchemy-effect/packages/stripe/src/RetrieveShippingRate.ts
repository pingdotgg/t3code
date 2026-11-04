import type {
  GetShippingRateError,
  GetShippingRateRequest,
  ShippingRate as StripeShippingRate,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ShippingRate } from "./ShippingRate.ts";

export interface RetrieveShippingRateRequest extends Omit<
  GetShippingRateRequest,
  "shipping_rate_token"
> {}

/**
 * Retrieve a bound Stripe Shipping Rate over HTTP.
 *
 * ### Reading a Shipping Rate
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveShippingRate(ground);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Product
 */
export interface RetrieveShippingRate extends Binding.Service<
  RetrieveShippingRate,
  "Stripe.RetrieveShippingRate",
  (
    shippingRate: ShippingRate,
  ) => Effect.Effect<
    (
      request?: RetrieveShippingRateRequest,
    ) => Effect.Effect<StripeShippingRate, GetShippingRateError, RuntimeContext>
  >
> {}

export const RetrieveShippingRate = Binding.Service<RetrieveShippingRate>(
  "Stripe.RetrieveShippingRate",
);
