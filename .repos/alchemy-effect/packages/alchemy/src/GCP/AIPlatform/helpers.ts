import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const rfc1035 = (name: string, maxLength: number): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return "aiplatform";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const snakeId = (name: string, maxLength: number): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(next)) next = `f${next}`;
  next = next.slice(0, maxLength).replace(/_+$/g, "");
  if (next.length === 0) return "feature";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const toPhysicalRfc1035 = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength: number,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, maxLength);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({ id, maxLength, lowercase: true }),
      maxLength,
    );
  });

export const toPhysicalSnake = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength: number,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return snakeId(explicit, maxLength);
    if (existing !== undefined) return existing;
    return snakeId(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
        delimiter: "_",
      }),
      maxLength,
    );
  });

export const parseResourceName = (name: string, collection: string) => {
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
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const expandParent = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  if (value.includes("/")) return value;
  return `projects/${project}/locations/${location}/${collection}/${value}`;
};

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

export const specifiedEquals = (
  desired: unknown,
  observed: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (
    typeof desired === "boolean" ||
    typeof desired === "number" ||
    typeof desired === "string" ||
    Array.isArray(desired)
  ) {
    return fingerprint(desired) === fingerprint(observed);
  }
  if (desired !== null && typeof desired === "object") {
    const obs =
      observed !== null && typeof observed === "object"
        ? (observed as Record<string, unknown>)
        : {};
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => specifiedEquals(value, obs[key]),
    );
  }
  return fingerprint(desired) === fingerprint(observed);
};
