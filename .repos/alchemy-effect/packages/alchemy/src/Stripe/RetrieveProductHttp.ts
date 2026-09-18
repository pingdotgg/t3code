import { GetProduct } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import type { Product } from "./Product.ts";
import { RetrieveProduct } from "./RetrieveProduct.ts";
import {
  asStringEffect,
  attachStripeToken,
  authorizeWith,
  resolveStripeAuth,
} from "./StripeHttp.ts";

type ProductInput = string | Product;

/**
 * HTTP implementation of {@link RetrieveProduct}. Provide it on the
 * Function or Worker Effect. Accepts a Product resource, a `prod_…` id
 * string, or an Effect resolving to a Product.
 *
 * @layer
 * @provides Stripe.RetrieveProduct
 */
export const RetrieveProductHttp = Layer.effect(
  RetrieveProduct,
  Effect.gen(function* () {
    const ambient = yield* resolveStripeAuth;

    return Effect.fn(function* (product: ProductInput) {
      const host = yield* Binding.Host;
      const isId = typeof product === "string";
      const resource = isId ? undefined : (product as unknown as ResourceLike);
      const bound = yield* attachStripeToken(
        resource,
        ["products_read"],
        "Stripe.RetrieveProduct",
      );
      const id = yield* asStringEffect(
        isId ? product : (product as Product).id,
      );
      const auth =
        host !== undefined ? authorizeWith(bound) : ambient.authorize;
      const label = isId ? product : (product as Product).LogicalId;

      return Effect.fn(`Stripe.RetrieveProduct(${label})`)(
        function* (request?: { expand?: string[] }) {
          return yield* auth(
            GetProduct({
              ...(request ?? {}),
              id: yield* id,
            }),
          );
        },
      );
    });
  }),
);
