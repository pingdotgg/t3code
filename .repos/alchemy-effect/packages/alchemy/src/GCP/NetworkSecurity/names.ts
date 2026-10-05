import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";

export const DEFAULT_LOCATION = "global";
export const MAX_NAME_LENGTH = 63;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `${fallback[0] ?? "n"}${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : fallback;
};

export const normalizeLocation = (
  location: string | undefined,
  fallback = DEFAULT_LOCATION,
) => lastSegment(location ?? fallback).toLowerCase();

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
  };
};

export const resourceName = (
  project: string,
  location: string,
  collection: string,
  id: string,
) => `projects/${project}/locations/${location}/${collection}/${id}`;

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const toResourcePath = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/projects\/[^/]+\/.+/);
  return match ? match[0]!.replace(/\/+$/, "") : trimmed;
};

export const toNetworkResource = (project: string, network: string) => {
  const trimmed = toResourcePath(network);
  const match = trimmed.match(/projects\/[^/]+\/global\/networks\/[^/]+/);
  if (match) return match[0]!;
  if (trimmed.includes("/")) return trimmed;
  return `projects/${project}/global/networks/${trimmed}`;
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const toId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
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
