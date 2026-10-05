import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";
import {
  OperationFailed,
  waitForOperation as waitForLongRunning,
  type LongRunningOperation,
} from "../Operation.ts";

export const DEFAULT_SCHEMA_ID = "main";
export const MAX_NAME_LENGTH = 63;
// Full connector names are capped at 200 chars; a 63-char service id leaves
// room for a 48-char connector id.
export const MAX_CONNECTOR_ID_LENGTH = 48;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.FirebaseDataConnect.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.FirebaseDataConnect.ResourceStillExists",
)<{
  name: string;
}> {}

export class ResourceReconciling extends Data.TaggedError(
  "GCP.FirebaseDataConnect.ResourceReconciling",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (
  name: string,
  fallback = "dataconnect",
  maxLength = MAX_NAME_LENGTH,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return fallback.slice(0, maxLength);
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${lastSegment(location).toLowerCase()}`;

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "dataconnect",
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

export const parseName = (
  name: string,
  collection: string,
  defaultLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const servicesAt = parts.lastIndexOf("services");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    serviceId:
      servicesAt >= 0 && parts[servicesAt + 1] ? parts[servicesAt + 1]! : "",
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

export const expandParent = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `projects/${project}/locations/${location}/${collection}/${value}`;
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const stringMap = (
  value: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

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

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

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

export const waitUntilReady = <A extends { reconciling?: boolean }, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<
  NonNullable<A>,
  E | ResourceNotResolved | ResourceReconciling,
  R
> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => value.reconciling !== true,
      () => new ResourceReconciling({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error instanceof ResourceNotResolved ||
        error instanceof ResourceReconciling,
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceStillExists,
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.asVoid,
  );

/** Every location at once: the API accepts the `locations/-` wildcard. */
export const listAtLocation = <A, E, R>(
  project: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
) => list(`projects/${project}/locations/-`);

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

/** Services that provision Cloud SQL take up to ~20 minutes. */
const OPERATION_BUDGET = "30 minutes";

/**
 * Wait for a long-running operation. ALREADY_EXISTS (code 6) means a
 * concurrent create won the race; reconcile observes the resource next.
 */
export const waitForOperation = (operation: LongRunningOperation) =>
  waitForLongRunning(
    operation,
    (name) => firebasedataconnect.getProjectsLocationsOperations({ name }),
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

/**
 * Re-run a patch-and-wait whose operation failed with a stale etag
 * (ABORTED, code 10). Sibling updates (the parent service, another schema
 * or connector) bump the server etag while the patch is in flight.
 */
export const retryStaleEtag = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error instanceof OperationFailed && error.code === 10,
      times: 5,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );
