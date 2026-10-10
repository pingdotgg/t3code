import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { isTransientGcpError } from "../Errors.ts";

// Translation Advanced glossaries, AutoML models, and Adaptive MT live only in us-central1 (or global).
export const DEFAULT_LOCATION = "us-central1";
const MAX_DISPLAY_NAME_LENGTH = 32;
const MAX_ID_LENGTH = 63;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Translate.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.Translate.ResourceStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const locationParent = (project: string, location: string | undefined) =>
  `projects/${project}/locations/${normalizeLocation(location)}`;

export const locationParentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const locationsAt = parts.lastIndexOf("locations");
  if (locationsAt >= 0 && parts[locationsAt + 1]) {
    return parts.slice(0, locationsAt + 2).join("/");
  }
  return parts.slice(0, Math.max(0, parts.length - 2)).join("/");
};

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
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return `${locationParent(project, location)}/${collection}`;
  }
  if (trimmed.includes("/")) return trimmed;
  return `${locationParent(project, location)}/${collection}/${trimmed}`;
};

export const resourceNameOf = (
  parent: string,
  collection: string,
  id: string,
) => {
  if (id.length === 0) return "";
  if (id.includes(`/${collection}/`)) return id.replace(/\/+$/, "");
  return `${parent}/${collection}/${lastSegment(id)}`;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

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

const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousLocation?: string;
  nextLocation?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  const previousLocation =
    input.previousLocation !== undefined
      ? normalizeLocation(input.previousLocation)
      : undefined;
  const nextLocation =
    input.nextLocation !== undefined
      ? normalizeLocation(input.nextLocation)
      : undefined;
  const replace =
    (input.extra ?? false) ||
    (input.previousId !== undefined &&
      input.nextId !== undefined &&
      input.nextId !== input.previousId) ||
    (previousLocation !== undefined &&
      nextLocation !== undefined &&
      previousLocation !== nextLocation) ||
    (input.previousParent !== undefined &&
      input.nextParent !== undefined &&
      input.previousParent !== input.nextParent);
  if (!replace) return undefined;
  const samePhysical =
    (previousLocation === undefined || previousLocation === nextLocation) &&
    (input.previousParent === undefined ||
      input.previousParent === input.nextParent) &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return lastSegment(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    return yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
  });

/**
 * Adaptive MT datasets and custom models only accept display names of
 * A-Z, a-z, 0-9, and underscore, max 32 characters.
 */
export const toRestrictedDisplayName = (
  text: string,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string =>
  (text.replace(/[^A-Za-z0-9_]/g, "_").slice(0, maxLength) || "_").slice(
    0,
    maxLength,
  );

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
      while: (error) => error._tag === "GCP.Translate.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );
