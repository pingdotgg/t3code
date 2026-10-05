import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";
import {
  type LongRunningOperation,
  waitForOperation as waitForLongRunningOperation,
} from "../Operation.ts";

export const MAX_NAME_LENGTH = 63;

export class EventarcNotResolved extends Data.TaggedError(
  "GCP.Eventarc.NotResolved",
)<{
  name: string;
}> {}

export class EventarcStillExists extends Data.TaggedError(
  "GCP.Eventarc.StillExists",
)<{
  name: string;
}> {}

export type LoggingConfig = {
  /**
   * Minimum log severity sent to Cloud Logging (`NONE`, `DEBUG`,
   * `INFO`, `NOTICE`, `WARNING`, `ERROR`, `CRITICAL`, `ALERT`,
   * `EMERGENCY`).
   */
  logSeverity?: eventarc.LoggingConfigLogSeverityEnum | (string & {});
};

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
    next = `e${next}`;
  }
  next = next.slice(0, maxLength).replace(/-+$/, "");
  return next.length > 0 ? next : fallback;
};

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

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
  defaultLocation: string,
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
        : defaultLocation,
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

export const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(annotations);

export const hasAlchemyLabelKeys = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const expandResource = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes(`/${collection}/`)) return trimmed;
  return resourceName(project, location, collection, lastSegment(trimmed));
};

export const expandTopic = (value: string, project: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/topics/")) return trimmed;
  return `projects/${project}/topics/${lastSegment(trimmed)}`;
};

export const toLoggingConfig = (
  config: LoggingConfig | eventarc.LoggingConfig | undefined,
): LoggingConfig | undefined => {
  const logSeverity = config?.logSeverity;
  if (logSeverity === undefined || logSeverity.length === 0) return undefined;
  return { logSeverity };
};

export const loggingKey = (
  config: LoggingConfig | eventarc.LoggingConfig | undefined,
) => toLoggingConfig(config)?.logSeverity ?? "";

export const cryptoKeyKey = (name: string | undefined) =>
  name === undefined || name.length === 0 ? "" : name;

export const textKey = (value: string | undefined) => value ?? "";

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left) ?? null) ===
  JSON.stringify(canonical(right) ?? null);

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

export const changedFields = (
  pairs: ReadonlyArray<readonly [string, boolean]>,
) => pairs.filter(([, changed]) => changed).map(([field]) => field);

export const compact = <T extends Record<string, unknown>>(value: T): T => {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== "") next[key] = entry;
  }
  return next as T;
};

/**
 * Wait on an Eventarc long-running operation. Pipelines and enrollments
 * routinely take ~4 minutes. `ALREADY_EXISTS` (a create race) counts as
 * success; `NOT_FOUND` does too when `notFoundOk` (deletes).
 */
export const waitForOperation = (
  operation: eventarc.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean },
) =>
  waitForLongRunningOperation(
    operation,
    (name) => {
      const get = eventarc.getProjectsLocationsOperations({ name });
      const observe: Effect.Effect<
        LongRunningOperation,
        eventarc.GetProjectsLocationsOperationsError,
        GcpOpContext
      > =
        options?.notFoundOk === true
          ? get.pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed<LongRunningOperation>({ name, done: true }),
              ),
            )
          : get.pipe(
              // A just-returned operation can briefly 404 on read.
              Effect.retry({
                while: (error) => error._tag === "NotFound",
                times: 5,
                schedule: Schedule.exponential("250 millis"),
              }),
            );
      return observe;
    },
    { budget: "15 minutes" },
  ).pipe(
    // google.rpc.Code ALREADY_EXISTS = 6, NOT_FOUND = 5.
    Effect.catchTag("GCP.OperationFailed", (error) =>
      error.code === 6 || (options?.notFoundOk === true && error.code === 5)
        ? Effect.succeed<LongRunningOperation>(operation)
        : Effect.fail(error),
    ),
  );

export const retryOnTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "Conflict" || error._tag === "GCP.OperationFailed",
      times: 8,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const waitUntilPresent = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(new EventarcNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error instanceof EventarcNotResolved,
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
        : Effect.fail(new EventarcStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error instanceof EventarcStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

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
    Effect.map((chunk) => Array.from(chunk)),
    // A missing parent location lists as empty.
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.succeed<Item[]>([]),
    ),
  );
