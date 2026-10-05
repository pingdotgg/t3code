import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels as createInternalLabelsImpl,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels as toLabelsImpl,
} from "../Labels.ts";
import { resourceNameFromOperation as resourceNameFromOperationImpl } from "./operations.ts";

export const MAX_ID_LENGTH = 63;
export const MAX_DISPLAY_NAME_LENGTH = 128;
/** Locations `list` scans: the pre-`GCP.Region` default plus the stack region. */
export const listLocations = (region: string): string[] => [
  ...new Set(["us-central1", region]),
];

export const createInternalLabels = createInternalLabelsImpl;
export const toLabels = toLabelsImpl;
export const resourceNameFromOperation = resourceNameFromOperationImpl;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const locationOf = (name: string, fallback = "") => {
  const parts = name.split("/");
  const index = parts.indexOf("locations");
  return index >= 0 ? (parts[index + 1] ?? fallback) : fallback;
};

export const projectOf = (name: string, fallback = "") => {
  const parts = name.split("/");
  const index = parts.indexOf("projects");
  return index >= 0 ? (parts[index + 1] ?? fallback) : fallback;
};

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const enginesAt = parts.lastIndexOf("reasoningEngines");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    reasoningEngineId:
      enginesAt >= 0 && parts[enginesAt + 1] ? parts[enginesAt + 1]! : "",
    resourceId:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
  };
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing?: string,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const starts = /^[a-z]/.test(generated) ? generated : `a${generated}`;
    return starts.replace(/-+$/g, "").slice(0, maxLength);
  });

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) => toPhysicalId(id, requested, existing, maxLength);

export const toDisplayName = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* toPhysicalId(id, undefined, undefined);
  });

export const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;

export const stableJson = (value: unknown): string =>
  JSON.stringify(value ?? null, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      );
    }
    return item;
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyPrefix = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const alchemyIdFilter = (labels: Record<string, string>) => {
  const id = labels[alchemyLabelKeys.id];
  return id !== undefined && id.length > 0
    ? `labels.${alchemyLabelKeys.id}="${id}"`
    : undefined;
};

export const labelsDiffer = (
  observed: Record<string, string | undefined> | null | undefined,
  desired: Record<string, string>,
) => {
  const left = tagRecord(observed);
  const keys = new Set([...Object.keys(left), ...Object.keys(desired)]);
  for (const key of keys) {
    if ((left[key] ?? "") !== (desired[key] ?? "")) return true;
  }
  return false;
};

const markerOf = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

/** 64-bit FNV-1a, hex. Deterministic and dependency-free. */
const fnv1a64 = (input: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
};

const HASH_KEY = "alchemy-hash";

const ownershipHash = (labels: Record<string, string>) =>
  fnv1a64(
    JSON.stringify([
      labels[alchemyLabelKeys.stack],
      labels[alchemyLabelKeys.stage],
      labels[alchemyLabelKeys.id],
    ]),
  );

/**
 * Prefix `displayName` with the ownership marker. When the full
 * `[alchemy stack=… stage=… id=…]` marker would push the name past
 * Vertex AI's 128-character limit (long stack names), a fixed-width
 * `[alchemy alchemy-hash=…]` marker is used instead so it is never cut.
 */
export const encodeDisplayName = (
  labels: Record<string, string>,
  displayName: string | undefined,
): string => {
  const trimmed = displayName?.replace(/[\r\n]+/g, " ").trim();
  const withMarker = (marker: string) =>
    trimmed && trimmed.length > 0 ? `${marker} ${trimmed}` : marker;
  const full = withMarker(markerOf(labels));
  if (full.length <= MAX_DISPLAY_NAME_LENGTH) return full;
  return withMarker(`[alchemy ${HASH_KEY}=${ownershipHash(labels)}]`).slice(
    0,
    MAX_DISPLAY_NAME_LENGTH,
  );
};

/** Whether a marked display name belongs to logical id `id` of this stack. */
export const ownsDisplayName = (id: string, displayName: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseDisplayName(displayName);
    const expected = yield* createInternalLabelsImpl(id);
    if (labels[HASH_KEY] !== undefined) {
      return labels[HASH_KEY] === ownershipHash(expected);
    }
    return yield* hasAlchemyLabels(id, labels);
  });

export const parseDisplayName = (
  displayName: string | undefined,
): {
  labels: Record<string, string>;
  displayName: string | undefined;
} => {
  if (!displayName?.startsWith("[alchemy ")) {
    return { labels: {}, displayName };
  }
  const end = displayName.indexOf("]");
  if (end < 0) return { labels: {}, displayName };
  const labels: Record<string, string> = {};
  for (const part of displayName.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = displayName.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, displayName: rest.length > 0 ? rest : undefined };
};

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = markerOf(labels);
  return description ? `${marker}\n${description}` : marker;
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  const parsed = parseDisplayName(description);
  return { labels: parsed.labels, description: parsed.displayName };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseDisplayName(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );
