import * as vision from "@distilled.cloud/gcp/vision_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";

// Product Search only exists in PRODUCT_SEARCH_LOCATIONS, so the stack region is not a usable default.
export const DEFAULT_LOCATION = "us-west1";
export const DEFAULT_PRODUCT_CATEGORY = "homegoods-v2";
const MAX_ID_LENGTH = 128;

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const productSetNameOf = (
  project: string,
  location: string,
  productSetId: string,
) => {
  if (productSetId.length === 0) return "";
  if (productSetId.includes("/productSets/")) {
    return productSetId.replace(/\/+$/, "");
  }
  return `${locationParent(project, location)}/productSets/${lastSegment(productSetId)}`;
};

export const productNameOf = (
  project: string,
  location: string,
  productId: string,
) => {
  if (productId.length === 0) return "";
  if (productId.includes("/products/")) {
    return productId.replace(/\/+$/, "");
  }
  return `${locationParent(project, location)}/products/${lastSegment(productId)}`;
};

export const referenceImageNameOf = (parent: string, imageId: string) => {
  if (imageId.length === 0) return "";
  if (imageId.includes("/referenceImages/")) {
    return imageId.replace(/\/+$/, "");
  }
  return `${parent}/referenceImages/${lastSegment(imageId)}`;
};

const expandProductName = (project: string, location: string, value: string) =>
  productNameOf(project, location, value);

export const parseResourceName = (
  name: string,
  fallbackProject: string,
  collection: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    name,
    project:
      projectsAt >= 0 && parts[projectsAt + 1]
        ? parts[projectsAt + 1]!
        : fallbackProject,
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt >= 0
        ? parts.slice(0, collectionAt).join("/")
        : parentOf(name),
  };
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousParent !== undefined &&
    input.nextParent !== undefined &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return lastSegment(requested).slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return lastSegment(existing).slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `v${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );

const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.void,
    ),
  );

export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.Vision.DeleteNotConfirmed",
)<{}> {}

/** Poll until the resource is gone; fails if it is still readable after ~60s. */
export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (value) => value === undefined,
      times: 30,
    }),
    Effect.flatMap((value): Effect.Effect<void, DeleteNotConfirmed> =>
      value === undefined ? Effect.void : Effect.fail(new DeleteNotConfirmed()),
    ),
  );

const collectPages = <Page, Item, E extends { readonly _tag: string }, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => emptyList<Item>(),
    ),
  );

export const getProductSet = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(vision.getProjectsLocationsProductSets({ name }));

export const getProduct = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(vision.getProjectsLocationsProducts({ name }));

export const getReferenceImage = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        vision.getProjectsLocationsProductsReferenceImages({ name }),
      );

export const listProductsInSet = (name: string) =>
  name.length === 0
    ? emptyList<vision.Product>()
    : collectPages(
        vision.listProjectsLocationsProductSetsProducts.pages({
          name,
          pageSize: 100,
        }),
        (page) => page.products,
      );

export const productLabelsOf = (
  labels: ReadonlyArray<{ key?: string; value?: string }> | undefined,
): Array<{ key: string; value: string }> =>
  (labels ?? []).flatMap((item) =>
    item.key ? [{ key: item.key, value: item.value ?? "" }] : [],
  );

export const sameProductLabels = (
  left: ReadonlyArray<{ key: string; value: string }> | undefined,
  right: ReadonlyArray<{ key: string; value: string }> | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].map((item) => `${item.key}=${item.value}`).sort(),
    [...(right ?? [])].map((item) => `${item.key}=${item.value}`).sort(),
  );

export const deleteProductSet = (name: string) =>
  name.length === 0
    ? Effect.void
    : ignoreMissing(vision.deleteProjectsLocationsProductSets({ name }));

export const deleteProduct = (name: string) =>
  name.length === 0
    ? Effect.void
    : ignoreMissing(vision.deleteProjectsLocationsProducts({ name }));

export const deleteReferenceImage = (name: string) =>
  name.length === 0
    ? Effect.void
    : ignoreMissing(
        vision.deleteProjectsLocationsProductsReferenceImages({ name }),
      );

export const syncProductSetMembership = (
  setName: string,
  project: string,
  location: string,
  desired: readonly string[] | undefined,
) =>
  Effect.gen(function* () {
    if (desired === undefined) return;
    const wanted = new Set(
      desired
        .filter((value) => value.length > 0)
        .map((value) => expandProductName(project, location, value)),
    );
    const observed = yield* listProductsInSet(setName);
    const present = new Set(
      observed
        .map((product) => product.name)
        .filter((name): name is string => typeof name === "string"),
    );
    for (const product of wanted) {
      if (present.has(product)) continue;
      yield* vision
        .addProductProjectsLocationsProductSets({
          name: setName,
          body: { product },
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.void));
    }
    for (const product of present) {
      if (wanted.has(product)) continue;
      yield* vision
        .removeProductProjectsLocationsProductSets({
          name: setName,
          body: { product },
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });
