import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export const DEFAULT_NETWORK = "default";
export const MAX_NAME_LENGTH = 63;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.OracleDatabase.ResourceNotResolved",
)<{
  name: string;
}> {}

export { ResourceNotResolved as OracleDatabaseNotResolved };

export class ResourceStillExists extends Data.TaggedError(
  "GCP.OracleDatabase.ResourceStillExists",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.OracleDatabase.ResourceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ResourceFailed extends Data.TaggedError(
  "GCP.OracleDatabase.ResourceFailed",
)<{
  name: string;
  state: string;
  details: string | undefined;
}> {}

export type CustomerContact = {
  /** Email Oracle uses for notifications. */
  email?: string;
};

export type TimeZone = {
  /** IANA time zone (e.g. `America/New_York`). */
  id?: string;
  /** IANA database version (e.g. `2019a`). */
  version?: string;
};

export const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "oracle"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `o${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const alphanumericId = (name: string, maxLength = 32): string => {
  let next = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[a-z]/.test(next)) next = `o${next}`;
  next = next.slice(0, maxLength);
  if (next.length === 0) return "oggdeploy";
  return next;
};

export const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${normalizeLocation(location)}`;

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "oracle",
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
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
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
  const value = network ?? DEFAULT_NETWORK;
  if (value.includes("/")) return value;
  return `projects/${project}/global/networks/${value}`;
};

export const expandNetwork = (project: string, network: string | undefined) => {
  if (network === undefined || network.length === 0) return undefined;
  if (network.includes("/")) return network;
  return `projects/${project}/global/networks/${network}`;
};

export const resourceNameOf = (
  project: string,
  location: string,
  collection: string,
  id: string,
) => `projects/${project}/locations/${location}/${collection}/${id}`;

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

export const retryConflict = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "Conflict" || error._tag === "TooManyRequests",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const canonical = (value: unknown): unknown => {
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

export const specifiedEquals = (
  desired: unknown,
  observed: unknown,
): boolean => {
  if (desired === undefined) return true;
  return (
    JSON.stringify(canonical(desired) ?? null) ===
    JSON.stringify(canonical(observed) ?? null)
  );
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

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

const READY_STATES = new Set([
  "AVAILABLE",
  "AVAILABLE_NEEDS_ATTENTION",
  "ACTIVE",
  "READY",
  "SUCCEEDED",
]);
const FAILED_STATES = new Set(["FAILED", "NEEDS_ATTENTION"]);

export const isReadyState = (state: string | undefined) =>
  READY_STATES.has((state ?? "").toUpperCase());

export const isFailedState = (state: string | undefined) =>
  FAILED_STATES.has((state ?? "").toUpperCase());

/** Wait for an operation through the shared GCP waiter. */
export const waitForOperation = (
  operation: oracle.Operation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      oracle
        .getProjectsLocationsOperations({ name })
        .pipe(
          Effect.catchTag("NotFound", (error) =>
            options?.notFoundOk === true
              ? Effect.succeed<oracle.Operation>({ name, done: true })
              : Effect.fail(error),
          ),
        ),
    { budget: "60 minutes" },
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
        : oracle
            .getProjectsLocationsOperations({ name: operation.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(operation))),
    ),
  );

export const waitUntilExists = <A, E extends { _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.OracleDatabase.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.OracleDatabase.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.asVoid,
  );

export const waitUntilReady = <A, E extends { _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
  stateOf: (value: A) => string | undefined,
  detailsOf?: (value: A) => string | undefined,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
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
      (value) =>
        new ResourceNotReady({
          name,
          state: stateOf(value) ?? "",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.OracleDatabase.ResourceNotReady" ||
        error._tag === "GCP.OracleDatabase.ResourceNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

export const listAtLocation = <A, E extends { _tag: string }, R>(
  project: string,
  region: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
) =>
  list(`projects/${project}/locations/-`).pipe(
    Effect.catchIf(
      (error) => error._tag === "NotFound" || error._tag === "BadRequest",
      () => list(`projects/${project}/locations/${region}`),
    ),
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
