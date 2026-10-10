import * as cloudsearch from "@distilled.cloud/gcp/cloudsearch_v1";
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

export const DATASOURCE_PREFIX = "datasources/";
export const SEARCH_APPLICATION_PREFIX = "searchapplications/";
export const MAX_DISPLAY_NAME_LENGTH = 300;
export const MAX_SHORT_NAME_LENGTH = 32;

const RESERVED_SHORT_NAMES = new Set([
  "mail",
  "gmail",
  "docs",
  "drive",
  "groups",
  "sites",
  "calendar",
  "hangouts",
  "gplus",
  "keep",
  "people",
  "teams",
]);

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.CloudSearch.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? false) === (right ?? false);

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

const markerOf = (
  _labels: Record<string, string>,
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
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
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
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) => {
  if (
    Object.keys(parseOwnership(text).labels).some((key) =>
      key.startsWith("alchemy-"),
    )
  ) {
    return true;
  }
  return (text ?? "").toLowerCase().includes("alchemy-");
};

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

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const toGeneratedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `c${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

export const sanitizeShortName = (value: string): string => {
  let next = value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (next.startsWith("google")) next = `a${next}`;
  if (RESERVED_SHORT_NAMES.has(next)) next = `a${next}`;
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, MAX_SHORT_NAME_LENGTH);
  if (next.length < 4) next = `${next}src`.slice(0, MAX_SHORT_NAME_LENGTH);
  if (RESERVED_SHORT_NAMES.has(next) || next.startsWith("google")) {
    next = `a${next}`.slice(0, MAX_SHORT_NAME_LENGTH);
  }
  return next;
};

export const toShortName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return sanitizeShortName(requested);
    }
    if (existing !== undefined && existing.length > 0) {
      return sanitizeShortName(existing);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_SHORT_NAME_LENGTH,
      lowercase: true,
    });
    return sanitizeShortName(generated);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.void,
    ),
  );

export const toDatasourceName = (value: string) => {
  if (value.length === 0) return value;
  return value.startsWith(DATASOURCE_PREFIX)
    ? value
    : `${DATASOURCE_PREFIX}${value}`;
};

export const datasourceIdOf = (name: string) =>
  name.startsWith(DATASOURCE_PREFIX)
    ? name.slice(DATASOURCE_PREFIX.length)
    : lastSegment(name);

export const toSearchApplicationName = (value: string) => {
  if (value.length === 0) return value;
  if (value.startsWith(SEARCH_APPLICATION_PREFIX)) return value;
  if (value.startsWith("applications/")) {
    return `${SEARCH_APPLICATION_PREFIX}${value.slice("applications/".length)}`;
  }
  return `${SEARCH_APPLICATION_PREFIX}${value}`;
};

export const searchApplicationIdOf = (name: string) => {
  if (name.startsWith(SEARCH_APPLICATION_PREFIX)) {
    return name.slice(SEARCH_APPLICATION_PREFIX.length);
  }
  if (name.startsWith("applications/")) {
    return name.slice("applications/".length);
  }
  return lastSegment(name);
};

const stringField = (value: unknown, key: string): string | undefined => {
  if (value === null || value === undefined || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

export const operationResourceName = (operation: cloudsearch.Operation) =>
  stringField(operation.response, "name") ??
  stringField(operation.metadata, "name");

/** Wait for an operation through the shared GCP waiter. */
export const waitForOperation = (
  operation: cloudsearch.Operation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      cloudsearch
        .getOperations({ name })
        .pipe(
          Effect.catchTag("NotFound", (error) =>
            options?.notFoundOk === true
              ? Effect.succeed<cloudsearch.Operation>({ name, done: true })
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
        : cloudsearch
            .getOperations({ name: operation.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(operation))),
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
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const getDatasource = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        cloudsearch.getSettingsDatasources({ name: toDatasourceName(name) }),
      );

export const listDatasources = () =>
  cloudsearch.listSettingsDatasources.pages({ pageSize: 1000 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.sources ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => emptyList<cloudsearch.DataSource>()),
  );

export const listOwnedDatasources = () =>
  listDatasources().pipe(
    Effect.map((sources) =>
      sources.filter((source) => hasOwnershipMarker(source.displayName)),
    ),
  );

export const findOwnedDatasource = (id: string) =>
  Effect.gen(function* () {
    const sources = yield* listDatasources();
    for (const source of sources) {
      if (yield* ownedByAlchemy(id, source.displayName)) {
        return source;
      }
    }
    return undefined;
  });

export const getSearchApplication = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        cloudsearch.getSettingsSearchapplications({
          name: toSearchApplicationName(name),
        }),
      );

export const listSearchApplications = () =>
  cloudsearch.listSettingsSearchapplications.pages({ pageSize: 100 }).pipe(
    Stream.flatMap((page) =>
      Stream.fromIterable(page.searchApplications ?? []),
    ),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () =>
      emptyList<cloudsearch.SearchApplication>(),
    ),
  );

export const listOwnedSearchApplications = () =>
  listSearchApplications().pipe(
    Effect.map((apps) =>
      apps.filter((app) => hasOwnershipMarker(app.displayName)),
    ),
  );

export const findOwnedSearchApplication = (id: string) =>
  Effect.gen(function* () {
    const apps = yield* listSearchApplications();
    for (const app of apps) {
      if (yield* ownedByAlchemy(id, app.displayName)) {
        return app;
      }
    }
    return undefined;
  });

export const findDatasourceByDisplayName = (displayName: string) =>
  listDatasources().pipe(
    Effect.map((sources) =>
      sources.find((source) => source.displayName === displayName),
    ),
  );

export const findSearchApplicationByDisplayName = (displayName: string) =>
  listSearchApplications().pipe(
    Effect.map((apps) => apps.find((app) => app.displayName === displayName)),
  );
