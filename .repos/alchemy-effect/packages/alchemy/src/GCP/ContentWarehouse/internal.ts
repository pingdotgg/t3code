import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
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

export const DEFAULT_LOCATION = "us";
export const LIST_LOCATIONS = ["us", "eu"] as const;
export const MAX_ID_LENGTH = 63;
export const MAX_DISPLAY_NAME_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 8000;
export const MAX_CONTEXT_LENGTH = 64;

export class ContentwarehouseOperationPending extends Data.TaggedError(
  "GCP.ContentWarehouse.OperationPending",
)<{
  operation: string;
}> {}

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.ContentWarehouse.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.ContentWarehouse.ResourceStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "cwh"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_ID_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_ID_LENGTH - 1)}0`;
  return next.slice(0, MAX_ID_LENGTH);
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const locationParent = (project: string, location: string | undefined) =>
  `projects/${project}/locations/${normalizeLocation(location)}`;

export const parseName = (name: string, collection: string) => {
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
        : DEFAULT_LOCATION,
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

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "cwh",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, fallback);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
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

const markerOf = (
  labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const compactMarkerOf = (stack: string, stage: string, id: string) =>
  `[alc ${stack} ${stage} ${id}]`;

const shrinkMarker = (
  labels: Record<string, string>,
  maxLength: number,
  build: (stack: string, stage: string, id: string) => string,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = build(stack, stage, id);
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
    marker = build(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = shrinkMarker(
    labels,
    MAX_DESCRIPTION_LENGTH,
    (stack, stage, id) => markerOf(labels, stack, stage, id),
  );
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const marker =
    maxLength < 54
      ? shrinkMarker(labels, maxLength, compactMarkerOf)
      : shrinkMarker(labels, maxLength, (stack, stage, id) =>
          markerOf(labels, stack, stage, id),
        );
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return marker;
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (text?.startsWith("[alc ")) {
    const end = text.indexOf("]");
    if (end < 0) return { labels: {}, text };
    const parts = text.slice("[alc ".length, end).trim().split(/\s+/);
    const labels: Record<string, string> = {};
    if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0]!;
    if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1]!;
    if (parts[2]) labels[alchemyLabelKeys.id] = parts[2]!;
    const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
    return { labels, text: rest.length > 0 ? rest : undefined };
  }
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

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousLocation?: string;
  nextLocation?: string;
  extra?: boolean;
}) => {
  const previousLocation = normalizeLocation(input.previousLocation);
  const nextLocation = normalizeLocation(input.nextLocation);
  const replace =
    (input.extra ?? false) ||
    (input.previousId !== undefined &&
      input.nextId !== undefined &&
      input.nextId !== input.previousId) ||
    (input.previousLocation !== undefined && previousLocation !== nextLocation);
  if (!replace) return undefined;
  const samePhysical =
    previousLocation === nextLocation &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const ignoreList =
  <A>(fallback: A) =>
  <A1, E extends { readonly _tag: string }, R>(
    self: Effect.Effect<A1, E, R>,
  ): Effect.Effect<A1 | A, E, R> =>
    self.pipe(
      Effect.catchIf(
        (error): error is Extract<E, { readonly _tag: "NotFound" }> =>
          error._tag === "NotFound",
        () => Effect.succeed(fallback),
      ),
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
        error._tag === "GCP.ContentWarehouse.ResourceNotResolved",
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
        error._tag === "GCP.ContentWarehouse.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

/** Wait for an operation through the shared GCP waiter. */
export const waitForOperation = (
  operation: cw.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      cw.getProjectsLocationsOperations({ name }).pipe(
        Effect.catchTag("NotFound", (error) =>
          options?.notFoundOk === true
            ? Effect.succeed<cw.GoogleLongrunningOperation>({
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
        : cw
            .getProjectsLocationsOperations({ name: operation.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(operation))),
    ),
  );

const isReady = (state: string | undefined) =>
  state === "PROJECT_STATE_COMPLETED";

const needsProvision = (state: string | undefined) =>
  state === undefined ||
  state === "PROJECT_STATE_UNSPECIFIED" ||
  state === "PROJECT_STATE_NOT_FOUND" ||
  state === "PROJECT_STATE_DELETED";

export const ensureProject = (parent: string) =>
  Effect.gen(function* () {
    const status = yield* cw
      .getStatusProjectsLocations({ location: parent })
      .pipe(
        Effect.catchTag("NotFound", () =>
          Effect.succeed<cw.GoogleCloudContentwarehouseV1ProjectStatus>({
            state: "PROJECT_STATE_NOT_FOUND",
          }),
        ),
      );
    if (isReady(status.state)) return status;

    if (status.state === "PROJECT_STATE_PENDING") {
      const pending = yield* cw
        .getStatusProjectsLocations({ location: parent })
        .pipe(
          Effect.filterOrFail(
            (current) => isReady(current.state),
            () =>
              new ContentwarehouseOperationPending({
                operation: parent,
              }),
          ),
          Effect.retry({
            while: (error) =>
              error._tag === "GCP.ContentWarehouse.OperationPending",
            times: 10,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      return pending;
    }

    if (!needsProvision(status.state)) return status;

    const operation = yield* cw
      .initializeProjectsLocations({
        location: parent,
        body: {
          accessControlMode: "ACL_MODE_UNIVERSAL_ACCESS",
          databaseType: "DB_INFRA_SPANNER",
          documentCreatorDefaultRole: "DOCUMENT_ADMIN",
        },
      })
      .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
    if (operation !== undefined) {
      yield* waitForOperation(operation);
    }
    return yield* cw.getStatusProjectsLocations({ location: parent }).pipe(
      Effect.filterOrFail(
        (current) => isReady(current.state),
        () => new ContentwarehouseOperationPending({ operation: parent }),
      ),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.ContentWarehouse.OperationPending",
        times: 10,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });

export const ownershipSynonymWord = (labels: Record<string, string>) =>
  encodeOwnershipLine(labels, undefined, 80);

export const withOwnershipSynonyms = (
  labels: Record<string, string>,
  synonyms:
    | readonly cw.GoogleCloudContentwarehouseV1SynonymSetSynonym[]
    | undefined,
): cw.GoogleCloudContentwarehouseV1SynonymSetSynonym[] => {
  const marker = ownershipSynonymWord(labels);
  const rest = (synonyms ?? []).filter(
    (group) =>
      !(group.words ?? []).some(
        (word) => word.startsWith("[alc ") || word.startsWith("[alchemy "),
      ),
  );
  return [{ words: [marker] }, ...rest];
};

export const userSynonyms = (
  synonyms:
    | readonly cw.GoogleCloudContentwarehouseV1SynonymSetSynonym[]
    | undefined,
): cw.GoogleCloudContentwarehouseV1SynonymSetSynonym[] =>
  (synonyms ?? []).filter(
    (group) =>
      !(group.words ?? []).some(
        (word) => word.startsWith("[alc ") || word.startsWith("[alchemy "),
      ),
  );

export const synonymOwnershipText = (
  synonyms:
    | readonly cw.GoogleCloudContentwarehouseV1SynonymSetSynonym[]
    | undefined,
) => {
  for (const group of synonyms ?? []) {
    for (const word of group.words ?? []) {
      if (word.startsWith("[alc ") || word.startsWith("[alchemy ")) {
        return word;
      }
    }
  }
  return undefined;
};

export const defaultTextProperty = (
  name = "title",
): cw.GoogleCloudContentwarehouseV1PropertyDefinition => ({
  name,
  displayName: name,
  isSearchable: true,
  isFilterable: true,
  textTypeOptions: {},
});

export const appendProperties = (
  observed:
    | readonly cw.GoogleCloudContentwarehouseV1PropertyDefinition[]
    | undefined,
  desired:
    | readonly cw.GoogleCloudContentwarehouseV1PropertyDefinition[]
    | undefined,
) => {
  const current = [...(observed ?? [])];
  const seen = new Set(
    current
      .map((item) => item.name?.toLowerCase())
      .filter((item): item is string => item !== undefined),
  );
  let appended = false;
  for (const property of desired ?? []) {
    const key = property.name?.toLowerCase();
    if (key === undefined || seen.has(key)) continue;
    current.push(property);
    seen.add(key);
    appended = true;
  }
  return { properties: current, appended };
};
