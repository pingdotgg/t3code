import { GetProductFeature } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import type { ProductFeature } from "./ProductFeature.ts";
import { RetrieveProductFeature } from "./RetrieveProductFeature.ts";
import {
  asStringEffect,
  attachStripeToken,
  authorizeWith,
  resolveStripeAuth,
} from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveProductFeature}. The list-item
 * retrieve takes both `product` and `id`.
 *
 * @layer
 * @provides Stripe.RetrieveProductFeature
 */
export const RetrieveProductFeatureHttp = Layer.effect(
  RetrieveProductFeature,
  Effect.gen(function* () {
    const ambient = yield* resolveStripeAuth;

    return Effect.fn(function* (feature: ProductFeature) {
      const host = yield* Binding.Host;
      const bound = yield* attachStripeToken(
        feature as unknown as ResourceLike,
        ["products_read"],
        "Stripe.RetrieveProductFeature",
      );
      const id = yield* asStringEffect(feature.id);
      const product = yield* asStringEffect(feature.product);
      const auth =
        host !== undefined ? authorizeWith(bound) : ambient.authorize;

      return Effect.fn(`Stripe.RetrieveProductFeature(${feature.LogicalId})`)(
        function* (request?: { expand?: string[] }) {
          return yield* auth(
            GetProductFeature({
              ...(request ?? {}),
              id: yield* id,
              product: yield* product,
            }),
          );
        },
      );
    });
  }),
);
