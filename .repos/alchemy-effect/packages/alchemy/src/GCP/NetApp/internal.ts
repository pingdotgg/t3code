import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";
import {
  waitForOperation as waitForLongRunning,
  type LongRunningOperation,
} from "../Operation.ts";

export const MAX_NAME_LENGTH = 63;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.NetApp.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.NetApp.ResourceStillExists",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.NetApp.ResourceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ResourceFailed extends Data.TaggedError(
  "GCP.NetApp.ResourceFailed",
)<{
  name: string;
  state: string;
  details: string | undefined;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "netapp"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `n${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${lastSegment(location).toLowerCase()}`;

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "netapp",
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

export const parseName = (
  name: string,
  collection: string,
  fallbackLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
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

export const networkName = (project: string, network: string | undefined) => {
  const value = network ?? "default";
  if (value.includes("/")) return value;
  return `projects/${project}/global/networks/${value}`;
};

export const gibOf = (
  value: number | string | undefined,
): string | undefined => (value === undefined ? undefined : String(value));

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const sortedStrings = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])].map((value) => value).sort();

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));

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

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

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

// A KMS config parks in KEY_CHECK_PENDING until the NetApp service agent is
// granted the key and `verify` is called — a settled state, not provisioning.
const READY_STATES = new Set([
  "READY",
  "IN_USE",
  "READ_ONLY",
  "KEY_CHECK_PENDING",
]);
const FAILED_STATES = new Set(["ERROR", "KEY_NOT_REACHABLE"]);

export const isReadyState = (state: string | undefined) =>
  READY_STATES.has((state ?? "").toUpperCase());

export const isFailedState = (state: string | undefined) =>
  FAILED_STATES.has((state ?? "").toUpperCase());

// NetApp pool, volume, backup, and replication operations routinely run for
// several minutes; poll for up to ~10 minutes before giving up.
export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
): Effect.Effect<A & {}, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A & {} => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.NetApp.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.NetApp.ResourceStillExists",
      times: OPERATION_POLLS,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.asVoid,
  );

export const waitUntilReady = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
  stateOf: (value: A & {}) => string | undefined,
  detailsOf?: (value: A & {}) => string | undefined,
  options?: {
    times?: number;
    interval?: `${number} seconds`;
  },
): Effect.Effect<
  A & {},
  E | ResourceNotResolved | ResourceNotReady | ResourceFailed,
  R
> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A & {} => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !isFailedState(stateOf(value)),
      (value) =>
        new ResourceFailed({
          name,
          state: stateOf(value) ?? "",
          details: detailsOf?.(value),
        }),
    ),
    Effect.filterOrFail(
      (value) => {
        const state = stateOf(value) ?? "";
        return isReadyState(state) || state.length === 0;
      },
      (value) => new ResourceNotReady({ name, state: stateOf(value) ?? "" }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetApp.ResourceNotReady" ||
        error._tag === "GCP.NetApp.ResourceNotResolved",
      times: options?.times ?? OPERATION_POLLS,
      schedule: Schedule.spaced(options?.interval ?? "5 seconds"),
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

/** Every location at once: the API accepts the `locations/-` wildcard. */
export const listAtLocation = <A, E, R>(
  project: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
) => list(`projects/${project}/locations/-`);

export const volumeOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "volumes");

export const storagePoolOf = (
  value: string,
  project: string,
  location: string,
) => expandParent(value, project, location, "storagePools");

export const listVolumes = (project: string) =>
  listAtLocation(project, (parent) =>
    collectPages(
      netapp.listProjectsLocationsVolumes.pages({ parent, pageSize: 1000 }),
      (page) => page.volumes,
    ).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed([] as netapp.Volume[])),
    ),
  );

export const listVolumeChildren = <A, E, R>(
  project: string,
  region: string,
  list: (volumeName: string) => Effect.Effect<A[], E, R>,
) =>
  listVolumes(project).pipe(
    Effect.flatMap((volumes) =>
      Effect.forEach(
        volumes.filter((volume) => (volume.name ?? "").length > 0),
        (volume) => list(volume.name!),
        { concurrency: 4 },
      ).pipe(Effect.map((groups) => groups.flat())),
    ),
  );

/** Children of every parent in every location (`locations/-/{nested}`). */
export const listAtNested = <A, E, R>(
  project: string,
  nested: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
) => list(`projects/${project}/locations/-/${nested}`);

export const listLabeledPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
  labelsOf: (item: A) => Record<string, string | undefined> | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.filter((item) => hasAlchemyLabelMap(labelsOf(item))),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

/** Readiness / gone polls: 360 × 5s = 30 minutes. */
const OPERATION_POLLS = 360;

/** Storage pool, volume and replication operations take up to ~20 minutes. */
const OPERATION_BUDGET = "30 minutes";

/**
 * Wait for a long-running operation. ALREADY_EXISTS (code 6) means a
 * concurrent create won the race; reconcile observes the resource next.
 */
export const waitForOperation = (operation: LongRunningOperation) =>
  waitForLongRunning(
    operation,
    (name) => netapp.getProjectsLocationsOperations({ name }),
    {
      budget: OPERATION_BUDGET,
    },
  ).pipe(
    Effect.catchIf(
      (error) => error._tag === "GCP.OperationFailed" && error.code === 6,
      () => Effect.succeed(operation),
    ),
  );

/**
 * Wait for a delete operation. A vanished operation or NOT_FOUND (code 5)
 * means the resource is already gone.
 */
export const waitForDeleteOperation = (operation: LongRunningOperation) =>
  waitForOperation(operation).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "NotFound" ||
        (error._tag === "GCP.OperationFailed" && error.code === 5),
      () => Effect.succeed(operation),
    ),
  );
