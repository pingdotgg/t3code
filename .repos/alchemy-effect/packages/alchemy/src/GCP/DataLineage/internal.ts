import * as datalineage from "@distilled.cloud/gcp/datalineage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export const MAX_ID_LENGTH = 200;
export const MAX_DISPLAY_NAME_LENGTH = 200;

export class DatalineageNotResolved extends Data.TaggedError(
  "GCP.DataLineage.ResourceNotResolved",
)<{
  name: string;
}> {}

export class DatalineageStillExists extends Data.TaggedError(
  "GCP.DataLineage.ResourceStillExists",
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
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${lastSegment(location).toLowerCase()}`;

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, Math.max(0, parts.length - 2)).join("/");
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
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parentOf(name),
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

export const processOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "processes");

export const runOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "runs");

export const sanitizeId = (name: string, fallback = "lineage"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_\-.]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/^[a-z0-9]/.test(next)) next = `p${next}`;
  next = next.slice(0, MAX_ID_LENGTH).replace(/[-.]+$/g, "");
  return next.length > 0 ? next : fallback;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "lineage",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return sanitizeId(explicit, fallback);
    if (existing !== undefined) return existing;
    return sanitizeId(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
      fallback,
    );
  });

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
    return { action: "replace" as const, deleteFirst: true };
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

export const attributeTags = (
  attributes: datalineage.DocumentMap | null | undefined,
): Record<string, string> => {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined) continue;
    tags[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return tags;
};

export const userAttributes = (
  attributes: datalineage.DocumentMap | null | undefined,
): Record<string, unknown> => {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    stripInternalLabels(attributeTags(attributes)),
  )) {
    const raw = attributes?.[key];
    next[key] = raw !== undefined ? raw : value;
  }
  return next;
};

export const desiredAttributes = (
  attributes: Record<string, unknown> | undefined,
  ownership: Record<string, string>,
): datalineage.DocumentMap => ({
  ...(attributes ?? {}),
  ...ownership,
});

export const hasAlchemyAttributeMap = (
  attributes: datalineage.DocumentMap | null | undefined,
) => Object.keys(attributes ?? {}).some((key) => key.startsWith("alchemy-"));

export const ownedByAlchemy = (
  id: string,
  attributes: datalineage.DocumentMap | null | undefined,
) => hasAlchemyLabels(id, attributeTags(attributes));

export const collectPages = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
  );

const emptyList = <A>() => Effect.succeed<A[]>([]);

const emptyOnMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A[], E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => emptyList<A>(),
    ),
  );

export const listProcesses = (parent: string) =>
  parent.length === 0
    ? emptyList<datalineage.GoogleCloudDatacatalogLineageV1Process>()
    : emptyOnMissing(
        collectPages(
          datalineage.listProjectsLocationsProcesses.pages({
            parent,
            pageSize: 100,
          }),
          (page) => page.processes,
        ),
      );

export const listRuns = (parent: string) =>
  parent.length === 0
    ? emptyList<datalineage.GoogleCloudDatacatalogLineageV1Run>()
    : emptyOnMissing(
        collectPages(
          datalineage.listProjectsLocationsProcessesRuns.pages({
            parent,
            pageSize: 100,
          }),
          (page) => page.runs,
        ),
      );

export const listLineageEvents = (parent: string) =>
  parent.length === 0
    ? emptyList<datalineage.GoogleCloudDatacatalogLineageV1LineageEvent>()
    : emptyOnMissing(
        collectPages(
          datalineage.listProjectsLocationsProcessesRunsLineageEvents.pages({
            parent,
            pageSize: 100,
          }),
          (page) => page.lineageEvents,
        ),
      );

export const listOwnedProcesses = (project: string, location: string) =>
  listProcesses(locationParent(project, location)).pipe(
    Effect.map((rows) =>
      rows.filter((row) => hasAlchemyAttributeMap(row.attributes)),
    ),
  );

export const findOwnedProcess = (
  id: string,
  project: string,
  location: string,
) =>
  Effect.gen(function* () {
    const rows = yield* listProcesses(locationParent(project, location));
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.attributes)) return row;
    }
    return undefined;
  });

export const findOwnedRun = (id: string, process: string) =>
  Effect.gen(function* () {
    const rows = yield* listRuns(process);
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.attributes)) return row;
    }
    return undefined;
  });

/** Wait for an operation through the shared GCP waiter. */
export const waitForOperation = (
  operation: datalineage.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      datalineage.getProjectsLocationsOperations({ name }).pipe(
        Effect.catchTag("NotFound", (error) =>
          options?.notFoundOk === true
            ? Effect.succeed<datalineage.GoogleLongrunningOperation>({
                name,
                done: true,
              })
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
        ((options?.alreadyExistsOk !== false && error.code === 6) ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
    // Re-read the finished operation for its typed response and metadata.
    Effect.flatMap(() =>
      operation.name === undefined || operation.name.length === 0
        ? Effect.succeed(operation)
        : datalineage
            .getProjectsLocationsOperations({ name: operation.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(operation))),
    ),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | DatalineageStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new DatalineageStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof DatalineageStillExists,
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.asVoid,
  );

export const createOwnership = (id: string) => createInternalLabels(id);
