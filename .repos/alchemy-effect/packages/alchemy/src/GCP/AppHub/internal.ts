import * as apphub from "@distilled.cloud/gcp/apphub_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export type Attributes = apphub.Attributes;
export type Scope = apphub.Scope;
export type ContactInfo = apphub.ContactInfo;
export type ServiceReference = apphub.ServiceReference;
export type ServiceProperties = apphub.ServiceProperties;
export type WorkloadReference = apphub.WorkloadReference;
export type WorkloadProperties = apphub.WorkloadProperties;

export const GLOBAL_LOCATION = "global";
export const MAX_NAME_LENGTH = 63;
export const MAX_DISPLAY_NAME_LENGTH = 63;
export const MAX_DESCRIPTION_LENGTH = 2048;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.AppHub.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.AppHub.ResourceStillExists",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.AppHub.ResourceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ResourceFailed extends Data.TaggedError(
  "GCP.AppHub.ResourceFailed",
)<{
  name: string;
  state: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "apphub"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${lastSegment(location).toLowerCase()}`;

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "apphub",
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
  defaultLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const applicationsAt = parts.lastIndexOf("applications");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    applicationId:
      applicationsAt >= 0 && parts[applicationsAt + 1]
        ? parts[applicationsAt + 1]!
        : "",
    application:
      applicationsAt >= 0
        ? parts.slice(0, applicationsAt + 2).join("/")
        : parts.slice(0, Math.max(0, parts.length - 2)).join("/"),
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

export const expandApplication = (
  value: string,
  project: string,
  location: string,
) =>
  value.includes("/applications/")
    ? value.replace(/\/+$/, "")
    : `${locationParent(project, location)}/applications/${value}`;

export const expandDiscovered = (
  value: string,
  project: string,
  location: string,
  collection: "discoveredServices" | "discoveredWorkloads",
) => {
  if (value.includes(`/${collection}/`)) return value.replace(/\/+$/, "");
  if (
    value.includes("/") ||
    value.startsWith("https://") ||
    value.includes(".googleapis.com")
  ) {
    return value.replace(/\/+$/, "");
  }
  return `projects/${project}/locations/${location}/${collection}/${value}`;
};

export const isDiscoveredName = (
  value: string,
  collection: "discoveredServices" | "discoveredWorkloads",
) => value.includes(`/${collection}/`);

export const projectNameOf = (value: string | undefined, project: string) => {
  const next = (value ?? project).replace(/\/+$/, "");
  if (next.startsWith("projects/")) return next;
  return `projects/${next}`;
};

export const projectIdOf = (value: string | undefined, fallback: string) => {
  if (value === undefined || value.length === 0) return fallback;
  const parts = value.split("/").filter((part) => part.length > 0);
  const at = parts.lastIndexOf("projects");
  if (at >= 0 && parts[at + 1]) return parts[at + 1]!;
  return lastSegment(value);
};

export const defaultScope = (location: string): Scope => ({
  type: location === GLOBAL_LOCATION ? "GLOBAL" : "REGIONAL",
});

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

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

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

const markerOf = (
  labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.length <= maxLength ? marker : marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string => {
  const marker = fitMarker(labels, maxLength);
  const trimmed = text?.trim();
  if (!trimmed) return marker;
  const combined = `${marker}\n${trimmed}`;
  return combined.length <= maxLength ? combined : combined.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.includes("[alchemy ")) {
    return { labels: {}, text };
  }
  const start = text.indexOf("[alchemy ");
  const end = text.indexOf("]", start);
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice(start + "[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const before = text.slice(0, start).trim();
  const after = text.slice(end + 1).replace(/^[\s\n]+/, "");
  const rest = [before, after].filter((part) => part.length > 0).join("\n");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

/** Wait for an operation through the shared GCP waiter. */
export const waitForOperation = (
  operation: apphub.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      apphub
        .getProjectsLocationsOperations({ name })
        .pipe(
          Effect.catchTag("NotFound", (error) =>
            options?.notFoundOk === true
              ? Effect.succeed<apphub.Operation>({ name, done: true })
              : Effect.fail(error),
          ),
        ),
    { budget: "10 minutes" },
  ).pipe(
    // ALREADY_EXISTS (6): a concurrent create won the race. NOT_FOUND (5)
    // is success for a delete.
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
  );

export const waitUntilExists = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<NonNullable<A>, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value !== undefined,
      () => new ResourceNotResolved({ name }),
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
): Effect.Effect<void, E | ResourceStillExists, R> =>
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

const READY_STATES = new Set(["ACTIVE"]);
const FAILED_STATES = new Set(["FAILED", "ERROR"]);

export const waitUntilReady = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
  stateOf: (value: NonNullable<A>) => string | undefined,
  options?: {
    times?: number;
    interval?: `${number} seconds`;
  },
): Effect.Effect<
  NonNullable<A>,
  E | ResourceNotResolved | ResourceNotReady | ResourceFailed,
  R
> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !FAILED_STATES.has((stateOf(value) ?? "").toUpperCase()),
      (value) => new ResourceFailed({ name, state: stateOf(value) ?? "" }),
    ),
    Effect.filterOrFail(
      (value) => READY_STATES.has((stateOf(value) ?? "").toUpperCase()),
      (value) => new ResourceNotReady({ name, state: stateOf(value) ?? "" }),
    ),
    Effect.retry({
      while: (error) =>
        error instanceof ResourceNotReady ||
        error instanceof ResourceNotResolved,
      times: options?.times ?? 10,
      schedule: Schedule.spaced(options?.interval ?? "2 seconds"),
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

export const listOwnedPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
  textOf: (item: A) => string | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.filter((item) => hasOwnershipMarker(textOf(item))),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

/** List at the regional and global locations (App Hub's two scopes). */
export const listAtLocations = <A, E, R>(
  project: string,
  region: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
): Effect.Effect<A[], E, R> =>
  Effect.all(
    [
      list(`projects/${project}/locations/${region}`),
      list(`projects/${project}/locations/${GLOBAL_LOCATION}`),
    ],
    { concurrency: 2 },
  ).pipe(Effect.map(([regional, global]) => [...regional, ...global]));

export const listAllApplications = (project: string, region: string) =>
  listAtLocations(project, region, (parent) =>
    collectPages(
      apphub.listProjectsLocationsApplications.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.applications,
    ),
  );

export const listNestedOwned = <A, E, R>(
  project: string,
  region: string,
  listChildren: (applicationName: string) => Effect.Effect<A[], E, R>,
) =>
  Effect.gen(function* () {
    const apps = yield* listAllApplications(project, region);
    const groups = yield* Effect.forEach(
      apps,
      (app) => {
        const name = app.name ?? "";
        if (name.length === 0) return Effect.succeed([] as A[]);
        return listChildren(name);
      },
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const resolveDiscoveredService = (
  parent: string,
  value: string,
  project: string,
  location: string,
) =>
  Effect.gen(function* () {
    const expanded = expandDiscovered(
      value,
      project,
      location,
      "discoveredServices",
    );
    if (isDiscoveredName(expanded, "discoveredServices")) return expanded;
    const looked = yield* apphub
      .lookupProjectsLocationsDiscoveredServices({
        parent,
        uri: expanded,
      })
      .pipe(
        Effect.catchTag("NotFound", () =>
          Effect.succeed<apphub.LookupDiscoveredServiceResponse>({}),
        ),
      );
    return looked.discoveredService?.name ?? expanded;
  });

export const resolveDiscoveredWorkload = (
  parent: string,
  value: string,
  project: string,
  location: string,
) =>
  Effect.gen(function* () {
    const expanded = expandDiscovered(
      value,
      project,
      location,
      "discoveredWorkloads",
    );
    if (isDiscoveredName(expanded, "discoveredWorkloads")) return expanded;
    const looked = yield* apphub
      .lookupProjectsLocationsDiscoveredWorkloads({
        parent,
        uri: expanded,
      })
      .pipe(
        Effect.catchTag("NotFound", () =>
          Effect.succeed<apphub.LookupDiscoveredWorkloadResponse>({}),
        ),
      );
    return looked.discoveredWorkload?.name ?? expanded;
  });
