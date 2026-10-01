import type {
  GetProductError,
  GetProductRequest,
  Product as StripeProduct,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Product } from "./Product.ts";

export interface RetrieveProductRequest extends Omit<GetProductRequest, "id"> {}

/**
 * Retrieve a bound Stripe Product over HTTP. Pass the Product resource,
 * a `prod_…` id string, or an Effect resolving to a Product.
 *
 * ### Reading a Product
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveProduct(product);
 * const live = yield* retrieve();
 * ```
 *
 * **Example:** By id
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveProduct("prod_123");
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveProduct extends Binding.Service<
  RetrieveProduct,
  "Stripe.RetrieveProduct",
  (
    product: string | Product,
  ) => Effect.Effect<
    (
      request?: RetrieveProductRequest,
    ) => Effect.Effect<StripeProduct, GetProductError, RuntimeContext>
  >
> {}

export const RetrieveProduct = Binding.Service<RetrieveProduct>(
  "Stripe.RetrieveProduct",
);
