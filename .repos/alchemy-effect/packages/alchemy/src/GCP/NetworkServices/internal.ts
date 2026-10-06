import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { alchemyLabelKeys, stripInternalLabels } from "../Labels.ts";
import { waitForOperation as waitForLongRunning } from "../Operation.ts";

export const DEFAULT_GLOBAL = "global";
// Multicast resources are zonal; a zone cannot be derived from the stack
// region (not every region has an `-a` zone), so this default stays fixed.
export const DEFAULT_ZONE = "us-central1-a";
export const MAX_NAME_LENGTH = 63;
export const MAX_MULTICAST_NAME_LENGTH = 48;

export class NetworkservicesNotResolved extends Data.TaggedError(
  "GCP.NetworkServices.NotResolved",
)<{
  name: string;
}> {}

export class NetworkservicesStillExists extends Data.TaggedError(
  "GCP.NetworkServices.StillExists",
)<{
  name: string;
}> {}

export class NetworkservicesFailed extends Data.TaggedError(
  "GCP.NetworkServices.Failed",
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

export const resourceName = (
  project: string,
  location: string,
  collection: string,
  id: string,
) => `projects/${project}/locations/${location}/${collection}/${id}`;

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
    if (explicit !== undefined) return rfc1035(explicit, fallback, maxLength);
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

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^\s+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const canonicalizeLink = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  return value
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^compute\/v1\//, "")
    .replace(/\/+$/, "");
};

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].map(canonicalizeLink).sort()) ===
  JSON.stringify([...(right ?? [])].map(canonicalizeLink).sort());

export const sameNumberList = (
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
) => JSON.stringify([...(left ?? [])]) === JSON.stringify([...(right ?? [])]);

export const linkKey = (value: string | undefined) =>
  lastSegment(canonicalizeLink(value)).toLowerCase();

export const toMulticastNetwork = (project: string, network: string) => {
  const trimmed = canonicalizeLink(network);
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  const projectsAt = parts.lastIndexOf("projects");
  const proj =
    projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : project;
  const id = lastSegment(trimmed);
  return `projects/${proj}/locations/global/networks/${id || trimmed}`;
};

export const toBackendServiceResource = (project: string, service: string) => {
  const trimmed = canonicalizeLink(service);
  if (
    trimmed.includes("/backendServices/") ||
    trimmed.includes("/backendservices/")
  ) {
    if (trimmed.includes("/locations/")) return trimmed;
    const parts = trimmed.split("/").filter((part) => part.length > 0);
    const projectsAt = parts.lastIndexOf("projects");
    const proj =
      projectsAt >= 0 && parts[projectsAt + 1]
        ? parts[projectsAt + 1]!
        : project;
    return `projects/${proj}/locations/global/backendServices/${lastSegment(trimmed)}`;
  }
  return `projects/${project}/locations/global/backendServices/${lastSegment(trimmed)}`;
};

export const toNamedResource = (
  project: string,
  location: string,
  collection: string,
  value: string,
) => {
  const trimmed = canonicalizeLink(value);
  if (trimmed.includes(`/${collection}/`)) return trimmed;
  return resourceName(project, location, collection, lastSegment(trimmed));
};

export const changedFields = (
  pairs: ReadonlyArray<readonly [string, boolean]>,
) => pairs.filter(([, changed]) => changed).map(([field]) => field);

/**
 * Wait for a Network Services long-running operation. Agent gateways and
 * multicast resources take several minutes.
 * `ALREADY_EXISTS` (a concurrent create won) always succeeds;
 * `notFoundOk` also accepts a `NOT_FOUND` result or an operation that has
 * already been garbage-collected (deletes).
 */
export const waitForOperation = (
  operation: networkservices.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForLongRunning(
    operation,
    (name) => networkservices.getProjectsLocationsOperations({ name }),
    { budget: "20 minutes" },
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
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(new NetworkservicesNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error instanceof NetworkservicesNotResolved,
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : Effect.fail(new NetworkservicesStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error instanceof NetworkservicesStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const PENDING_STATES = new Set([
  "STATE_UNSPECIFIED",
  "STATE_ENUM_UNSPECIFIED",
  "CREATING",
  "UPDATING",
  "DELETING",
]);

const FAILED_STATES = new Set([
  "FAILED",
  "DELETE_FAILED",
  "UPDATE_FAILED",
  "OBSOLETE",
]);

export const waitUntilReady = <A extends { state?: string }, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new NetworkservicesNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !FAILED_STATES.has(value.state ?? ""),
      (value) => new NetworkservicesFailed({ name, state: value.state }),
    ),
    Effect.filterOrFail(
      (value) => !PENDING_STATES.has(value.state ?? ""),
      () => new NetworkservicesNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof NetworkservicesNotResolved,
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
