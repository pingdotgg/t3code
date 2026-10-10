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
  deleteProductSet,
  getProductSet,
  listProductsInSet,
  locationParent,
  normalizeLocation,
  parseResourceName,
  productSetNameOf,
  replaceOnIdentity,
  sameText,
  syncProductSetMembership,
  toResourceId,
  waitUntilGone,
} from "./internal.ts";

export type ProductSetProps = {
  /**
   * Product Search location. Immutable — changing it replaces the set.
   * @default "us-west1"
   */
  location?: string;
  /**
   * Product set id (the `{productSet}` segment of
   * `projects/{project}/locations/{location}/productSets/{productSet}`).
   * If omitted, a unique id is generated. Immutable — changing it
   * replaces the set. At most 128 characters; cannot contain `/`.
   */
  productSetId?: string;
  /**
   * User-facing name (max 4096 characters).
   * @default the product set id
   */
  displayName?: string;
  /**
   * Product resource names or ids to keep in this set. Omitted leaves
   * membership unchanged; an empty list removes every product.
   */
  products?: string[];
};

export type ProductSet = Resource<
  "GCP.Vision.ProductSet",
  ProductSetProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/productSets/{productSet}`. */
    name: string;
    /** Product set id (last path segment). */
    productSetId: string;
    /** Project id. */
    project: string;
    /** Product Search location. */
    location: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** Product resource names currently in this set. */
    products: string[];
    /** RFC3339 last-index timestamp, if the set has been indexed. */
    indexTime: string | undefined;
    /** Indexing error, if the last index failed. */
    indexError:
      | {
          code: number | undefined;
          message: string | undefined;
        }
      | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Vision Product Search product set.
 *
 * Product sets have no labels field, so ownership rests on the
 * deterministic product set id: a set found without prior state is
 * reported as unowned and only taken over with `--adopt`. Location and
 * product set id are identity — changing either replaces the set. Display
 * name and product membership update in place.
 *
 * ### Creating a Product Set
 * **Example:** Generated id
 * ```typescript
 * const set = yield* GCP.Vision.ProductSet("Catalog", {
 *   displayName: "Summer",
 * });
 * ```
 *
 * **Example:** Explicit id and location
 * ```typescript
 * const set = yield* GCP.Vision.ProductSet("Catalog", {
 *   location: "us-west1",
 *   productSetId: "summer-catalog",
 *   displayName: "Summer",
 * });
 * ```
 *
 * ### Updating a Product Set
 * **Example:** Rename and attach products
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const set = yield* GCP.Vision.ProductSet("Catalog", {
 *   location: "us-west1",
 *   productSetId: "summer-catalog",
 *   displayName: "Fall",
 *   products: [shoe.name],
 * });
 * ```
 *
 * @resource
 * @category Vision
 */
export const ProductSet = Resource<ProductSet>("GCP.Vision.ProductSet");

export class ProductSetNotResolved extends Data.TaggedError(
  "GCP.Vision.ProductSetNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  set: vision.ProductSet,
  project: string,
  products: string[],
) => {
  const name = set.name ?? "";
  const parsed = parseResourceName(name, project, "productSets");
  return {
    name,
    productSetId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: set.displayName,
    products,
    indexTime: set.indexTime,
    indexError:
      set.indexError === undefined
        ? undefined
        : {
            code: set.indexError.code,
            message: set.indexError.message,
          },
  };
};

const productsOf = (name: string) =>
  listProductsInSet(name).pipe(
    Effect.map((products) =>
      products
        .map((product) => product.name)
        .filter((value): value is string => typeof value === "string"),
    ),
  );

export const ProductSetProvider = () =>
  Provider.succeed(ProductSet, {
    stables: ["name", "productSetId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.productSetId ?? output?.productSetId,
        nextId: news.productSetId,
        previousParent: locationParent(
          env.project,
          normalizeLocation(olds?.location ?? output?.location),
        ),
        nextParent: locationParent(
          env.project,
          normalizeLocation(news.location ?? output?.location),
        ),
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        productSetNameOf(
          env.project,
          location,
          olds?.productSetId ?? output?.productSetId ?? "",
        );
      const existing = yield* getProductSet(name);
      if (existing === undefined) return undefined;
      const products = yield* productsOf(existing.name ?? name);
      const attrs = toAttrs(existing, env.project, products);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const productSetId = yield* toResourceId(
        id,
        news.productSetId,
        output?.productSetId,
      );
      const displayName = news.displayName ?? productSetId;
      const name =
        output?.name ?? productSetNameOf(env.project, location, productSetId);

      let current = yield* getProductSet(name);

      if (current === undefined) {
        const created = yield* vision
          .createProjectsLocationsProductSets({
            parent: locationParent(env.project, location),
            productSetId,
            body: { displayName },
          })
          .pipe(Effect.catchTag("Conflict", () => getProductSet(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ProductSetNotResolved({
          name: name || productSetNameOf(env.project, location, productSetId),
        });
      }

      const currentName = current.name ?? name;
      if (!sameText(current.displayName, displayName)) {
        current = yield* vision.patchProjectsLocationsProductSets({
          name: currentName,
          updateMask: "display_name",
          body: { name: currentName, displayName },
        });
      }

      yield* syncProductSetMembership(
        currentName,
        env.project,
        location,
        news.products,
      );
      const products = yield* productsOf(currentName);
      return toAttrs(current, env.project, products);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* deleteProductSet(output.name);
      yield* waitUntilGone(getProductSet(output.name));
    }),
  });
