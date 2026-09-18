import type {
  GetPriceError,
  GetPriceRequest,
  Price as StripePrice,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Price } from "./Price.ts";

export interface RetrievePriceRequest extends Omit<GetPriceRequest, "price"> {}

/**
 * Retrieve a bound Stripe Price over HTTP.
 *
 * ### Reading a Price
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrievePrice(price);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrievePrice extends Binding.Service<
  RetrievePrice,
  "Stripe.RetrievePrice",
  (
    price: Price,
  ) => Effect.Effect<
    (
      request?: RetrievePriceRequest,
    ) => Effect.Effect<StripePrice, GetPriceError, RuntimeContext>
  >
> {}

export const RetrievePrice = Binding.Service<RetrievePrice>(
  "Stripe.RetrievePrice",
);
