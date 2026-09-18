import type {
  GetProductFeatureError,
  GetProductFeatureRequest,
  ProductFeature as StripeProductFeature,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ProductFeature } from "./ProductFeature.ts";

export interface RetrieveProductFeatureRequest extends Omit<
  GetProductFeatureRequest,
  "id" | "product"
> {}

/**
 * Retrieve a bound Stripe Product Feature attachment over HTTP.
 *
 * ### Reading a Product Feature
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveProductFeature(seatsOnPro);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveProductFeature extends Binding.Service<
  RetrieveProductFeature,
  "Stripe.RetrieveProductFeature",
  (
    productFeature: ProductFeature,
  ) => Effect.Effect<
    (
      request?: RetrieveProductFeatureRequest,
    ) => Effect.Effect<
      StripeProductFeature,
      GetProductFeatureError,
      RuntimeContext
    >
  >
> {}

export const RetrieveProductFeature = Binding.Service<RetrieveProductFeature>(
  "Stripe.RetrieveProductFeature",
);
