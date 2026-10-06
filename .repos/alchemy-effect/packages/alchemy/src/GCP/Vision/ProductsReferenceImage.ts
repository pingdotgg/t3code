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
  deleteReferenceImage,
  getReferenceImage,
  jsonEqual,
  normalizeLocation,
  parseResourceName,
  productNameOf,
  referenceImageNameOf,
  replaceOnIdentity,
  sameText,
  toResourceId,
  waitUntilGone,
} from "./internal.ts";

export type BoundingVertex = {
  /** X coordinate. */
  x?: number;
  /** Y coordinate. */
  y?: number;
};

export type BoundingPoly = {
  /** Vertices in original image coordinates. */
  vertices?: BoundingVertex[];
  /** Vertices normalized to `[0, 1]`. */
  normalizedVertices?: BoundingVertex[];
};

export type ProductsReferenceImageProps = {
  /**
   * Parent product resource name
   * `projects/{project}/locations/{location}/products/{product}` or a
   * product id (combined with `location`). Immutable — changing it
   * replaces the image.
   */
  parent: string;
  /**
   * Product Search location used when `parent` is a bare product id.
   * Immutable.
   * @default "us-west1"
   */
  location?: string;
  /**
   * Reference image id. If omitted, a unique id is generated. Immutable
   * — changing it replaces the image. At most 128 characters; cannot
   * contain `/`.
   */
  referenceImageId?: string;
  /**
   * Google Cloud Storage URI of the image. Must start with `gs://`.
   * Immutable — changing it replaces the image.
   */
  uri: string;
  /**
   * Optional bounding polygons around areas of interest. At most 10.
   * Immutable — changing them replaces the image (no update API).
   */
  boundingPolys?: BoundingPoly[];
};

export type ProductsReferenceImage = Resource<
  "GCP.Vision.ProductsReferenceImage",
  ProductsReferenceImageProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/products/{product}/referenceImages/{image}`. */
    name: string;
    /** Reference image id (last path segment). */
    referenceImageId: string;
    /** Parent product resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Product Search location. */
    location: string;
    /** Cloud Storage URI. */
    uri: string | undefined;
    /** Bounding polygons, if set. */
    boundingPolys: BoundingPoly[];
  },
  never,
  Providers
>;

/**
 * A Cloud Vision Product Search reference image attached to a product.
 *
 * Reference images have no labels or description, so ownership rests on
 * the deterministic image id: an image found without prior state is
 * reported as unowned and only taken over with `--adopt`. Parent, image
 * id, URI, and bounding polygons are identity — there is no update API, so
 * changing any of them replaces the image.
 *
 * ### Creating a Reference Image
 * **Example:** Image on a product
 * ```typescript
 * const product = yield* GCP.Vision.Product("Shoe", {
 *   displayName: "Trail runner",
 *   productCategory: "apparel-v2",
 * });
 * const image = yield* GCP.Vision.ProductsReferenceImage("Hero", {
 *   parent: product.name,
 *   uri: "gs://my-bucket/shoe.png",
 * });
 * ```
 *
 * **Example:** Explicit id and bounding box
 * ```typescript
 * const image = yield* GCP.Vision.ProductsReferenceImage("Hero", {
 *   parent: product.name,
 *   referenceImageId: "hero-front",
 *   uri: "gs://my-bucket/shoe.png",
 *   boundingPolys: [
 *     {
 *       vertices: [
 *         { x: 0, y: 0 },
 *         { x: 320, y: 0 },
 *         { x: 320, y: 320 },
 *         { x: 0, y: 320 },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Vision
 */
export const ProductsReferenceImage = Resource<ProductsReferenceImage>(
  "GCP.Vision.ProductsReferenceImage",
);

export class ProductsReferenceImageNotResolved extends Data.TaggedError(
  "GCP.Vision.ProductsReferenceImageNotResolved",
)<{
  name: string;
}> {}

const toParent = (project: string, location: string, parent: string) =>
  productNameOf(project, location, parent);

const boundingPolysOf = (
  polys: vision.BoundingPolyList | undefined,
): BoundingPoly[] =>
  (polys ?? []).map((poly) => ({
    vertices: poly.vertices?.map((vertex) => ({
      x: vertex.x,
      y: vertex.y,
    })),
    normalizedVertices: poly.normalizedVertices?.map((vertex) => ({
      x: vertex.x,
      y: vertex.y,
    })),
  }));

const toAttrs = (image: vision.ReferenceImage, project: string) => {
  const name = image.name ?? "";
  const parsed = parseResourceName(name, project, "referenceImages");
  return {
    name,
    referenceImageId: parsed.id,
    parent: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    uri: image.uri,
    boundingPolys: boundingPolysOf(image.boundingPolys),
  };
};

export const ProductsReferenceImageProvider = () =>
  Provider.succeed(ProductsReferenceImage, {
    stables: [
      "name",
      "referenceImageId",
      "parent",
      "project",
      "location",
      "uri",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousPolys = olds?.boundingPolys ?? output?.boundingPolys;
      return replaceOnIdentity({
        previousId: olds?.referenceImageId ?? output?.referenceImageId,
        nextId: news.referenceImageId,
        previousParent: olds?.parent ?? output?.parent,
        nextParent: toParent(env.project, location, news.parent),
        extra:
          (olds?.uri !== undefined || output?.uri !== undefined) &&
          !sameText(news.uri, olds?.uri ?? output?.uri)
            ? true
            : previousPolys !== undefined &&
              news.boundingPolys !== undefined &&
              !jsonEqual(previousPolys, news.boundingPolys),
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const parent = toParent(
        env.project,
        location,
        olds?.parent ?? output?.parent ?? "",
      );
      const name =
        output?.name ??
        referenceImageNameOf(
          parent,
          olds?.referenceImageId ?? output?.referenceImageId ?? "",
        );
      const existing = yield* getReferenceImage(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const parent = toParent(env.project, location, news.parent);
      const referenceImageId = yield* toResourceId(
        id,
        news.referenceImageId,
        output?.referenceImageId,
      );
      const name =
        output?.name ?? referenceImageNameOf(parent, referenceImageId);

      let current = yield* getReferenceImage(name);

      if (current === undefined) {
        const created = yield* vision
          .createProjectsLocationsProductsReferenceImages({
            parent,
            referenceImageId,
            body: {
              uri: news.uri,
              boundingPolys: news.boundingPolys,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getReferenceImage(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ProductsReferenceImageNotResolved({
          name: name || referenceImageNameOf(parent, referenceImageId),
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* deleteReferenceImage(output.name);
      yield* waitUntilGone(getReferenceImage(output.name));
    }),
  });
