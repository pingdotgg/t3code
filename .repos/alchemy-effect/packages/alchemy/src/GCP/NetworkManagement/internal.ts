import * as networkmanagement from "@distilled.cloud/gcp/networkmanagement_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { stripInternalLabels } from "../Labels.ts";
import { waitForOperation as waitForLongRunning } from "../Operation.ts";

export const DEFAULT_GLOBAL = "global";
export const MAX_NAME_LENGTH = 63;
export const MAX_CONNECTIVITY_TEST_ID_LENGTH = 40;

export class NetworkmanagementNotResolved extends Data.TaggedError(
  "GCP.NetworkManagement.NotResolved",
)<{
  name: string;
}> {}

export class NetworkmanagementStillExists extends Data.TaggedError(
  "GCP.NetworkManagement.StillExists",
)<{
  name: string;
}> {}

export class NetworkmanagementFailed extends Data.TaggedError(
  "GCP.NetworkManagement.Failed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class OrganizationRequired extends Data.TaggedError(
  "GCP.NetworkManagement.OrganizationRequired",
)<{
  project: string;
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
    next = `${fallback[0] ?? "n"}${next}`;
  }
  next = next.slice(0, maxLength).replace(/-+$/, "");
  if (next.length > 0 && !/[a-z0-9]$/.test(next)) {
    next = next.slice(0, -1);
  }
  return next.length > 0 ? next : fallback;
};

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const organizationParent = (organization: string, location: string) =>
  `organizations/${lastSegment(organization)}/locations/${location}`;

export const organizationIdOf = (value: string) => lastSegment(value);

export const resourceName = (
  project: string,
  location: string,
  collection: string,
  id: string,
) => `projects/${project}/locations/${location}/${collection}/${id}`;

export const organizationResourceName = (
  organization: string,
  location: string,
  collection: string,
  id: string,
) =>
  `organizations/${lastSegment(organization)}/locations/${location}/${collection}/${id}`;

export const parseName = (
  name: string,
  collection: string,
  fallbackLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const organizationsAt = parts.lastIndexOf("organizations");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    organization:
      organizationsAt >= 0 && parts[organizationsAt + 1]
        ? parts[organizationsAt + 1]!
        : "",
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

export const changedFields = (
  pairs: ReadonlyArray<readonly [string, boolean]>,
) => pairs.filter(([, changed]) => changed).map(([field]) => field);

export const toNetworkResource = (project: string, network: string) => {
  const trimmed = canonicalizeLink(network);
  const id = lastSegment(trimmed);
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  const projectsAt = parts.lastIndexOf("projects");
  const proj =
    projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : project;
  return `projects/${proj}/global/networks/${id || trimmed}`;
};

export const toSubnetworkResource = (
  project: string,
  region: string,
  subnetwork: string,
) => {
  const trimmed = canonicalizeLink(subnetwork);
  if (trimmed.includes("/subnetworks/") || trimmed.includes("/subNetworks/")) {
    const parts = trimmed.split("/").filter((part) => part.length > 0);
    const projectsAt = parts.lastIndexOf("projects");
    const regionsAt = parts.lastIndexOf("regions");
    const proj =
      projectsAt >= 0 && parts[projectsAt + 1]
        ? parts[projectsAt + 1]!
        : project;
    const loc =
      regionsAt >= 0 && parts[regionsAt + 1] ? parts[regionsAt + 1]! : region;
    return `projects/${proj}/regions/${loc}/subnetworks/${lastSegment(trimmed)}`;
  }
  return `projects/${project}/regions/${region}/subnetworks/${lastSegment(trimmed)}`;
};

export const toRegionalComputeResource = (
  project: string,
  region: string,
  collection: string,
  value: string,
) => {
  const trimmed = canonicalizeLink(value);
  if (trimmed.includes(`/${collection}/`)) {
    const parts = trimmed.split("/").filter((part) => part.length > 0);
    const projectsAt = parts.lastIndexOf("projects");
    const regionsAt = parts.lastIndexOf("regions");
    const proj =
      projectsAt >= 0 && parts[projectsAt + 1]
        ? parts[projectsAt + 1]!
        : project;
    const loc =
      regionsAt >= 0 && parts[regionsAt + 1] ? parts[regionsAt + 1]! : region;
    return `projects/${proj}/regions/${loc}/${collection}/${lastSegment(trimmed)}`;
  }
  return `projects/${project}/regions/${region}/${collection}/${lastSegment(trimmed)}`;
};

const getOperation = (name: string) =>
  name.startsWith("organizations/")
    ? networkmanagement.getOrganizationsLocationsGlobalOperations({ name })
    : networkmanagement.getProjectsLocationsGlobalOperations({ name });

/**
 * Wait for a Network Management long-running operation. Connectivity tests
 * and flow-log configs settle within minutes.
 * `ALREADY_EXISTS` (a concurrent create won) always succeeds;
 * `notFoundOk` also accepts a `NOT_FOUND` result or an operation that has
 * already been garbage-collected (deletes).
 */
export const waitForOperation = (
  operation: networkmanagement.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForLongRunning(
    operation,
    getOperation,
    { budget: "10 minutes" },
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
        : Effect.fail(new NetworkmanagementNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error instanceof NetworkmanagementNotResolved,
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
        : Effect.fail(new NetworkmanagementStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error instanceof NetworkmanagementStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const PENDING_STATES = new Set([
  "STATE_UNSPECIFIED",
  "ACTIVATING",
  "SUSPENDING",
  "DELETING",
]);

const FAILED_STATES = new Set(["DELETED"]);

export const waitUntilReady = <A extends { state?: string }, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new NetworkmanagementNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !FAILED_STATES.has(value.state ?? ""),
      (value) => new NetworkmanagementFailed({ name, state: value.state }),
    ),
    Effect.filterOrFail(
      (value) => !PENDING_STATES.has(value.state ?? ""),
      () => new NetworkmanagementNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof NetworkmanagementNotResolved,
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

const parentOfResource = (name: string) =>
  name.startsWith("projects/")
    ? resourcemanager.getProjects({ name }).pipe(
        Effect.map((resource) => resource.parent),
        Effect.catchTag("NotFound", () =>
          Effect.succeed(undefined),
        ),
      )
    : name.startsWith("folders/")
      ? resourcemanager.getFolders({ name }).pipe(
          Effect.map((folder) => folder.parent),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined),
          ),
        )
      : Effect.succeed(undefined);

const tryResolveOrganizationId = (project: string) =>
  Effect.gen(function* () {
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("organizations/")) return lastSegment(current);
      current = yield* parentOfResource(current);
    }
    return undefined;
  });

export const resolveOrganization = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return lastSegment(explicit);
    if (existing !== undefined) return lastSegment(existing);
    const env = yield* GcpEnvironment.current;
    const resolved = yield* tryResolveOrganizationId(env.project);
    if (resolved === undefined) {
      return yield* new OrganizationRequired({ project: env.project });
    }
    return resolved;
  });

export const listOrganizations = (project: string) =>
  Effect.gen(function* () {
    const resolved = yield* tryResolveOrganizationId(project);
    return resolved === undefined ? [] : [resolved];
  });
