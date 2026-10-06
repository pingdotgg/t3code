import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  stripInternalLabels,
} from "../Labels.ts";

export const MAX_NAME_LENGTH = 63;
export const MAX_PIPELINE_JOB_ID_LENGTH = 128;

export class AiPlatformNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.NotResolved",
)<{
  name: string;
}> {}

export class AiPlatformStillExists extends Data.TaggedError(
  "GCP.AIPlatform.StillExists",
)<{
  name: string;
}> {}

export type EncryptionSpec = {
  /** Cloud KMS key resource name. Immutable on most Vertex resources. */
  kmsKeyName?: string;
};

export type MachineSpec = {
  /** Machine type (e.g. `e2-standard-4`, `n1-standard-4`). Immutable. */
  machineType?: string;
  /** Accelerator type (`NVIDIA_TESLA_T4`, …). Immutable. */
  acceleratorType?: string;
  /** Number of accelerators to attach. */
  acceleratorCount?: number;
  /** Nvidia GPU partition size (MIG). Immutable. */
  gpuPartitionSize?: string;
  /** TPU topology (e.g. `2x2x1`). Immutable. */
  tpuTopology?: string;
};

export type NetworkSpec = {
  /** Enable public internet access. @default false */
  enableInternetAccess?: boolean;
  /** Subnetwork resource name. */
  subnetwork?: string;
  /** VPC network resource name. */
  network?: string;
};

export type PersistentDiskSpec = {
  /** Disk type (`pd-standard`, `pd-ssd`, …). */
  diskType?: string;
  /** Size in GB (string, e.g. `"100"`). */
  diskSizeGb?: string;
};

export type DiskSpec = {
  /** Boot disk type (`pd-ssd`, `pd-standard`, `hyperdisk-balanced`). */
  bootDiskType?: string;
  /** Boot disk size in GB. @default 100 */
  bootDiskSizeGb?: number;
};

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
  `projects/${project}/locations/${location}`;

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
  };
};

export const parentBefore = (name: string, collection: string) => {
  const marker = `/${collection}/`;
  const at = name.lastIndexOf(marker);
  return at >= 0 ? name.slice(0, at) : name;
};

export const rfc1035 = (name: string, maxLength = MAX_NAME_LENGTH): string => {
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

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      maxLength,
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasDescriptionOwnership = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

/**
 * Compact displayName stamp for APIs that cap display names at 63
 * characters and have no labels field.
 */
const DISPLAY_ID_LENGTH = 20;

export const encodeDisplayName = (
  labels: Record<string, string>,
  displayName: string | undefined,
  maxLength = 63,
): string => {
  const id = (labels[alchemyLabelKeys.id] ?? "x").slice(0, DISPLAY_ID_LENGTH);
  const marker = `[alc ${id}]`;
  const rest = (displayName ?? "").replace(/[\r\n]+/g, " ").trim();
  const combined = rest.length > 0 ? `${marker} ${rest}` : marker;
  return combined.slice(0, maxLength);
};

export const parseDisplayName = (
  displayName: string | undefined,
): {
  labels: Record<string, string>;
  displayName: string | undefined;
} => {
  if (!displayName?.startsWith("[alc ")) {
    return { labels: {}, displayName };
  }
  const end = displayName.indexOf("]");
  if (end < 0) return { labels: {}, displayName };
  const id = displayName.slice("[alc ".length, end).trim();
  const rest = displayName.slice(end + 1).replace(/^[\s\n]+/, "");
  return {
    labels: id.length > 0 ? { [alchemyLabelKeys.id]: id } : {},
    displayName: rest.length > 0 ? rest : undefined,
  };
};

export const hasDisplayNameOwnership = (displayName: string | undefined) =>
  Object.keys(parseDisplayName(displayName).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedById = (id: string, labels: Record<string, string>) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const expectedId = (expected[alchemyLabelKeys.id] ?? "").slice(
      0,
      DISPLAY_ID_LENGTH,
    );
    return labels[alchemyLabelKeys.id] === expectedId;
  });

export const collectPages = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
