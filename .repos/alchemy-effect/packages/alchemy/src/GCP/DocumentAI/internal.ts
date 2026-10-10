import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

// Document AI is only served from the `us` / `eu` multi-region deployments, so the
// default stays `us` rather than following `GCP.Region`.
export const DEFAULT_LOCATION = "us";
/**
 * The distilled Document AI client talks to `documentai.googleapis.com`
 * (the US deployment). Listing processors/schemas in `eu` or regional
 * locations against that host returns HTTP 400 INVALID_ARGUMENT
 * (`Invalid location: '…' must match the server deployment 'us'`).
 */
export const LIST_LOCATIONS = ["us"] as const;
export const MAX_PROCESSOR_DISPLAY_NAME_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 128;
export const DEFAULT_PROCESSOR_TYPE = "OCR_PROCESSOR";

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.DocumentAI.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.DocumentAI.ResourceStillExists",
)<{
  name: string;
}> {}

export class ProcessorPending extends Data.TaggedError(
  "GCP.DocumentAI.ProcessorPending",
)<{
  name: string;
  state: string;
}> {}

export class ProcessorFailed extends Data.TaggedError(
  "GCP.DocumentAI.ProcessorFailed",
)<{
  name: string;
  state: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const parseResourceName = (name: string, collection: string) => {
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

export const expandParent = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `${locationParent(project, location)}/${collection}/${value}`;
};

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

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

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

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  const suffix = trimmed && trimmed.length > 0 ? ` ${trimmed}` : "";
  const markerMax = Math.min(
    maxLength,
    Math.max(12, maxLength - suffix.length),
  );
  const marker = shrinkMarker(labels, markerMax, compactMarkerOf);
  return `${marker}${suffix}`.slice(0, maxLength);
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

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = 32,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
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

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: isTransientGcpError,
      times: 8,
      schedule: Schedule.exponential("250 millis"),
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
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

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

export const listLocationParents = (project: string) =>
  Effect.succeed(
    LIST_LOCATIONS.map((location) => locationParent(project, location)),
  );

export const listProcessorsAt = (parent: string) =>
  parent.length === 0
    ? emptyList<documentai.GoogleCloudDocumentaiV1Processor>()
    : collectPages(
        documentai.listProjectsLocationsProcessors.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.processors,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<documentai.GoogleCloudDocumentaiV1Processor>(),
        ),
      );

export const listSchemasAt = (parent: string) =>
  parent.length === 0
    ? emptyList<documentai.GoogleCloudDocumentaiV1NextSchema>()
    : collectPages(
        documentai.listProjectsLocationsSchemas.pages({
          parent,
          pageSize: 20,
        }),
        (page) => page.schemas,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<documentai.GoogleCloudDocumentaiV1NextSchema>(),
        ),
      );

export const listSchemaVersionsAt = (parent: string) =>
  parent.length === 0
    ? emptyList<documentai.GoogleCloudDocumentaiV1SchemaVersion>()
    : collectPages(
        documentai.listProjectsLocationsSchemasSchemaVersions.pages({
          parent,
          pageSize: 20,
        }),
        (page) => page.schemaVersions,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<documentai.GoogleCloudDocumentaiV1SchemaVersion>(),
        ),
      );

export const listProjectProcessors = (project: string) =>
  Effect.gen(function* () {
    const parents = yield* listLocationParents(project);
    const groups = yield* Effect.forEach(parents, listProcessorsAt, {
      concurrency: 2,
    });
    const seen = new Set<string>();
    const processors: documentai.GoogleCloudDocumentaiV1Processor[] = [];
    for (const processor of groups.flat()) {
      const name = processor.name ?? "";
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      processors.push(processor);
    }
    return processors;
  });

export const listProjectSchemas = (project: string) =>
  Effect.gen(function* () {
    const parents = yield* listLocationParents(project);
    const groups = yield* Effect.forEach(parents, listSchemasAt, {
      concurrency: 2,
    });
    const seen = new Set<string>();
    const schemas: documentai.GoogleCloudDocumentaiV1NextSchema[] = [];
    for (const schema of groups.flat()) {
      const name = schema.name ?? "";
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      schemas.push(schema);
    }
    return schemas;
  });

export const findOwnedByDisplayName = <
  T extends { name?: string; displayName?: string },
>(
  id: string,
  items: readonly T[],
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.displayName)) return item;
    }
    return undefined as T | undefined;
  });

export const findOwnedByLabels = <
  T extends {
    name?: string;
    labels?: Record<string, string | undefined> | null;
  },
>(
  id: string,
  items: readonly T[],
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (yield* hasAlchemyLabels(id, tagRecord(item.labels))) return item;
    }
    return undefined as T | undefined;
  });
