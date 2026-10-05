import * as retail from "@distilled.cloud/gcp/retail_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  MAX_PRODUCT_ID_LENGTH,
  branchName,
  expandCatalog,
  normalizeBranch,
  normalizeLocation,
  parentOf,
  parseResourceName,
  productIdOf,
  replaceOnIdentity,
  sameJson,
  sameStringList,
  sameText,
  toPhysical,
  updateMaskOf,
} from "./internal.ts";

export type ProductPriceInfo = {
  /** ISO 4217 currency code, e.g. `USD`. */
  currencyCode?: string;
  /** Sale price. */
  price?: number;
  /** Price before discount. */
  originalPrice?: number;
  /** Cost of goods sold. */
  cost?: number;
};

export type ProductImage = {
  /** Image URI. */
  uri: string;
  /** Height in pixels. */
  height?: number;
  /** Width in pixels. */
  width?: number;
};

export type CatalogsBranchesProductProps = {
  /**
   * Parent catalog resource name
   * `projects/{project}/locations/{location}/catalogs/{catalog}` or a
   * catalog id (combined with `location`). Immutable — changing it
   * replaces the product.
   * @default "default_catalog"
   */
  catalog?: string;
  /**
   * Location used when `catalog` is a bare id. Immutable.
   * @default "global"
   */
  location?: string;
  /**
   * Branch id. Immutable.
   * @default "default_branch"
   */
  branchId?: string;
  /**
   * Product id (max 128 characters). If omitted, a unique id is
   * generated. Immutable — changing it replaces the product.
   */
  productId?: string;
  /**
   * Product title (max 1,000 characters). Defaults to the product id.
   */
  title?: string;
  /**
   * Product description (max 5,000 characters).
   */
  description?: string;
  /**
   * Category paths, e.g. `Shoes & Accessories > Shoes`. Required for
   * `PRIMARY` products.
   * @default ["Alchemy"]
   */
  categories?: string[];
  /**
   * Product type. Immutable.
   * @default "PRIMARY"
   */
  type?:
    | "TYPE_UNSPECIFIED"
    | "PRIMARY"
    | "VARIANT"
    | "COLLECTION"
    | (string & {});
  /**
   * Canonical product URI.
   */
  uri?: string;
  /**
   * Brand names.
   */
  brands?: string[];
  /**
   * Language of title/description (`en-US`, …).
   */
  languageCode?: string;
  /**
   * Availability.
   * @default "IN_STOCK"
   */
  availability?:
    | "AVAILABILITY_UNSPECIFIED"
    | "IN_STOCK"
    | "OUT_OF_STOCK"
    | "PREORDER"
    | "BACKORDER"
    | (string & {});
  /**
   * Price information.
   */
  priceInfo?: ProductPriceInfo;
  /**
   * Product images.
   */
  images?: ProductImage[];
  /**
   * Custom tags (used for recommendation filters).
   */
  tags?: string[];
  /**
   * GTIN.
   */
  gtin?: string;
  /**
   * Primary product id for `VARIANT` products.
   */
  primaryProductId?: string;
};

export type CatalogsBranchesProduct = Resource<
  "GCP.Retail.CatalogsBranchesProduct",
  CatalogsBranchesProductProps,
  {
    /** Full resource name. */
    name: string;
    /** Product id. */
    productId: string;
    /** Parent catalog resource name. */
    catalog: string;
    /** Branch id. */
    branchId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Title. */
    title: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Categories. */
    categories: string[];
    /** Product type. */
    type: string | undefined;
    /** Canonical URI. */
    uri: string | undefined;
    /** Brands. */
    brands: string[];
    /** Language code. */
    languageCode: string | undefined;
    /** Availability. */
    availability: string | undefined;
    /** Price information. */
    priceInfo: ProductPriceInfo | undefined;
    /** Images. */
    images: ProductImage[];
    /** Custom tags. */
    tags: string[];
    /** GTIN. */
    gtin: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Retail product under a catalog branch.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Catalog, location, branch, product id, and type are immutable. Title,
 * description, categories, price, and tags update in place.
 *
 * ### Creating a Product
 * **Example:** Primary product on the default catalog
 * ```typescript
 * const product = yield* GCP.Retail.CatalogsBranchesProduct("Shirt", {
 *   title: "Cotton tee",
 *   categories: ["Apparel > T-Shirts"],
 *   priceInfo: { currencyCode: "USD", price: 20 },
 * });
 * ```
 *
 * @resource
 * @category Retail
 */
export const CatalogsBranchesProduct = Resource<CatalogsBranchesProduct>(
  "GCP.Retail.CatalogsBranchesProduct",
);

export class CatalogsBranchesProductNotResolved extends Data.TaggedError(
  "GCP.Retail.CatalogsBranchesProductNotResolved",
)<{
  name: string;
}> {}

const priceInfoOf = (
  info: retail.GoogleCloudRetailV2PriceInfo | ProductPriceInfo | undefined,
): ProductPriceInfo | undefined =>
  info === undefined
    ? undefined
    : {
        currencyCode: info.currencyCode,
        price: info.price,
        originalPrice: info.originalPrice,
        cost: info.cost,
      };

const imagesOf = (
  images:
    | readonly retail.GoogleCloudRetailV2Image[]
    | readonly ProductImage[]
    | undefined,
): ProductImage[] =>
  (images ?? [])
    .filter((image) => (image.uri ?? "").length > 0)
    .map((image) => ({
      uri: image.uri ?? "",
      height: image.height,
      width: image.width,
    }));

const toAttrs = (
  product: retail.GoogleCloudRetailV2Product,
  project: string,
) => {
  const name = product.name ?? "";
  const parsed = parseResourceName(name, "products");
  return {
    name,
    productId: product.id ?? parsed.id,
    catalog: parentOf(name, "branches"),
    branchId: parsed.branchId,
    project: parsed.project || project,
    location: parsed.location,
    title: product.title,
    description: product.description,
    categories: [...(product.categories ?? [])],
    type: product.type,
    uri: product.uri,
    brands: [...(product.brands ?? [])],
    languageCode: product.languageCode,
    availability: product.availability,
    priceInfo: priceInfoOf(product.priceInfo),
    images: imagesOf(product.images),
    tags: [...(product.tags ?? [])],
    gtin: product.gtin,
  };
};

const resourceName = (catalog: string, branchId: string, productId: string) =>
  `${branchName(catalog, branchId)}/products/${productId}`;

const toBody = (
  news: CatalogsBranchesProductProps,
  productId: string,
  description: string | undefined,
  tags: string[],
): retail.GoogleCloudRetailV2Product => ({
  id: productId,
  title: news.title ?? productId,
  description,
  categories: news.categories ?? ["Alchemy"],
  type: news.type ?? "PRIMARY",
  uri: news.uri,
  brands: news.brands,
  languageCode: news.languageCode,
  availability: news.availability ?? "IN_STOCK",
  priceInfo: news.priceInfo,
  images: news.images,
  tags,
  gtin: news.gtin,
  primaryProductId: news.primaryProductId,
});

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : retail
        .getProjectsLocationsCatalogsBranchesProducts({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const CatalogsBranchesProductProvider = () =>
  Provider.succeed(CatalogsBranchesProduct, {
    stables: [
      "name",
      "productId",
      "catalog",
      "branchId",
      "project",
      "location",
      "type",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousParent = olds?.catalog ?? output?.catalog;
      const nextParent = expandCatalog(
        news.catalog,
        env.project,
        normalizeLocation(news.location ?? output?.location),
      );
      const previousBranch = olds?.branchId ?? output?.branchId;
      const nextBranch = news.branchId ?? previousBranch;
      const previousType = olds?.type ?? output?.type;
      const nextType = news.type ?? previousType;
      const identity = replaceOnIdentity({
        previousId: olds?.productId ?? output?.productId,
        nextId: news.productId,
        previousParent,
        nextParent,
      });
      if (
        identity !== undefined ||
        (previousBranch !== undefined &&
          nextBranch !== undefined &&
          previousBranch !== nextBranch) ||
        (previousType !== undefined &&
          nextType !== undefined &&
          previousType !== nextType)
      ) {
        return (
          identity ?? {
            action: "replace" as const,
            deleteFirst: true,
          }
        );
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const catalog = olds?.catalog ?? output?.catalog;
      const branchId = normalizeBranch(olds?.branchId ?? output?.branchId);
      const productId = yield* toPhysical(
        id,
        olds?.productId,
        output?.productId,
        productIdOf,
        MAX_PRODUCT_ID_LENGTH,
      );
      const name =
        output?.name ??
        (catalog !== undefined
          ? resourceName(
              expandCatalog(
                catalog,
                env.project,
                normalizeLocation(output?.location),
              ),
              branchId,
              productId,
            )
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const catalog = expandCatalog(news.catalog, env.project, location);
      const branchId = normalizeBranch(news.branchId ?? output?.branchId);
      const productId = yield* toPhysical(
        id,
        news.productId,
        output?.productId,
        productIdOf,
        MAX_PRODUCT_ID_LENGTH,
      );
      const parent = branchName(catalog, branchId);
      const name = resourceName(catalog, branchId, productId);
      const description = news.description;
      const tags = news.tags ?? [];
      const body = toBody(news, productId, description, tags);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retail
          .createProjectsLocationsCatalogsBranchesProducts({
            parent,
            productId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CatalogsBranchesProductNotResolved({ name });
      }

      const resource = current.name ?? name;
      const title = news.title ?? productId;
      const mask = updateMaskOf(
        sameText(current.title, title) ? undefined : "title",
        sameText(current.description, description) ? undefined : "description",
        sameStringList(current.categories, news.categories ?? ["Alchemy"])
          ? undefined
          : "categories",
        sameText(current.uri, news.uri) ? undefined : "uri",
        sameStringList(current.brands, news.brands) ? undefined : "brands",
        sameText(current.languageCode, news.languageCode)
          ? undefined
          : "language_code",
        sameText(current.availability, news.availability ?? "IN_STOCK")
          ? undefined
          : "availability",
        sameJson(priceInfoOf(current.priceInfo), news.priceInfo)
          ? undefined
          : "price_info",
        sameJson(imagesOf(current.images), news.images) ? undefined : "images",
        sameStringList(current.tags, tags) ? undefined : "tags",
        sameText(current.gtin, news.gtin) ? undefined : "gtin",
      );

      if (mask.length > 0) {
        current = yield* retail.patchProjectsLocationsCatalogsBranchesProducts({
          name: resource,
          updateMask: mask,
          body: { ...body, name: resource },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retail
        .deleteProjectsLocationsCatalogsBranchesProducts({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
