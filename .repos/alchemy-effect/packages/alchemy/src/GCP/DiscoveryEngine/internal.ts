import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { createInternalLabels } from "../Labels.ts";

export const DEFAULT_LOCATION = "global";
export const DEFAULT_COLLECTION = "default_collection";
export const DEFAULT_BRANCH = "default_branch";
export const LIST_LOCATIONS = ["global"] as const;
export const MAX_ID_LENGTH = 63;
export const MAX_NAME_LENGTH = MAX_ID_LENGTH;
export const MAX_DOCUMENT_ID_LENGTH = 128;
export const MAX_DISPLAY_NAME_LENGTH = 128;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const parentOf = (name: string, collection?: string) => {
  if (collection !== undefined) {
    const marker = `/${collection}/`;
    const index = name.lastIndexOf(marker);
    return index >= 0 ? name.slice(0, index) : name;
  }
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const parentBefore = parentOf;

export const parseResourceName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const dataStoresAt = parts.lastIndexOf("dataStores");
  const collectionsAt = parts.lastIndexOf("collections");
  const collectionId =
    collectionsAt >= 0 && parts[collectionsAt + 1]
      ? parts[collectionsAt + 1]!
      : DEFAULT_COLLECTION;
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    collection: collectionId,
    collectionId,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    dataStoreId:
      dataStoresAt >= 0 && parts[dataStoresAt + 1]
        ? parts[dataStoresAt + 1]!
        : "",
    dataStore:
      dataStoresAt >= 0
        ? parts.slice(0, dataStoresAt + 2).join("/")
        : parentOf(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const expandDataStore = (
  value: string,
  project: string,
  location: string,
) =>
  value.includes("/")
    ? value
    : `projects/${project}/locations/${location}/collections/${DEFAULT_COLLECTION}/dataStores/${value}`;

export const rfc1035 = (name: string, maxLength = MAX_ID_LENGTH): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return "resource";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const controlIdOf = (
  name: string,
  maxLength = MAX_ID_LENGTH,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[0-9]/g, (digit) => "abcdefghij"[Number(digit)]!)
    .replace(/[^a-z_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, maxLength).replace(/[-_]+$/g, "");
  return next.length > 0 ? next : "control";
};

export const servingConfigIdOf = (
  name: string,
  maxLength = MAX_ID_LENGTH,
): string => {
  let next = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[a-z]/.test(next)) next = `s${next}`;
  next = next.slice(0, maxLength);
  if (next.length < 4) next = `${next}xxxx`.slice(0, 4);
  return next.length > 0 ? next : "scfg";
};

export const sessionIdOf = (
  name: string,
  maxLength = MAX_ID_LENGTH,
): string => {
  let next = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[a-z]/.test(next)) next = `s${next}`;
  next = next.slice(0, maxLength);
  return next.length > 0 ? next : "session";
};

export const identityMappingStoreIdOf = (name: string): string => {
  const body = rfc1035(name, 59);
  const prefixed = body.startsWith("alch") ? body : `alch${body}`;
  return prefixed.slice(0, MAX_ID_LENGTH);
};

export const toPhysical = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  format: (name: string) => string,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return format(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
    );
  });

export const internalLabels = (id: string) => createInternalLabels(id);

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

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  fingerprint([...(left ?? [])].sort()) ===
  fingerprint([...(right ?? [])].sort());

export const parseJsonObject = (
  json: string | undefined,
): Record<string, unknown> | undefined => {
  if (json === undefined || json.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/** Parse a JSON Schema document and default its `$schema` version. */
export const withSchemaVersion = (jsonSchema: string | undefined): string => {
  const obj = parseJsonObject(jsonSchema) ?? {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
    },
  };
  if (obj.$schema === undefined) {
    obj.$schema = "https://json-schema.org/draft/2020-12/schema";
  }
  return JSON.stringify(obj);
};

export const listDataStores = (project: string) =>
  Effect.forEach(
    LIST_LOCATIONS,
    (location) =>
      discoveryengine.listProjectsLocationsDataStores
        .pages({
          parent: locationParent(project, location),
          pageSize: 50,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.dataStores ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        ),
    { concurrency: 2 },
  ).pipe(Effect.map((groups) => groups.flat()));

export const normalizeCollection = (collection: string | undefined) =>
  lastSegment(collection ?? DEFAULT_COLLECTION);

export const collectionParent = (
  project: string,
  location: string,
  collectionId: string,
) => `${locationParent(project, location)}/collections/${collectionId}`;

export const dataStoreName = (
  project: string,
  location: string,
  collectionId: string,
  dataStoreId: string,
) =>
  `${collectionParent(project, location, collectionId)}/dataStores/${dataStoreId}`;

export const dataStoreIdOf = (value: string) => lastSegment(value);

export const servingConfigId = servingConfigIdOf;

export const toResourceId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const listProjectDataStores = (project: string) =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const stores: discoveryengine.GoogleCloudDiscoveryengineV1DataStore[] = [];
    const locationStores = yield* listDataStores(project);
    const collectionStores = yield* listCollectionDataStores(project);
    for (const store of [...locationStores, ...collectionStores]) {
      const name = store.name ?? "";
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      stores.push(store);
    }
    return stores;
  });

export const branchParent = (dataStore: string, branchId = DEFAULT_BRANCH) =>
  `${dataStore}/branches/${branchId}`;

export const siteSearchEngineParent = (dataStore: string) =>
  `${dataStore}/siteSearchEngine`;

export const listCollectionDataStores = (project: string) =>
  Effect.forEach(
    LIST_LOCATIONS,
    (location) =>
      discoveryengine.listProjectsLocationsCollectionsDataStores
        .pages({
          parent: collectionParent(project, location, DEFAULT_COLLECTION),
          pageSize: 50,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.dataStores ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        ),
    { concurrency: 2 },
  ).pipe(Effect.map((groups) => groups.flat()));

/**
 * Target sites echo only `generatedUriPattern` (scheme stripped, directory
 * patterns suffixed with `*`), so compare against that normalized form.
 */
const normalizeUriPattern = (pattern: string) => {
  const bare = pattern.replace(/^https?:\/\//, "");
  return bare.endsWith("/") ? `${bare}*` : bare;
};

export const matchesUriPattern = (
  site: { providedUriPattern?: string; generatedUriPattern?: string },
  pattern: string,
) => {
  const observed = site.providedUriPattern ?? site.generatedUriPattern ?? "";
  return (
    observed === pattern ||
    normalizeUriPattern(observed) === normalizeUriPattern(pattern)
  );
};
