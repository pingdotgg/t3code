import * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { alchemyLabelKeys } from "../Labels.ts";

export const DEFAULT_LOCATION = "global";
export const DEFAULT_CATALOG = "default_catalog";
export const DEFAULT_CATEGORY = "Alchemy";
export const MAX_ITEM_ID_LENGTH = 128;
export const LIST_LOCATIONS = ["global"] as const;

export type CategoryHierarchy = {
  /** Category path from least to most specific. */
  categories?: string[];
};

export type CatalogItemImage = {
  /** Image URI. */
  uri: string;
  /** Height in pixels. */
  height?: number;
  /** Width in pixels. */
  width?: number;
};

export type CatalogItemExactPrice = {
  /** Display price. */
  displayPrice?: number;
  /** Price before discount. */
  originalPrice?: number;
};

export type CatalogItemPriceRange = {
  /** Minimum price. */
  min?: number;
  /** Maximum price. */
  max?: number;
};

export type ProductCatalogItem = {
  /** Cost map, e.g. `{ manufacturing: 45.5 }`. */
  costs?: Record<string, number | undefined>;
  /** Online stock state. */
  stockState?:
    | "STOCK_STATE_UNSPECIFIED"
    | "IN_STOCK"
    | "OUT_OF_STOCK"
    | "PREORDER"
    | "BACKORDER"
    | (string & {});
  /** Product images. */
  images?: CatalogItemImage[];
  /** Exact product price. */
  exactPrice?: CatalogItemExactPrice;
  /** Canonical product detail URI. */
  canonicalProductUri?: string;
  /** Price range for variants. */
  priceRange?: CatalogItemPriceRange;
  /** ISO-4217 currency code. Required when a price is set. */
  currencyCode?: string;
  /** Available quantity (int64 as a decimal string). */
  availableQuantity?: string;
};

export type FeatureMap = {
  /** Categorical features (`{ colors: { value: ["yellow"] } }`). */
  categoricalFeatures?: Record<string, { value?: string[] } | undefined>;
  /** Numerical features (`{ lengths_cm: { value: [2.3] } }`). */
  numericalFeatures?: Record<string, { value?: number[] } | undefined>;
};

export type CatalogItem =
  recommendationengine.GoogleCloudRecommendationengineV1beta1CatalogItem;

const emptyList = <A>() => Effect.succeed([] as A[]);

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string, collection?: string) => {
  if (collection !== undefined) {
    const marker = `/${collection}/`;
    const index = name.lastIndexOf(marker);
    return index >= 0 ? name.slice(0, index) : name;
  }
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const normalizeCatalog = (catalog: string | undefined) =>
  lastSegment(catalog ?? DEFAULT_CATALOG);

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const catalogName = (
  project: string,
  location: string,
  catalogId: string,
) => `${locationParent(project, location)}/catalogs/${catalogId}`;

export const expandCatalog = (
  value: string | undefined,
  project: string,
  location: string,
) => {
  const raw = (value ?? DEFAULT_CATALOG).replace(/\/+$/, "");
  if (raw.includes("/")) return raw;
  return catalogName(project, location, raw);
};

export const itemName = (catalog: string, catalogItemId: string) =>
  `${catalog}/catalogItems/${catalogItemId}`;

export const parseResourceName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const itemsAt = Math.max(
    parts.lastIndexOf("catalogItems"),
    parts.lastIndexOf("catalogitems"),
  );
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const catalogsAt = parts.lastIndexOf("catalogs");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    catalogId:
      catalogsAt >= 0 && parts[catalogsAt + 1]
        ? parts[catalogsAt + 1]!
        : DEFAULT_CATALOG,
    catalog:
      catalogsAt >= 0
        ? parts.slice(0, catalogsAt + 2).join("/")
        : parentOf(name, "catalogItems"),
    id:
      itemsAt >= 0 && parts[itemsAt + 1]
        ? parts[itemsAt + 1]!
        : lastSegment(name),
    parent:
      itemsAt > 0
        ? parts.slice(0, itemsAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const catalogItemIdOf = (
  name: string,
  maxLength = MAX_ITEM_ID_LENGTH,
) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, maxLength).replace(/[-_]+$/g, "");
  return next.length > 0 ? next : "catalogitem";
};

export const toPhysical = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) return explicit;
    if (existing !== undefined && existing.length > 0) return existing;
    return catalogItemIdOf(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ITEM_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

const parseOwnershipMarker = (text: string) => {
  const labels: Record<string, string> = {};
  const end = text.indexOf("]");
  if (end < 0) return { labels, rest: text };
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return { labels, rest: text.slice(end + 1) };
};

const parseCompactMarker = (text: string) => {
  const end = text.indexOf("]");
  if (!text.startsWith("[alc ") || end < 0) {
    return { labels: {} as Record<string, string>, rest: text };
  }
  const parts = text.slice("[alc ".length, end).split("|");
  const labels: Record<string, string> = {};
  if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0];
  if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1];
  if (parts[2]) labels[alchemyLabelKeys.id] = parts[2];
  return { labels, rest: text.slice(end + 1) };
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text) return { labels: {}, text };
  const compactAt = text.indexOf("[alc ");
  const verboseAt = text.indexOf("[alchemy ");
  if (verboseAt >= 0 && (compactAt < 0 || verboseAt <= compactAt)) {
    const before = text.slice(0, verboseAt).trim();
    const parsed = parseOwnershipMarker(text.slice(verboseAt));
    const after = parsed.rest.replace(/^[\s\n]+/, "");
    const combined = [before, after]
      .filter((part) => part.length > 0)
      .join(" ");
    return {
      labels: parsed.labels,
      text: combined.length > 0 ? combined : undefined,
    };
  }
  if (compactAt >= 0) {
    const before = text.slice(0, compactAt).trim();
    const parsed = parseCompactMarker(text.slice(compactAt));
    const after = parsed.rest.replace(/^[\s\n]+/, "");
    const combined = [before, after]
      .filter((part) => part.length > 0)
      .join(" ");
    return {
      labels: parsed.labels,
      text: combined.length > 0 ? combined : undefined,
    };
  }
  return { labels: {}, text };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  fingerprint([...(left ?? [])].sort()) ===
  fingerprint([...(right ?? [])].sort());

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
}) => {
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
  if (!idChanged && !parentChanged) return undefined;
  return {
    action: "replace" as const,
    deleteFirst: false,
  };
};

export const collectPages = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
  );

export const listCatalogs = (project: string, location: string) =>
  collectPages(
    recommendationengine.listProjectsLocationsCatalogs.pages({
      parent: locationParent(project, location),
      pageSize: 100,
    }),
    (page) => page.catalogs,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      emptyList<recommendationengine.GoogleCloudRecommendationengineV1beta1Catalog>(),
    ),
  );

export const listProjectCatalogs = (project: string) =>
  Effect.forEach(
    LIST_LOCATIONS,
    (location) => listCatalogs(project, location),
    { concurrency: 2 },
  ).pipe(
    Effect.map((groups) => {
      const seen = new Set<string>();
      const catalogs: recommendationengine.GoogleCloudRecommendationengineV1beta1Catalog[] =
        [];
      for (const catalog of groups.flat()) {
        const name = catalog.name ?? "";
        if (name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        catalogs.push(catalog);
      }
      return catalogs;
    }),
  );

export const listCatalogItems = (parent: string) =>
  parent.length === 0
    ? emptyList<CatalogItem>()
    : collectPages(
        recommendationengine.listProjectsLocationsCatalogsCatalogItems.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.catalogItems,
      ).pipe(Effect.catchTag("NotFound", () => emptyList<CatalogItem>()));

export const itemHasOwnership = (item: CatalogItem) =>
  hasOwnershipMarker(item.description) ||
  (item.tags ?? []).some((tag) => hasOwnershipMarker(tag));

export const getCatalogItem = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : recommendationengine
        .getProjectsLocationsCatalogsCatalogItems({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const userTags = (tags: readonly string[] | undefined) =>
  (tags ?? []).filter(
    (tag) => !tag.includes("[alc ") && !tag.includes("[alchemy "),
  );

export const hierarchiesOf = (
  hierarchies:
    | readonly recommendationengine.GoogleCloudRecommendationengineV1beta1CatalogItemCategoryHierarchy[]
    | readonly CategoryHierarchy[]
    | undefined,
): CategoryHierarchy[] =>
  (hierarchies ?? [])
    .map((hierarchy) => ({
      categories: [...(hierarchy.categories ?? [])],
    }))
    .filter((hierarchy) => (hierarchy.categories?.length ?? 0) > 0);

export const defaultHierarchies = (): CategoryHierarchy[] => [
  { categories: [DEFAULT_CATEGORY] },
];

export const imagesOf = (
  images:
    | readonly recommendationengine.GoogleCloudRecommendationengineV1beta1Image[]
    | readonly CatalogItemImage[]
    | undefined,
): CatalogItemImage[] =>
  (images ?? [])
    .filter((image) => (image.uri ?? "").length > 0)
    .map((image) => ({
      uri: image.uri ?? "",
      height: image.height,
      width: image.width,
    }));

export const productMetadataOf = (
  meta:
    | recommendationengine.GoogleCloudRecommendationengineV1beta1ProductCatalogItem
    | ProductCatalogItem
    | undefined,
): ProductCatalogItem | undefined =>
  meta === undefined
    ? undefined
    : {
        costs: meta.costs,
        stockState: meta.stockState,
        images: imagesOf(meta.images),
        exactPrice: meta.exactPrice
          ? {
              displayPrice: meta.exactPrice.displayPrice,
              originalPrice: meta.exactPrice.originalPrice,
            }
          : undefined,
        canonicalProductUri: meta.canonicalProductUri,
        priceRange: meta.priceRange
          ? { min: meta.priceRange.min, max: meta.priceRange.max }
          : undefined,
        currencyCode: meta.currencyCode,
        availableQuantity: meta.availableQuantity,
      };
