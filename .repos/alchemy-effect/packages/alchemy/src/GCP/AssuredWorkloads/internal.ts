import * as assuredworkloads from "@distilled.cloud/gcp/assuredworkloads_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { stripInternalLabels } from "../Labels.ts";

export const MAX_DISPLAY_NAME_LENGTH = 30;
export const MIN_DISPLAY_NAME_LENGTH = 4;

export type ApiWorkload =
  assuredworkloads.GoogleCloudAssuredworkloadsV1Workload;
export type ApiOperation = assuredworkloads.GoogleLongrunningOperation;

export class AssuredworkloadsNotResolved extends Data.TaggedError(
  "GCP.AssuredWorkloads.NotResolved",
)<{
  name: string;
}> {}

export class AssuredworkloadsStillExists extends Data.TaggedError(
  "GCP.AssuredWorkloads.StillExists",
)<{
  name: string;
}> {}

export class OrganizationNotResolved extends Data.TaggedError(
  "GCP.AssuredWorkloads.OrganizationNotResolved",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

export const organizationIdOf = (value: string) => lastSegment(value);

export const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

export const locationParent = (organization: string, location: string) =>
  `${organizationParent(organization)}/locations/${normalizeLocation(location)}`;

export const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const workloadsAt = parts.lastIndexOf("workloads");
  const locationsAt = parts.lastIndexOf("locations");
  const orgsAt = parts.lastIndexOf("organizations");
  return {
    organization: orgsAt >= 0 && parts[orgsAt + 1] ? parts[orgsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    id:
      workloadsAt >= 0 && parts[workloadsAt + 1]
        ? parts[workloadsAt + 1]!
        : lastSegment(name),
    parent:
      workloadsAt > 0
        ? parts.slice(0, workloadsAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const sanitizeDisplayName = (name: string): string => {
  let next = name
    .replace(/[^A-Za-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (next.length === 0) next = "Work";
  if (next.length > MAX_DISPLAY_NAME_LENGTH) {
    next = next.slice(0, MAX_DISPLAY_NAME_LENGTH).trim();
  }
  if (next.length < MIN_DISPLAY_NAME_LENGTH) {
    next = `${next} Load`.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }
  return next;
};

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    return sanitizeDisplayName(
      yield* createPhysicalName({
        id,
        maxLength: MAX_DISPLAY_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBool = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? true) === (right ?? true);

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

export const replaceOnIdentity = (changed: boolean) =>
  changed
    ? ({ action: "replace" as const, deleteFirst: false } as const)
    : undefined;

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listWorkloads = (organization: string, location: string) =>
  collectPages(
    assuredworkloads.listOrganizationsLocationsWorkloads.pages({
      parent: locationParent(organization, location),
      pageSize: 100,
    }),
    (page) => page.workloads,
  ).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([] as ApiWorkload[])),
  );

export const listOwnedWorkloads = (organization: string, region: string) =>
  Effect.gen(function* () {
    const wildcard = yield* listWorkloads(organization, "-");
    const regional = yield* listWorkloads(organization, region);
    const byName = new Map<string, ApiWorkload>();
    for (const workload of [...wildcard, ...regional]) {
      if (workload.name) byName.set(workload.name, workload);
    }
    return Array.from(byName.values()).filter((workload) =>
      hasAlchemyLabelMap(workload.labels),
    );
  });

export const resourceNameFromOperation = (
  operation: ApiOperation,
): string | undefined => {
  const response = operation.response;
  if (
    response &&
    typeof response.name === "string" &&
    response.name.includes("/workloads/")
  ) {
    return response.name;
  }
  const metadata = operation.metadata;
  if (metadata && typeof metadata.target === "string") {
    return metadata.target;
  }
  if (
    metadata &&
    typeof metadata.name === "string" &&
    metadata.name.includes("/workloads/")
  ) {
    return metadata.name;
  }
  return undefined;
};

/** Workload creation settles within a few minutes. */
export const waitForOperation = (operation: ApiOperation) =>
  waitForGcpOperation(
    operation,
    (name) => assuredworkloads.getOrganizationsLocationsOperations({ name }),
    { budget: "10 minutes" },
  );

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value !== undefined,
      () => new AssuredworkloadsNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AssuredWorkloads.NotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new AssuredworkloadsStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AssuredWorkloads.StillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

const ancestryParent = (name: string) =>
  name.startsWith("projects/")
    ? resourcemanager.getProjects({ name }).pipe(
        Effect.map((resource) => resource.parent),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      )
    : name.startsWith("folders/")
      ? resourcemanager.getFolders({ name }).pipe(
          Effect.map((folder) => folder.parent),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        )
      : Effect.succeed(undefined);

export const tryResolveOrganization = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    let current: string | undefined = `projects/${env.project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("organizations/")) return current;
      current = yield* ancestryParent(current);
    }
    return undefined;
  });

export const resolveOrganization = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return organizationParent(explicit);
    if (existing !== undefined) return organizationParent(existing);
    const resolved = yield* tryResolveOrganization();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new OrganizationNotResolved({ project: env.project });
    }
    return resolved;
  });

export const deleteChildResources = (workload: ApiWorkload) =>
  Effect.gen(function* () {
    const resources = workload.resources ?? [];
    const projects = resources.filter(
      (resource) =>
        resource.resourceType === "CONSUMER_PROJECT" ||
        resource.resourceType === "ENCRYPTION_KEYS_PROJECT",
    );
    const folders = resources.filter(
      (resource) => resource.resourceType === "CONSUMER_FOLDER",
    );

    yield* Effect.forEach(
      projects,
      (resource) => {
        const id = resource.resourceId;
        if (id === undefined || id.length === 0) return Effect.void;
        return resourcemanager
          .deleteProjects({ name: `projects/${id}` })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      },
      { concurrency: 4 },
    );

    yield* Effect.forEach(
      folders,
      (resource) => {
        const id = resource.resourceId;
        if (id === undefined || id.length === 0) return Effect.void;
        return resourcemanager
          .deleteFolders({ name: `folders/${id}` })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      },
      { concurrency: 4 },
    );
  });
