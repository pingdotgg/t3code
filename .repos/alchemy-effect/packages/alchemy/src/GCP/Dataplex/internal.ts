import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import { tagRecord } from "../../Tags.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";

export const MAX_NAME_LENGTH = 63;

export const GENERIC_ENTRY_TYPE =
  "projects/dataplex-types/locations/global/entryTypes/generic";

export const RELATED_ENTRY_LINK_TYPE =
  "projects/dataplex-types/locations/global/entryLinkTypes/related";

export class DataplexNotResolved extends Data.TaggedError(
  "GCP.Dataplex.ResourceNotResolved",
)<{
  name: string;
}> {}

export class DataplexStillExists extends Data.TaggedError(
  "GCP.Dataplex.ResourceStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

export const rfc1035 = (
  name: string,
  fallbackOrMax: string | number = "dataplex",
): string => {
  const maxLength =
    typeof fallbackOrMax === "number" ? fallbackOrMax : MAX_NAME_LENGTH;
  const fallback =
    typeof fallbackOrMax === "string" ? fallbackOrMax : "dataplex";
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `d${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, fallback);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const orgsAt = parts.lastIndexOf("organizations");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    organization: orgsAt >= 0 && parts[orgsAt + 1] ? parts[orgsAt + 1]! : "",
    // API resource names always carry a `locations/{location}` segment.
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    id:
      collectionAt >= 0
        ? parts.slice(collectionAt + 1).join("/")
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const expandParent = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `projects/${project}/locations/${location}/${collection}/${value}`;
};

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${lastSegment(location).toLowerCase()}`;

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

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

export const retryQuota = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "TooManyRequests",
      times: 8,
      schedule: Schedule.exponential("2 seconds"),
    }),
  );

/**
 * Wait for a Dataplex operation; lakes, zones, and assets provision for
 * several minutes. ALREADY_EXISTS (code 6) counts as success (create
 * race); with `notFoundOk`, so does NOT_FOUND (code 5, delete race) and an
 * operation that is already gone.
 */
export const waitForOperation = (
  operation: dataplex.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      retryQuota(
        name.startsWith("organizations/")
          ? dataplex.getOrganizationsLocationsOperations({ name })
          : dataplex.getProjectsLocationsOperations({ name }),
      ),
    { budget: "20 minutes", interval: "2 seconds" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        (error._tag === "GCP.OperationFailed" &&
          (error.code === 6 ||
            (options?.notFoundOk === true && error.code === 5))) ||
        (options?.notFoundOk === true && error._tag === "NotFound"),
      () => Effect.succeed(operation),
    ),
  );

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(new DataplexNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataplex.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : Effect.fail(new DataplexStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataplex.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listAtLocation = <A, E, R>(
  project: string,
  region: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
) =>
  // Prefer the all-locations wildcard; fall back to the default region
  // (whose error, if any, propagates).
  list(`projects/${project}/locations/-`).pipe(
    Effect.catch(() => list(`projects/${project}/locations/${region}`)),
  );

export const replaceOnIdentity = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
  previousLocation: string;
  nextLocation: string;
  extra?: boolean;
  previousParent?: string;
  nextParent?: string;
}) => {
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    lastSegment(input.previousParent ?? "") !==
      lastSegment(input.nextParent ?? "") &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
  const replace =
    (input.extra ?? false) ||
    parentChanged ||
    (input.previousId !== undefined &&
      input.nextId !== undefined &&
      input.nextId !== input.previousId) ||
    input.previousLocation !== input.nextLocation;
  if (!replace) return undefined;
  const samePhysical =
    input.previousLocation === input.nextLocation &&
    !parentChanged &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

export const isPendingState = (state: string | undefined) =>
  state === "CREATING" ||
  state === "DELETING" ||
  state === "UPDATING" ||
  state === "STATE_UNSPECIFIED" ||
  state === undefined ||
  state === "";

export const snakeId = (name: string, maxLength = 256): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(next)) next = `e${next}`;
  next = next.slice(0, maxLength).replace(/_+$/g, "");
  if (next.length === 0) return "entity";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const toPhysicalSnake = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = 256,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return snakeId(explicit, maxLength);
    if (existing !== undefined) return existing;
    return snakeId(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
        delimiter: "_",
      }),
      maxLength,
    );
  });

export const createOwnership = (id: string) => createInternalLabels(id);

export const ownedLabels = (id: string, labels: Record<string, string>) =>
  hasAlchemyLabels(id, labels);

export const parseResourceName = parseName;
export const locationParent = parentOf;
export const hasAlchemyLabelKeys = hasAlchemyLabelMap;
export const LABELS_FILTER = "labels.alchemy-id:*";
export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);
export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].sort()) ===
  JSON.stringify([...(right ?? [])].sort());
export const toResourceId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) => toPhysicalId(id, explicit, existing, "dataplex");
export const updateMaskOf = (
  fields: ReadonlyArray<readonly [boolean, string]>,
): string =>
  fields
    .filter(([changed]) => changed)
    .map(([, field]) => field)
    .join(",");
export const emptyOnMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A[], E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.succeed([] as A[]),
    ),
  );
