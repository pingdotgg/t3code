import * as biglake from "@distilled.cloud/gcp/biglake_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

/** Locations `list` scans: the pre-`GCP.Region` default plus the stack region. */
export const listLocations = (region: string): string[] => [
  ...new Set(["us-central1", region]),
];
export const MAX_ID_LENGTH = 63;

export class BiglakeNotResolved extends Data.TaggedError(
  "GCP.BigLake.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => {
  const raw = lastSegment(location ?? fallback);
  const upper = raw.toUpperCase();
  if (upper === "US" || upper === "EU") return upper;
  return raw.toLowerCase();
};

export const parseResourceName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const catalogsAt = parts.lastIndexOf("catalogs");
  const databasesAt = parts.lastIndexOf("databases");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    catalogId:
      catalogsAt >= 0 && parts[catalogsAt + 1] ? parts[catalogsAt + 1]! : "",
    catalog: catalogsAt >= 0 ? parts.slice(0, catalogsAt + 2).join("/") : "",
    databaseId:
      databasesAt >= 0 && parts[databasesAt + 1] ? parts[databasesAt + 1]! : "",
    database: databasesAt >= 0 ? parts.slice(0, databasesAt + 2).join("/") : "",
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const expandCatalog = (
  value: string,
  project: string,
  location: string,
) =>
  value.includes("/catalogs/")
    ? value.replace(/\/+$/, "")
    : `${locationParent(project, location)}/catalogs/${value}`;

export const expandDatabase = (
  value: string,
  project: string,
  location: string,
  catalog?: string,
) => {
  if (value.includes("/databases/")) return value.replace(/\/+$/, "");
  const parent =
    catalog !== undefined && catalog.length > 0
      ? expandCatalog(catalog, project, location)
      : locationParent(project, location);
  return `${parent}/databases/${value}`;
};

export const rfc1035 = (name: string, maxLength = MAX_ID_LENGTH): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, maxLength).replace(/_+$/g, "");
  if (next.length === 0) return "catalog";
  if (next.length < 2) next = `${next}x`.slice(0, maxLength);
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
        delimiter: "_",
      }),
      maxLength,
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const ownershipMarker = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

export const parseOwnershipMarker = (text: string | undefined) => {
  if (!text?.includes("[alchemy ")) return {} as Record<string, string>;
  const start = text.indexOf("[alchemy ");
  const end = text.indexOf("]", start);
  if (end < 0) return {} as Record<string, string>;
  const labels: Record<string, string> = {};
  for (const part of text.slice(start + "[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return labels;
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnershipMarker(text)).some((key) =>
    key.startsWith("alchemy-"),
  );

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

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

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  previousLocation?: string;
  nextLocation?: string;
}) => {
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== input.nextParent;
  const locationChanged =
    (input.previousLocation ?? "") !== "" &&
    (input.nextLocation ?? "") !== "" &&
    (input.previousLocation ?? "") !== input.nextLocation;
  if (!idChanged && !parentChanged && !locationChanged) return undefined;
  const samePhysical =
    !parentChanged &&
    !locationChanged &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: isTransientGcpError,
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

/**
 * BigLake answers a missing catalog, database or table with 403 "... (or it
 * may not exist)", typed `BigLakeResourceNotFound`.
 */
const isMissing = (error: { readonly _tag: string }) =>
  error._tag === "NotFound" || error._tag === "BigLakeResourceNotFound";

export const ignoreGone = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (
        error,
      ): error is Extract<
        E,
        { readonly _tag: "NotFound" | "BigLakeResourceNotFound" }
      > => isMissing(error),
      () => Effect.void,
    ),
  );

export const missingGet =
  <A, E extends { readonly _tag: string }, R>(
    effect: (input: { name: string }) => Effect.Effect<A, E, R>,
  ) =>
  (name: string) =>
    name.length === 0
      ? Effect.succeed(undefined)
      : effect({ name }).pipe(
          Effect.catchIf(
            (
              error,
            ): error is Extract<
              E,
              { readonly _tag: "NotFound" | "BigLakeResourceNotFound" }
            > => isMissing(error),
            () => Effect.succeed(undefined),
          ),
        );

const emptyList = <A>() => Effect.succeed<A[]>([]);

export const collectPages = <
  Page,
  Item,
  E extends { readonly _tag: string },
  R,
>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
    Effect.catchIf(
      (
        error,
      ): error is Extract<
        E,
        { readonly _tag: "NotFound" | "BigLakeResourceNotFound" }
      > => isMissing(error),
      () => emptyList<Item>(),
    ),
  );

export const listCatalogs = (parent: string) =>
  parent.length === 0
    ? emptyList<biglake.Catalog>()
    : collectPages(
        biglake.listProjectsLocationsCatalogs.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.catalogs,
      );

export const listDatabases = (parent: string) =>
  parent.length === 0
    ? emptyList<biglake.Database>()
    : collectPages(
        biglake.listProjectsLocationsCatalogsDatabases.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.databases,
      );

export const listTables = (parent: string) =>
  parent.length === 0
    ? emptyList<biglake.Table>()
    : collectPages(
        biglake.listProjectsLocationsCatalogsDatabasesTables.pages({
          parent,
          pageSize: 1000,
          view: "FULL",
        }),
        (page) => page.tables,
      );

export const namedOf = <T extends { name?: string }>(items: readonly T[]) =>
  items.filter((item) => (item.name ?? "").length > 0);

export const listChildResources = <A, E, R>(
  parents: readonly { name?: string }[],
  list: (name: string) => Effect.Effect<A[], E, R>,
) =>
  Effect.forEach(namedOf(parents), (parent) => list(parent.name!), {
    concurrency: 4,
  }).pipe(Effect.map((groups) => groups.flat()));

export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.BigLake.DeleteNotConfirmed",
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

export const mergeParameters = (
  parameters: Record<string, string> | undefined,
  ownership: Record<string, string>,
): Record<string, string> => ({
  ...tagRecord(parameters),
  ...ownership,
});

export { createInternalLabels, hasAlchemyLabels, toLabels };
