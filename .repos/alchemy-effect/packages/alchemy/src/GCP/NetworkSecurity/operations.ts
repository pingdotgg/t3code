import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { stripInternalLabels } from "../Labels.ts";
import { waitForOperation as waitForLongRunning } from "../Operation.ts";

export const DEFAULT_LOCATION = "global";
export const DEFAULT_ZONE = "us-central1-a";
export const MAX_NAME_LENGTH = 63;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.ResourceStillExists",
)<{
  name: string;
}> {}

export class OrganizationRequired extends Data.TaggedError(
  "GCP.NetworkSecurity.OrganizationRequired",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "resource"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `${fallback[0] ?? "n"}${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : fallback;
};

export const normalizeLocation = (
  location: string | undefined,
  fallback = DEFAULT_LOCATION,
) => lastSegment(location ?? fallback).toLowerCase();

export const normalizeZone = (
  location: string | undefined,
  fallback = DEFAULT_ZONE,
) => lastSegment(location ?? fallback).toLowerCase();

export const projectParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const organizationParent = (organization: string, location: string) =>
  `organizations/${lastSegment(organization)}/locations/${location}`;

export const parseResourceName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const organizationsAt = parts.lastIndexOf("organizations");
  const parentAt = organizationsAt >= 0 ? organizationsAt : projectsAt;
  return {
    parentId: parentAt >= 0 && parts[parentAt + 1] ? parts[parentAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    id: lastSegment(name),
  };
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "resource",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
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

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sortedStrings = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])].map((value) => value).sort();

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));

/**
 * Wait for a Network Security long-running operation. Cloud NGFW firewall
 * endpoints take ~20 minutes to provision; intercept and mirroring
 * deployments take several minutes.
 * `ALREADY_EXISTS` (a concurrent create won) always succeeds;
 * `notFoundOk` also accepts a `NOT_FOUND` result or an operation that has
 * already been garbage-collected (deletes).
 */
export const waitForOperation = (
  operation: networksecurity.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForLongRunning(
    operation,
    (name) => networksecurity.getProjectsLocationsOperations({ name }),
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

export const waitUntilExists = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(new ResourceNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceNotResolved,
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
        : Effect.fail(new ResourceStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const parentOf = (name: string) =>
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
      current = yield* parentOf(current);
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
