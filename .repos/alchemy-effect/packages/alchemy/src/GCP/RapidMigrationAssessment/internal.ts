import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import { Retry as GcpRetry } from "@distilled.cloud/gcp/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

const noRetryLayer = Layer.succeed(GcpRetry, { while: () => false });

export const MAX_NAME_LENGTH = 63;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.RapidMigrationAssessment.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.RapidMigrationAssessment.ResourceStillExists",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.RapidMigrationAssessment.ResourceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ResourceFailed extends Data.TaggedError(
  "GCP.RapidMigrationAssessment.ResourceFailed",
)<{
  name: string;
  state: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "collector"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
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
  fallback = "collector",
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

export const parseName = (name: string, collection = "collectors") => {
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
        ? parts[collectionAt + 1]!
        : lastSegment(name),
  };
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const expectedAssetCountOf = (
  value: number | string | undefined,
): string | undefined => (value === undefined ? undefined : String(value));

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameNumber = (
  left: number | undefined,
  right: number | undefined,
) => (left ?? 0) === (right ?? 0);

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const replaceOnIdentity = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
  previousLocation: string;
  nextLocation: string;
}) => {
  const replace =
    (input.previousId !== undefined &&
      input.nextId !== undefined &&
      input.nextId !== input.previousId) ||
    input.previousLocation !== input.nextLocation;
  if (!replace) return undefined;
  const samePhysical =
    input.previousLocation === input.nextLocation &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

const READY_STATES = new Set([
  "STATE_READY_TO_USE",
  "STATE_REGISTERED",
  "STATE_ACTIVE",
  "STATE_PAUSED",
]);

const FAILED_STATES = new Set(["STATE_ERROR"]);

const GONE_STATES = new Set(["STATE_DECOMMISSIONED"]);

export const isReadyState = (state: string | undefined) =>
  READY_STATES.has((state ?? "").toUpperCase());

export const isFailedState = (state: string | undefined) =>
  FAILED_STATES.has((state ?? "").toUpperCase());

export const isGoneState = (state: string | undefined) =>
  GONE_STATES.has((state ?? "").toUpperCase());

export const isPausedState = (state: string | undefined) =>
  (state ?? "").toUpperCase() === "STATE_PAUSED";

export const isRegisteredState = (state: string | undefined) => {
  const next = (state ?? "").toUpperCase();
  return (
    next === "STATE_REGISTERED" ||
    next === "STATE_ACTIVE" ||
    next === "STATE_PAUSED"
  );
};

/**
 * Wait for a Rapid Migration Assessment collector operation. An operation
 * that finished with `ALREADY_EXISTS` (6) is a lost create race;
 * `notFoundOk` also accepts `NOT_FOUND` (5).
 */
export const waitForOperation = (
  operation: rma.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      rma
        .getProjectsLocationsOperations({ name })
        .pipe(
          Effect.catchTag("NotFound", (error) =>
            options?.notFoundOk === true
              ? Effect.succeed<rma.Operation>({ name, done: true })
              : Effect.fail(error),
          ),
        ),
    { budget: "10 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
    Effect.asVoid,
  );

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<NonNullable<A>, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.RapidMigrationAssessment.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.RapidMigrationAssessment.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.asVoid,
  );

export const waitUntilReady = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
  stateOf: (value: NonNullable<A>) => string | undefined,
): Effect.Effect<
  NonNullable<A>,
  E | ResourceNotResolved | ResourceFailed | ResourceNotReady,
  R
> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !isFailedState(stateOf(value)),
      (value) =>
        new ResourceFailed({
          name,
          state: stateOf(value) ?? "",
        }),
    ),
    Effect.filterOrFail(
      (value) => {
        const state = stateOf(value) ?? "";
        return isReadyState(state) || state.length === 0;
      },
      (value) => new ResourceNotReady({ name, state: stateOf(value) ?? "" }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.RapidMigrationAssessment.ResourceNotReady" ||
        error._tag === "GCP.RapidMigrationAssessment.ResourceNotResolved",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const emptyCollectors = Effect.succeed<rma.Collector[]>([]);

export const listCollectors = (parent: string) =>
  parent.length === 0
    ? emptyCollectors
    : rma.listProjectsLocationsCollectors
        .pages({ parent, pageSize: 1000 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.collectors ?? [])),
          Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(noRetryLayer),
          Effect.catchTag("NotFound", () => emptyCollectors),
        );

export const listOwnedCollectors = (project: string, _region: string) =>
  listCollectors(`projects/${project}/locations/-`);
