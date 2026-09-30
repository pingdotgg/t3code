import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteProductFeature,
  GetProducts,
  GetProductFeatures,
  GetProductFeature,
  CreateProductFeature,
  type Product as StripeProduct,
  type ProductFeature as StripeProductFeature,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { alchemyMetadataKeys } from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;
const LIST_CONCURRENCY = 10;

export interface ProductFeatureProps {
  /**
   * Id of the Stripe Product to attach the feature to (`prod_…`).
   * Changing it replaces the attachment.
   */
  product: string;
  /**
   * Id of the Entitlements Feature to attach (`feat_…`). Changing it
   * replaces the attachment.
   */
  entitlementFeature: string;
}

export type ProductFeature = Resource<
  "Stripe.ProductFeature",
  ProductFeatureProps,
  {
    /** Stripe product-feature id (`prodft_…`). */
    id: string;
    /** Id of the product this feature is attached to (`prod_…`). */
    product: string;
    /** Id of the attached entitlements feature (`feat_…`). */
    entitlementFeature: string;
    /** Whether the attachment exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Product Feature — the attachment of an Entitlements Feature
 * to a Product. When a customer purchases a product that has a feature
 * attached, Stripe creates an entitlement to that feature. Existence-only:
 * there is nothing to update in place; changing `product` or
 * `entitlementFeature` replaces the attachment. Destroy deletes it.
 *
 * Product features have no metadata of their own. Ownership for
 * account-wide `list()` (nuke) is inferred from the parent Product's
 * Alchemy metadata.
 *
 * @see https://docs.stripe.com/api/product-feature
 *
 * ### Attaching a Feature
 * **Example:** Attach a feature to a product
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro Plan" });
 * const analytics = yield* Stripe.EntitlementsFeature("analytics", {
 *   lookupKey: "analytics",
 *   name: "Analytics",
 * });
 * const attachment = yield* Stripe.ProductFeature("pro-analytics", {
 *   product: product.id,
 *   entitlementFeature: analytics.id,
 * });
 * ```
 *
 * ### Replacing an Attachment
 * **Example:** Point the product at a different feature
 * ```typescript
 * const reporting = yield* Stripe.EntitlementsFeature("reporting", {
 *   lookupKey: "reporting",
 *   name: "Reporting",
 * });
 * const attachment = yield* Stripe.ProductFeature("pro-analytics", {
 *   product: product.id,
 *   entitlementFeature: reporting.id,
 * });
 * ```
 *
 * @resource
 */
export const ProductFeature = Resource<ProductFeature>("Stripe.ProductFeature");

type ProductFeatureAttributes = ProductFeature["Attributes"];

const toAttrs = (
  product: string,
  feature: StripeProductFeature,
): ProductFeatureAttributes => ({
  id: feature.id,
  product,
  entitlementFeature: feature.entitlement_feature.id,
  livemode: feature.livemode,
});

const isMissing = isMissingStripeResource;

const getById = (product: string, id: string) =>
  GetProductFeature({ product, id }).pipe(
    Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
  );

const listFeatures = Effect.fn(function* (product: string) {
  const features: StripeProductFeature[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetProductFeatures({
      product,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    }).pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));
    if (response === undefined) {
      break;
    }
    features.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return features;
});

const listProductsByActive = Effect.fn(function* (active: boolean) {
  const products: StripeProduct[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetProducts({
      active,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    products.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return products;
});

const listAlchemyProducts = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all(
    [listProductsByActive(true), listProductsByActive(false)],
    { concurrency: 2 },
  );
  const seen = new Set<string>();
  const products: StripeProduct[] = [];
  for (const product of [...active, ...inactive]) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    if (tagRecord(product.metadata)[alchemyMetadataKeys.stack] !== undefined) {
      products.push(product);
    }
  }
  return products;
});

const observe = Effect.fn(function* (input: {
  product?: string;
  id?: string;
  entitlementFeature?: string;
}) {
  if (input.product !== undefined && input.id !== undefined) {
    const byId = yield* getById(input.product, input.id);
    if (byId !== undefined) return byId;
  }
  if (input.product !== undefined && input.entitlementFeature !== undefined) {
    const features = yield* listFeatures(input.product);
    return features.find(
      (feature) => feature.entitlement_feature.id === input.entitlementFeature,
    );
  }
  return undefined;
});

const shouldReplace = (
  news: ProductFeatureProps,
  output: ProductFeatureAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.product !== output.product) return true;
  if (news.entitlementFeature !== output.entitlementFeature) return true;
  return false;
};

export const ProductFeatureProvider = () =>
  Provider.succeed(ProductFeature, {
    stables: ["id", "product", "entitlementFeature", "livemode"],
    nuke: { dependsOn: ["Stripe.Product"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const product =
        output?.product ??
        (typeof olds?.product === "string" ? olds.product : undefined);
      const entitlementFeature =
        output?.entitlementFeature ??
        (typeof olds?.entitlementFeature === "string"
          ? olds.entitlementFeature
          : undefined);
      const existing = yield* observe({
        product,
        id: output?.id,
        entitlementFeature,
      });
      if (existing === undefined || product === undefined) return undefined;
      return toAttrs(product, existing);
    }),

    list: Effect.fn(function* () {
      // Product features have no metadata. Fan out from alchemy-owned
      // products so nuke only tears down attachments we created.
      const products = yield* listAlchemyProducts();
      const rows = yield* Effect.forEach(
        products,
        (product) =>
          listFeatures(product.id).pipe(
            Effect.map((features) =>
              features.map((feature) => toAttrs(product.id, feature)),
            ),
          ),
        { concurrency: LIST_CONCURRENCY },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output, instanceId }) {
      let current = yield* observe({
        product: news.product,
        id: output?.id,
        entitlementFeature: news.entitlementFeature,
      });
      if (
        current !== undefined &&
        shouldReplace(news, toAttrs(news.product, current))
      ) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateProductFeature({
          product: news.product,
          entitlement_feature: news.entitlementFeature,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-product-feature-${instanceId}`,
          }),
          Effect.catchIf(
            (e) => e._tag === "InvalidRequestError" || e._tag === "Conflict",
            (e) =>
              observe({
                product: news.product,
                entitlementFeature: news.entitlementFeature,
              }).pipe(
                Effect.flatMap((found) =>
                  found !== undefined ? Effect.succeed(found) : Effect.fail(e),
                ),
              ),
          ),
        );
      }

      return toAttrs(news.product, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteProductFeature({
        product: output.product,
        id: output.id,
      }).pipe(Effect.catchIf(isMissing, () => Effect.void));
    }),
  });
