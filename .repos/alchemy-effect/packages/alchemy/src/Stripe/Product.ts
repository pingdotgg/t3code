import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteProduct,
  GetProducts,
  GetProduct,
  CreateProduct,
  UpdateProduct,
  type Product as StripeProduct,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { arrayEquals } from "../Util/equal.ts";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const NAME_MAX_LENGTH = 250;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export interface ProductProps {
  /**
   * Display name of the product. If omitted, a unique name is generated
   * from the stack, stage, and logical id.
   */
  name?: string;
  /**
   * Description meant to be displayable to the customer.
   */
  description?: string;
  /**
   * Whether the product is available for purchase.
   * @default true
   */
  active?: boolean;
  /**
   * Up to 8 image URLs meant to be displayable to the customer.
   */
  images?: string[];
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type Product = Resource<
  "Stripe.Product",
  ProductProps,
  {
    /** Stripe product id (`prod_…`). */
    id: string;
    /** Display name of the product. */
    name: string;
    /** Description meant to be displayable to the customer. */
    description: string | undefined;
    /** Whether the product is available for purchase. */
    active: boolean;
    /** Image URLs meant to be displayable to the customer. */
    images: string[];
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the product was created. */
    created: number;
    /** Whether the product exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Product — the catalog item that Prices, invoices, and Checkout
 * attach to. Name, description, active, images, and metadata are updated
 * in place. Deleting a product is only possible when it has no Prices.
 *
 * @see https://docs.stripe.com/api/products
 *
 * ### Creating a Product
 * **Example:** Generated name
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan");
 * ```
 *
 * **Example:** Named product with description
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", {
 *   name: "Pro Plan",
 *   description: "Billed monthly",
 * });
 * ```
 *
 * ### Catalog details
 * **Example:** Images, metadata, and inactive product
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", {
 *   name: "Pro Plan",
 *   description: "Billed monthly",
 *   active: false,
 *   images: ["https://example.com/pro.png"],
 *   metadata: { tier: "pro" },
 * });
 * ```
 *
 * ### Destroying a Product
 * **Example:** Delete when it has no prices
 * ```typescript
 * // alchemy destroy deletes the Product. If prices remain, Stripe
 * // rejects the delete and Alchemy archives it (`active: false`).
 * ```
 *
 * @resource
 */
export const Product = Resource<Product>("Stripe.Product");

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }))
    );
  });

const toAttrs = (product: StripeProduct) => ({
  id: product.id,
  name: product.name,
  description: product.description ?? undefined,
  active: product.active,
  images: product.images,
  metadata: userMetadata(product.metadata),
  created: product.created,
  livemode: product.livemode,
});

const isMissingProduct = isMissingStripeResource;

const getById = (id: string) =>
  GetProduct({ id }).pipe(
    Effect.catchIf(isMissingProduct, () => Effect.succeed(undefined)),
  );

const listByActive = Effect.fn(function* (active: boolean) {
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

const listAllProducts = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all(
    [listByActive(true), listByActive(false)],
    { concurrency: 2 },
  );
  const seen = new Set<string>();
  const products: StripeProduct[] = [];
  for (const product of [...active, ...inactive]) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    products.push(product);
  }
  return products;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const products = yield* listAllProducts();
  const matches: StripeProduct[] = [];
  for (const product of products) {
    if (yield* hasAlchemyMetadata(id, tagRecord(product.metadata))) {
      matches.push(product);
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  logicalId: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  return yield* findByAlchemyId(input.logicalId);
});

const desiredMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string> | undefined,
) {
  return {
    ...toMetadata(metadata),
    ...(yield* createInternalMetadata(id)),
  };
});

export const ProductProvider = () =>
  Provider.succeed(Product, {
    stables: ["id", "created", "livemode"],

    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const products = yield* listAllProducts();
      return products
        .filter((product) => {
          const metadata = tagRecord(product.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const name = yield* toName(id, news.name, output?.name);
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredActive = news.active ?? true;
      const desiredDescription = news.description ?? "";
      const desiredImages = news.images ?? [];

      let current = yield* observe({
        id: output?.id,
        logicalId: id,
      });

      if (current === undefined) {
        current = yield* CreateProduct({
          name,
          active: desiredActive,
          ...(desiredDescription.length > 0
            ? { description: desiredDescription }
            : {}),
          ...(desiredImages.length > 0 ? { images: desiredImages } : {}),
          metadata,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-product-${instanceId}`,
          }),
        );
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const nameChanged = current.name !== name;
      const activeChanged = current.active !== desiredActive;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const imagesChanged = !arrayEquals(current.images, desiredImages);

      if (
        !nameChanged &&
        !activeChanged &&
        !descriptionChanged &&
        !imagesChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdateProduct({
        id: current.id,
        ...(nameChanged ? { name } : {}),
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(descriptionChanged ? { description: desiredDescription } : {}),
        ...(imagesChanged
          ? { images: desiredImages.length > 0 ? desiredImages : "" }
          : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(
                  upsert.map((tag) => [tag.Key, tag.Value]),
                ),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteProduct({ id: output.id }).pipe(
        Effect.catchTag("ProductHasPrices", () =>
          UpdateProduct({ id: output.id, active: false }).pipe(
            Effect.catchIf(isMissingProduct, () => Effect.void),
          ),
        ),
        Effect.catchIf(isMissingProduct, () => Effect.void),
      );
    }),
  });
