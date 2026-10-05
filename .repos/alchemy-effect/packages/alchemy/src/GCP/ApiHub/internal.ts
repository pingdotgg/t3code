import * as apihub from "@distilled.cloud/gcp/apihub_v1";
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
import {
  waitForOperation as waitForLongRunning,
  type LongRunningOperation,
} from "../Operation.ts";

export type AttributeValues = apihub.GoogleCloudApihubV1AttributeValues;
export type AttributeValuesMap = apihub.GoogleCloudApihubV1AttributeValuesMap;
export type Documentation = apihub.GoogleCloudApihubV1Documentation;

export const MAX_ID_LENGTH = 63;
export const MAX_INSTANCE_ID_LENGTH = 40;
export const MAX_DISPLAY_NAME_LENGTH = 64;

export class ApihubNotResolved extends Data.TaggedError(
  "GCP.ApiHub.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ApihubStillExists extends Data.TaggedError(
  "GCP.ApiHub.StillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const locationOf = (name: string, fallback: string) => {
  const parts = name.split("/");
  const index = parts.indexOf("locations");
  return index >= 0 ? (parts[index + 1] ?? fallback) : fallback;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

export const parseResourceName = (
  name: string,
  collection: string,
  defaultLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const pluginsAt = parts.lastIndexOf("plugins");
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
    pluginId:
      pluginsAt >= 0 && parts[pluginsAt + 1] ? parts[pluginsAt + 1]! : "",
    plugin:
      pluginsAt >= 0 ? parts.slice(0, pluginsAt + 2).join("/") : undefined,
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

export const rfc1035 = (name: string, maxLength = MAX_ID_LENGTH): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return "apihub";
  if (next.length < 4) next = `${next}xxxx`.slice(0, maxLength);
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({ id, maxLength, lowercase: true }),
      maxLength,
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

const markerOf = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf({
    [alchemyLabelKeys.stack]: stack,
    [alchemyLabelKeys.stage]: stage,
    [alchemyLabelKeys.id]: id,
  });
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
    marker = markerOf({
      [alchemyLabelKeys.stack]: stack,
      [alchemyLabelKeys.stage]: stage,
      [alchemyLabelKeys.id]: id,
    });
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = fitMarker(labels, 8000);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
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

export const createOwnership = (id: string) => createInternalLabels(id);

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

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].sort()) ===
  JSON.stringify([...(right ?? [])].sort());

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

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

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is Exclude<A, undefined> => value !== undefined,
      () => new ApihubNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ApiHub.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ApihubStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ApiHub.StillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.asVoid,
  );

export const collectPages = <Page, Item, E, R>(
  stream: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly Item[] | undefined,
) =>
  stream.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const emptyOnMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: A,
) =>
  effect.pipe(
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.succeed(fallback),
    ),
  );

export const listItems = <Page, Item, E extends { readonly _tag: string }, R>(
  pages: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly Item[] | undefined,
) => emptyOnMissing(collectPages(pages, pick), [] as Item[]);

export const listApis = (parent: string) =>
  listItems(
    apihub.listProjectsLocationsApis.pages({ parent, pageSize: 1000 }),
    (page) => page.apis,
  );

export const listVersions = (api: string) =>
  listItems(
    apihub.listProjectsLocationsApisVersions.pages({
      parent: api,
      pageSize: 1000,
    }),
    (page) => page.versions,
  );

export const listOperations = (version: string) =>
  listItems(
    apihub.listProjectsLocationsApisVersionsOperations.pages({
      parent: version,
      pageSize: 1000,
    }),
    (page) => page.apiOperations,
  );

export const listSpecs = (version: string) =>
  listItems(
    apihub.listProjectsLocationsApisVersionsSpecs.pages({
      parent: version,
      pageSize: 1000,
    }),
    (page) => page.specs,
  );

export const listAttributes = (parent: string) =>
  listItems(
    apihub.listProjectsLocationsAttributes.pages({ parent, pageSize: 1000 }),
    (page) => page.attributes,
  );

export const listCurations = (parent: string) =>
  listItems(
    apihub.listProjectsLocationsCurations.pages({ parent, pageSize: 1000 }),
    (page) => page.curations,
  );

export const listDependencies = (parent: string) =>
  listItems(
    apihub.listProjectsLocationsDependencies.pages({ parent, pageSize: 1000 }),
    (page) => page.dependencies,
  );

export const listChildResources = <A, E, R>(
  parents: readonly { name?: string }[],
  list: (name: string) => Effect.Effect<A[], E, R>,
) =>
  Effect.forEach(
    parents.filter((parent) => (parent.name ?? "").length > 0),
    (parent) => list(parent.name!),
    { concurrency: 4 },
  ).pipe(Effect.map((groups) => groups.flat()));

export const encodeContents = (contents: string) =>
  Effect.sync(() => Buffer.from(contents, "utf8").toString("base64"));

export const openApiSpecType = (
  project: string,
  location: string,
): apihub.GoogleCloudApihubV1AttributeValues => ({
  attribute: `projects/${project}/locations/${location}/attributes/system-spec-type`,
  enumValues: {
    values: [{ id: "openapi", displayName: "OpenAPI Spec" }],
  },
});

export const ownershipLabels = createInternalLabels;
export const parseName = parseResourceName;
export const MAX_LONG_ID_LENGTH = 128;
export const MAX_PLUGIN_DISPLAY_NAME_LENGTH = 50;
export const MAX_PLUGIN_INSTANCE_DISPLAY_NAME_LENGTH = 255;

export const DEFAULT_PLUGIN_ACTIONS: apihub.GoogleCloudApihubV1PluginActionConfigList =
  [
    {
      id: "sync-metadata",
      displayName: "Sync metadata",
      description: "Sync API metadata into API hub",
      triggerMode: "API_HUB_ON_DEMAND_TRIGGER",
    },
  ];

export const DEFAULT_DEPLOYMENT_TYPE: apihub.GoogleCloudApihubV1AttributeValues =
  {
    enumValues: { values: [{ id: "apigee" }] },
  };

export const projectIdOf = (value: string | undefined, fallback = "") =>
  lastSegment(value && value.length > 0 ? value : fallback);

export const projectNameOf = (value: string | undefined, fallback = "") => {
  const raw = value && value.length > 0 ? value : fallback;
  return raw.startsWith("projects/") ? raw : `projects/${lastSegment(raw)}`;
};

export class ApihubInstanceFailed extends Data.TaggedError(
  "GCP.ApiHub.InstanceFailed",
)<{
  name: string;
  state?: string;
  message?: string;
}> {}

/** API hub instance provisioning takes up to ~15 minutes. */
const OPERATION_BUDGET = "20 minutes";

/**
 * Wait for a long-running operation. ALREADY_EXISTS (code 6) means a
 * concurrent create won the race; reconcile observes the resource next.
 */
export const waitForOperation = (operation: LongRunningOperation) =>
  waitForLongRunning(
    operation,
    (name) => apihub.getProjectsLocationsOperations({ name }),
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
