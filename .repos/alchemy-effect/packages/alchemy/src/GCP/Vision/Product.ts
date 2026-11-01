import * as vision from "@distilled.cloud/gcp/vision_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_PRODUCT_CATEGORY,
  deleteProduct,
  getProduct,
  locationParent,
  normalizeLocation,
  parseResourceName,
  productLabelsOf,
  productNameOf,
  replaceOnIdentity,
  sameProductLabels,
  sameText,
  toResourceId,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type ProductLabel = {
  /** Label key (max 128 bytes). */
  key: string;
  /** Label value (max 128 bytes). */
  value: string;
};

export type ProductProps = {
  /**
   * Product Search location. Immutable — changing it replaces the
   * product.
   * @default "us-west1"
   */
  location?: string;
  /**
   * Product id (the `{product}` segment of
   * `projects/{project}/locations/{location}/products/{product}`). If
   * omitted, a unique id is generated. Immutable — changing it replaces
   * the product. At most 128 characters; cannot contain `/`.
   */
  productId?: string;
  /**
   * User-facing name (max 4096 characters).
   * @default the product id
   */
  displayName?: string;
  /**
   * User-provided metadata (max 4096 characters).
   */
  description?: string;
  /**
   * Immutable product category. One of `homegoods-v2`, `apparel-v2`,
   * `toys-v2`, `packagedgoods-v1`, or `general-v1`. Changing it replaces
   * the product.
   * @default "homegoods-v2"
   */
  productCategory?: string;
  /**
   * Search labels used to filter Product Search results.
   */
  productLabels?: ProductLabel[];
};

export type Product = Resource<
  "GCP.Vision.Product",
  ProductProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/products/{product}`. */
    name: string;
    /** Product id (last path segment). */
    productId: string;
    /** Project id. */
    project: string;
    /** Product Search location. */
    location: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User-provided metadata. */
    description: string | undefined;
    /** Product category. */
    productCategory: string | undefined;
    /** Product search labels. */
    productLabels: ProductLabel[];
  },
  never,
  Providers
>;

/**
 * A Cloud Vision Product Search product. Products hold reference images
 * and can be added to one or more product sets.
 *
 * Products have no labels field (`productLabels` are search filters), so
 * ownership rests on the deterministic product id: a product found without
 * prior state is reported as unowned and only taken over with `--adopt`.
 * Location, product id, and `productCategory` are identity — changing any
 * of them replaces the product. Display name, description, and labels
 * update in place.
 *
 * ### Creating a Product
 * **Example:** Generated id
 * ```typescript
 * const product = yield* GCP.Vision.Product("Shoe", {
 *   displayName: "Trail runner",
 *   productCategory: "apparel-v2",
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const product = yield* GCP.Vision.Product("Shoe", {
 *   location: "us-west1",
 *   productId: "trail-runner",
 *   displayName: "Trail runner",
 *   productCategory: "apparel-v2",
 *   productLabels: [{ key: "color", value: "blue" }],
 * });
 * ```
 *
 * ### Updating a Product
 * **Example:** Rename and add a label
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const product = yield* GCP.Vision.Product("Shoe", {
 *   location: "us-west1",
 *   productId: "trail-runner",
 *   displayName: "Trail runner v2",
 *   productCategory: "apparel-v2",
 *   productLabels: [{ key: "color", value: "green" }],
 * });
 * ```
 *
 * @resource
 * @category Vision
 */
export const Product = Resource<Product>("GCP.Vision.Product");

export class ProductNotResolved extends Data.TaggedError(
  "GCP.Vision.ProductNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (product: vision.Product, project: string) => {
  const name = product.name ?? "";
  const parsed = parseResourceName(name, project, "products");
  return {
    name,
    productId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: product.displayName,
    description: product.description,
    productCategory: product.productCategory,
    productLabels: productLabelsOf(product.productLabels),
  };
};

export const ProductProvider = () =>
  Provider.succeed(Product, {
    stables: ["name", "productId", "project", "location", "productCategory"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousCategory = olds?.productCategory ?? output?.productCategory;
      const nextCategory =
        news.productCategory ?? previousCategory ?? DEFAULT_PRODUCT_CATEGORY;
      return replaceOnIdentity({
        previousId: olds?.productId ?? output?.productId,
        nextId: news.productId,
        previousParent: locationParent(
          env.project,
          normalizeLocation(olds?.location ?? output?.location),
        ),
        nextParent: locationParent(
          env.project,
          normalizeLocation(news.location ?? output?.location),
        ),
        extra:
          previousCategory !== undefined && previousCategory !== nextCategory,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        productNameOf(
          env.project,
          location,
          olds?.productId ?? output?.productId ?? "",
        );
      const existing = yield* getProduct(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const productId = yield* toResourceId(
        id,
        news.productId,
        output?.productId,
      );
      const displayName = news.displayName ?? productId;
      const description = news.description;
      const productCategory =
        news.productCategory ??
        output?.productCategory ??
        DEFAULT_PRODUCT_CATEGORY;
      const productLabels = productLabelsOf(news.productLabels);
      const name =
        output?.name ?? productNameOf(env.project, location, productId);

      let current = yield* getProduct(name);

      if (current === undefined) {
        const created = yield* vision
          .createProjectsLocationsProducts({
            parent: locationParent(env.project, location),
            productId,
            body: {
              displayName,
              description,
              productCategory,
              productLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getProduct(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ProductNotResolved({
          name: name || productNameOf(env.project, location, productId),
        });
      }

      const currentName = current.name ?? name;
      const observedLabels = productLabelsOf(current.productLabels);
      const updateMask = updateMaskOf(
        sameText(current.displayName, displayName) ? undefined : "display_name",
        sameText(current.description, description) ? undefined : "description",
        sameProductLabels(observedLabels, productLabels)
          ? undefined
          : "product_labels",
      );

      if (updateMask.length > 0) {
        current = yield* vision.patchProjectsLocationsProducts({
          name: currentName,
          updateMask,
          body: {
            name: currentName,
            displayName,
            description,
            productLabels,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* deleteProduct(output.name);
      yield* waitUntilGone(getProduct(output.name));
    }),
  });
