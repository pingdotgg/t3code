import type * as datacatalog from "@distilled.cloud/gcp/datacatalog_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { alchemyLabelKeys, hasAlchemyLabels } from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

export const MAX_TEMPLATE_ID_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const OWNERSHIP_FIELD_ID = "alchemy_ownership";

export type FieldType = datacatalog.GoogleCloudDatacatalogV1FieldType;
export type TagTemplateField =
  datacatalog.GoogleCloudDatacatalogV1TagTemplateField;
export type TagTemplateFieldMap =
  datacatalog.GoogleCloudDatacatalogV1TagTemplateFieldMap;
export type TaxonomyActivatedPolicyType =
  | datacatalog.GoogleCloudDatacatalogV1TaxonomyActivatedPolicyTypesItemEnum
  | (string & {});

export class DatacatalogNotResolved extends Data.TaggedError(
  "GCP.DataCatalog.ResourceNotResolved",
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

const sanitizeTemplateId = (name: string) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_");
  if (!/^[a-z_]/.test(next)) next = `t${next}`;
  next = next.slice(0, MAX_TEMPLATE_ID_LENGTH).replace(/_+$/g, "");
  return next.length > 0 ? next : "template";
};

export const toTagTemplateId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return sanitizeTemplateId(explicit);
    if (existing !== undefined) return existing;
    return sanitizeTemplateId(
      yield* createPhysicalName({
        id,
        maxLength: MAX_TEMPLATE_ID_LENGTH,
        lowercase: true,
        delimiter: "_",
      }),
    );
  });

export const toDisplayName = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) {
      return explicit.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
    }
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_DISPLAY_NAME_LENGTH,
      lowercase: true,
    });
    const next = generated
      .replace(/[^a-zA-Z0-9_ -]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_DISPLAY_NAME_LENGTH);
    return next.length > 0 ? next : "alchemy";
  });

const markerOf = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string => {
  const marker = markerOf(labels);
  const trimmed = text?.trim();
  if (!trimmed) return marker.slice(0, maxLength);
  return `${marker}\n${trimmed}`.slice(0, maxLength);
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

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseOwnership(text);
    return yield* hasAlchemyLabels(id, labels);
  });

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBool = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left === true) === (right === true);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].sort()) ===
  JSON.stringify([...(right ?? [])].sort());

const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length === 0 ? undefined : value;
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

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  previousLocation?: string;
  nextLocation?: string;
  extra?: boolean;
}) => {
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
  const locationChanged =
    (input.previousLocation ?? "") !== "" &&
    (input.nextLocation ?? "") !== "" &&
    (input.previousLocation ?? "").toLowerCase() !==
      (input.nextLocation ?? "").toLowerCase();
  if (!idChanged && !parentChanged && !locationChanged && !input.extra) {
    return undefined;
  }
  const samePhysical =
    !parentChanged &&
    !locationChanged &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return { action: "replace" as const, deleteFirst: samePhysical };
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

export const ignoreGone = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.void,
    ),
  );

export const missingGet =
  <A, E extends { readonly _tag: string }, R>(
    effect: (input: { name: string }) => Effect.Effect<A, E, R>,
  ) =>
  (name: string) =>
    name.length === 0
      ? Effect.succeed(undefined)
      : effect({ name }).pipe(
          Effect.catchIf(
            (error) => error._tag === "NotFound",
            () => Effect.succeed(undefined),
          ),
        );

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
): Effect.Effect<A[], E, R> =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk): A[] => Array.from(chunk)),
  );

export const emptyOnMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A[], E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.succeed([] as A[]),
    ),
  );

/**
 * Data Catalog rejects the `locations/-` wildcard (404), so owned rows are
 * listed in the default region only.
 */
export const listAtLocation = <A, E, R>(
  project: string,
  region: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
): Effect.Effect<A[], E, R> => list(locationParent(project, region));

export const findOwned = <A, E, R>(
  items: readonly A[],
  id: string,
  descriptionOf: (item: A) => string | undefined,
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (yield* ownedByAlchemy(id, descriptionOf(item))) {
        return item;
      }
    }
    return undefined;
  });

export const ownershipField = (
  labels: Record<string, string>,
): TagTemplateField => ({
  displayName: "Alchemy ownership",
  type: { primitiveType: "STRING" },
  isRequired: false,
  description: encodeOwnership(labels, undefined),
  order: 0,
});

export const userFields = (
  fields: TagTemplateFieldMap | undefined,
): TagTemplateFieldMap => {
  const next: TagTemplateFieldMap = {};
  for (const [key, field] of Object.entries(fields ?? {})) {
    if (key === OWNERSHIP_FIELD_ID || field === undefined) continue;
    next[key] = {
      displayName: field.displayName,
      type: field.type,
      isRequired: field.isRequired,
      description: field.description,
      order: field.order,
    };
  }
  return next;
};

export const desiredFields = (
  labels: Record<string, string>,
  fields: TagTemplateFieldMap | undefined,
): TagTemplateFieldMap => ({
  ...userFields(fields),
  [OWNERSHIP_FIELD_ID]: ownershipField(labels),
});

export const fieldBody = (field: TagTemplateField): TagTemplateField => ({
  displayName: field.displayName,
  type: field.type,
  isRequired: field.isRequired === true ? true : undefined,
  description: field.description,
  order: field.order,
});

export const primitiveOf = (type: FieldType | undefined) =>
  type?.primitiveType ?? "";

export const enumValuesOf = (type: FieldType | undefined) =>
  (type?.enumType?.allowedValues ?? [])
    .map((value) => value.displayName ?? "")
    .filter((value) => value.length > 0);

export const fieldNeedsReplace = (
  observed: TagTemplateField | undefined,
  desired: TagTemplateField,
) => {
  if (observed === undefined) return false;
  const observedPrimitive = primitiveOf(observed.type);
  const desiredPrimitive = primitiveOf(desired.type);
  if (observedPrimitive !== desiredPrimitive) return true;
  const observedHasEnum =
    (observed.type?.enumType?.allowedValues ?? []).length > 0;
  const desiredHasEnum =
    (desired.type?.enumType?.allowedValues ?? []).length > 0;
  if (observedHasEnum !== desiredHasEnum) return true;
  if (desiredHasEnum) {
    const observedValues = new Set(enumValuesOf(observed.type));
    const desiredValues = enumValuesOf(desired.type);
    if (desiredValues.some((value) => !observedValues.has(value))) {
      return false;
    }
    if (observedValues.size > desiredValues.length) return true;
  }
  return false;
};
