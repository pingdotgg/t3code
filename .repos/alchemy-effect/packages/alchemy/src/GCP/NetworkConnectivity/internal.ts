import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";
import { waitForOperation as waitForLongRunning } from "../Operation.ts";

export const DEFAULT_GLOBAL = "global";
export const MAX_NAME_LENGTH = 63;

export class NetworkConnectivityNotResolved extends Data.TaggedError(
  "GCP.NetworkConnectivity.NotResolved",
)<{
  name: string;
}> {}

export class NetworkConnectivityStillExists extends Data.TaggedError(
  "GCP.NetworkConnectivity.StillExists",
)<{
  name: string;
}> {}

export class NetworkConnectivityFailed extends Data.TaggedError(
  "GCP.NetworkConnectivity.Failed",
)<{
  name: string;
  state: string | undefined;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (
  name: string,
  fallback = "resource",
  maxLength = MAX_NAME_LENGTH,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `n${next}`;
  }
  next = next.slice(0, maxLength).replace(/-+$/, "");
  return next.length > 0 ? next : fallback;
};

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const parentOfName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const at = parts.lastIndexOf(collection);
  if (at <= 0) return name;
  return parts.slice(0, at).join("/");
};

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
        ? parts[collectionAt + 1]!
        : lastSegment(name),
  };
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "resource",
  maxLength = MAX_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      fallback,
      maxLength,
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelKeys = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].map(canonicalizeLink).sort()) ===
  JSON.stringify([...(right ?? [])].map(canonicalizeLink).sort());

export const canonicalizeLink = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  return value
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^compute\/v1\//, "")
    .replace(/\/+$/, "");
};

export const toNetworkResource = (project: string, network: string) => {
  const trimmed = canonicalizeLink(network);
  if (trimmed.includes("/")) return trimmed;
  return `projects/${project}/global/networks/${trimmed}`;
};

export const toSubnetworkResource = (
  project: string,
  region: string,
  subnetwork: string,
) => {
  const trimmed = canonicalizeLink(subnetwork);
  if (trimmed.includes("/")) return trimmed;
  return `projects/${project}/regions/${region}/subnetworks/${trimmed}`;
};

export const changedFields = (
  pairs: ReadonlyArray<readonly [string, boolean]>,
) => pairs.filter(([, changed]) => changed).map(([field]) => field);

/**
 * Wait for a Network Connectivity Center long-running operation. Transports,
 * gateway spokes and internal ranges can take tens of minutes.
 * `ALREADY_EXISTS` (a concurrent create won) always succeeds;
 * `notFoundOk` also accepts a `NOT_FOUND` result or an operation that has
 * already been garbage-collected (deletes).
 */
export const waitForOperation = (
  operation: networkconnectivity.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean },
) =>
  waitForLongRunning(
    operation,
    (name) => networkconnectivity.getProjectsLocationsOperations({ name }),
    { budget: "30 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
    Effect.catchIf(
      (error) => options?.notFoundOk === true && error._tag === "NotFound",
      () => Effect.void,
    ),
  );

export const waitUntilPresent = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<A, E | NetworkConnectivityNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new NetworkConnectivityNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof NetworkConnectivityNotResolved,
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | NetworkConnectivityStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new NetworkConnectivityStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof NetworkConnectivityStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

const PENDING_STATES = new Set([
  "STATE_UNSPECIFIED",
  "CREATING",
  "UPDATING",
  "DELETING",
  "ACCEPTING",
  "REJECTING",
]);

const FAILED_STATES = new Set([
  "FAILED",
  "DELETE_FAILED",
  "OBSOLETE",
  "FAILED_DEPROGRAMMING",
]);

export const waitUntilReady = <A extends { state?: string }, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<
  A,
  E | NetworkConnectivityNotResolved | NetworkConnectivityFailed,
  R
> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new NetworkConnectivityNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !FAILED_STATES.has(value.state ?? ""),
      (value) => new NetworkConnectivityFailed({ name, state: value.state }),
    ),
    Effect.filterOrFail(
      (value) => !PENDING_STATES.has(value.state ?? ""),
      () => new NetworkConnectivityNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof NetworkConnectivityNotResolved,
      times: 10,
      schedule: Schedule.spaced("4 seconds"),
    }),
  );

/** Collect every page; a missing parent (`NotFound`) lists as empty. */
export const collectPages = <
  Page,
  Item,
  E extends { readonly _tag: string },
  R,
>(
  stream: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly Item[] | undefined,
) =>
  stream.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk): Item[] => Array.from(chunk)),
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.succeed<Item[]>([]),
    ),
  );
