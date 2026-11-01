import * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type CatalogItem,
  type CategoryHierarchy,
  type FeatureMap,
  type ProductCatalogItem,
  DEFAULT_LOCATION,
  defaultHierarchies,
  expandCatalog,
  getCatalogItem,
  hierarchiesOf,
  itemHasOwnership,
  itemName,
  listCatalogItems,
  listProjectCatalogs,
  normalizeLocation,
  parseOwnership,
  parseResourceName,
  productMetadataOf,
  replaceOnIdentity,
  sameJson,
  sameStringList,
  sameText,
  toPhysical,
  updateMaskOf,
  userTags,
} from "./internal.ts";

export type {
  CatalogItemExactPrice,
  CatalogItemImage,
  CatalogItemPriceRange,
  CategoryHierarchy,
  FeatureMap,
  ProductCatalogItem,
} from "./internal.ts";

export type CatalogsCatalogItemProps = {
  /**
   * Parent catalog resource name
   * `projects/{project}/locations/{location}/catalogs/{catalog}` or a
   * catalog id (combined with `location`). Immutable — changing it
   * replaces the catalog item.
   * @default "default_catalog"
   */
  catalog?: string;
  /**
   * Location used when `catalog` is a bare id. Immutable.
   * Recommendations AI catalogs live at `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Catalog item id (max 128 bytes). If omitted, a unique id is
   * generated. Immutable — changing it replaces the item.
   */
  catalogItemId?: string;
  /**
   * Catalog item title (max 1 KiB). Defaults to the catalog item id.
   */
  title?: string;
  /**
   * Catalog item description (max 5 KiB).
   */
  description?: string;
  /**
   * Parallel category hierarchies. Required by the API. Defaults to a
   * single `Alchemy` category.
   * @default [{ categories: ["Alchemy"] }]
   */
  categoryHierarchies?: CategoryHierarchy[];
  /**
   * Filtering tags (max 1 KiB each).
   */
  tags?: string[];
  /**
   * Variant group identifier for prediction results (max 128 bytes).
   */
  itemGroupId?: string;
  /**
   * Deprecated language hint. The model detects language automatically.
   */
  languageCode?: string;
  /**
   * Retail product metadata (price, stock, images).
   */
  productMetadata?: ProductCatalogItem;
  /**
   * Extra categorical and numerical features for the recommendation
   * model.
   */
  itemAttributes?: FeatureMap;
};

export type CatalogsCatalogItem = Resource<
  "GCP.RecommendationEngine.CatalogsCatalogItem",
  CatalogsCatalogItemProps,
  {
    /** Full resource name. */
    name: string;
    /** Catalog item id. */
    catalogItemId: string;
    /** Parent catalog resource name. */
    catalog: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Title. */
    title: string | undefined;
    /** Description (a legacy Alchemy ownership prefix is stripped). */
    description: string | undefined;
    /** Category hierarchies. */
    categoryHierarchies: CategoryHierarchy[];
    /** Tags (legacy Alchemy ownership markers are stripped). */
    tags: string[];
    /** Variant group id. */
    itemGroupId: string | undefined;
    /** Language code. */
    languageCode: string | undefined;
    /** Retail product metadata. */
    productMetadata: ProductCatalogItem | undefined;
    /** Extra item attributes. */
    itemAttributes: FeatureMap | undefined;
  },
  never,
  Providers
>;

/**
 * A Recommendations AI catalog item.
 *
 * Catalog items have no labels field. Their description and tags feed
 * recommendations, so Alchemy writes no ownership marker into them: a
 * generated item id identifies the item, and `read` reports an explicit
 * id it has no state for as unowned.
 * Catalog, location, and item id are immutable. Title, description,
 * categories, tags, and product metadata update in place.
 *
 * ### Creating a Catalog Item
 * **Example:** Item on the default catalog
 * ```typescript
 * const item = yield* GCP.RecommendationEngine.CatalogsCatalogItem("Shirt", {
 *   title: "Cotton tee",
 *   categoryHierarchies: [{ categories: ["Apparel", "T-Shirts"] }],
 *   productMetadata: {
 *     currencyCode: "USD",
 *     exactPrice: { displayPrice: 20 },
 *     stockState: "IN_STOCK",
 *   },
 * });
 * ```
 *
 * **Example:** Explicit catalog and item id
 * ```typescript
 * const item = yield* GCP.RecommendationEngine.CatalogsCatalogItem("Shirt", {
 *   catalog: "default_catalog",
 *   location: "global",
 *   catalogItemId: "cotton-tee",
 *   title: "Cotton tee",
 *   description: "Soft cotton t-shirt",
 * });
 * ```
 *
 * ### Updating a Catalog Item
 * **Example:** Change title and price
 * ```typescript
 * const item = yield* GCP.RecommendationEngine.CatalogsCatalogItem("Shirt", {
 *   title: "Linen tee",
 *   categoryHierarchies: [{ categories: ["Apparel", "T-Shirts"] }],
 *   productMetadata: {
 *     currencyCode: "USD",
 *     exactPrice: { displayPrice: 24 },
 *   },
 * });
 * ```
 *
 * @resource
 * @category RecommendationEngine
 */
export const CatalogsCatalogItem = Resource<CatalogsCatalogItem>(
  "GCP.RecommendationEngine.CatalogsCatalogItem",
);

export class CatalogsCatalogItemNotResolved extends Data.TaggedError(
  "GCP.RecommendationEngine.CatalogsCatalogItemNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (item: CatalogItem, project: string, nameHint?: string) => {
  const hinted = nameHint && nameHint.includes("/") ? nameHint : "";
  const parsed = parseResourceName(hinted);
  const catalogItemId = item.id ?? parsed.id;
  const location = parsed.location || DEFAULT_LOCATION;
  const catalog =
    parsed.catalog.length > 0
      ? parsed.catalog
      : expandCatalog(undefined, project, location);
  const name =
    hinted.includes("/catalogItems/") || hinted.includes("/catalogitems/")
      ? hinted
      : itemName(catalog, catalogItemId);
  const ownership = parseOwnership(item.description);
  return {
    name,
    catalogItemId,
    catalog,
    project: parsed.project || project,
    location,
    title: item.title,
    description: ownership.text,
    categoryHierarchies: hierarchiesOf(item.categoryHierarchies),
    tags: userTags(item.tags),
    itemGroupId: item.itemGroupId,
    languageCode: item.languageCode,
    productMetadata: productMetadataOf(item.productMetadata),
    itemAttributes: item.itemAttributes,
  };
};

const toBody = (
  news: CatalogsCatalogItemProps,
  catalogItemId: string,
  description: string,
  tags: string[],
): CatalogItem => ({
  id: catalogItemId,
  title: news.title ?? catalogItemId,
  description,
  categoryHierarchies: news.categoryHierarchies ?? defaultHierarchies(),
  tags,
  itemGroupId: news.itemGroupId,
  languageCode: news.languageCode,
  productMetadata: news.productMetadata,
  itemAttributes: news.itemAttributes,
});

export const CatalogsCatalogItemProvider = () =>
  Provider.succeed(CatalogsCatalogItem, {
    stables: ["name", "catalogItemId", "catalog", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousParent = olds?.catalog ?? output?.catalog;
      const nextParent = expandCatalog(
        news.catalog,
        env.project,
        normalizeLocation(news.location ?? output?.location),
      );
      return replaceOnIdentity({
        previousId: olds?.catalogItemId ?? output?.catalogItemId,
        nextId: news.catalogItemId,
        previousParent,
        nextParent,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const catalog =
        output?.catalog ?? expandCatalog(olds?.catalog, env.project, location);
      const catalogItemId = yield* toPhysical(
        id,
        olds?.catalogItemId,
        output?.catalogItemId,
      );
      const name = output?.name ?? itemName(catalog, catalogItemId);
      const existing = yield* getCatalogItem(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, name);
      // Description and tags feed recommendations, so they carry no
      // ownership marker: a generated id derives from this stack, stage,
      // logical id and instance; an explicit id is only ours when state
      // has it.
      return output !== undefined || olds?.catalogItemId === undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const catalogs = yield* listProjectCatalogs(env.project);
        const pages = yield* Effect.forEach(
          catalogs,
          (catalog) =>
            catalog.name
              ? listCatalogItems(catalog.name).pipe(
                  Effect.map((items) =>
                    items
                      .filter(itemHasOwnership)
                      .map((item) => toAttrs(item, env.project, catalog.name)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const catalog = expandCatalog(news.catalog, env.project, location);
      const catalogItemId = yield* toPhysical(
        id,
        news.catalogItemId,
        output?.catalogItemId,
      );
      const name = itemName(catalog, catalogItemId);
      const description = news.description ?? "";
      const tags = news.tags ?? [];
      const body = toBody(news, catalogItemId, description, tags);

      let current = yield* getCatalogItem(output?.name ?? name);

      if (current === undefined) {
        const created = yield* recommendationengine
          .createProjectsLocationsCatalogsCatalogItems({
            parent: catalog,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getCatalogItem(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CatalogsCatalogItemNotResolved({ name });
      }

      const title = news.title ?? catalogItemId;
      const desiredHierarchies =
        news.categoryHierarchies ?? defaultHierarchies();
      const mask = updateMaskOf(
        sameText(current.title, title) ? undefined : "title",
        sameText(current.description, description) ? undefined : "description",
        sameJson(hierarchiesOf(current.categoryHierarchies), desiredHierarchies)
          ? undefined
          : "categoryHierarchies",
        sameStringList(current.tags, tags) ? undefined : "tags",
        sameText(current.itemGroupId, news.itemGroupId)
          ? undefined
          : "itemGroupId",
        sameText(current.languageCode, news.languageCode)
          ? undefined
          : "languageCode",
        sameJson(
          productMetadataOf(current.productMetadata),
          news.productMetadata,
        )
          ? undefined
          : "productMetadata",
        sameJson(current.itemAttributes, news.itemAttributes)
          ? undefined
          : "itemAttributes",
      );

      if (mask.length > 0) {
        current =
          yield* recommendationengine.patchProjectsLocationsCatalogsCatalogItems(
            {
              name,
              updateMask: mask,
              body: { ...body, id: catalogItemId },
            },
          );
      }

      return toAttrs(current, env.project, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* recommendationengine
        .deleteProjectsLocationsCatalogsCatalogItems({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
