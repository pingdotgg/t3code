import * as datapipelines from "@distilled.cloud/gcp/datapipelines_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";

export const DEFAULT_TYPE = "PIPELINE_TYPE_BATCH";
export const DEFAULT_STATE = "STATE_ACTIVE";
export const MAX_ID_LENGTH = 63;
export const MAX_DISPLAY_NAME_LENGTH = 64;
// Data Pipelines rejects the `-` location wildcard on list with a bare
// INVALID_ARGUMENT, so enumerate regions explicitly.
export const LIST_LOCATIONS = [
  "us-central1",
  "us-east1",
  "us-west1",
  "europe-west1",
  "asia-east1",
] as const;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

// Key-order-insensitive: the API echoes maps (e.g. launch `parameters`) in
// its own order, which would otherwise read as a workload change.
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left ?? null)) ===
  JSON.stringify(canonical(right ?? null));

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const resourceName = (
  project: string,
  location: string,
  pipelineId: string,
) => `${locationParent(project, location)}/pipelines/${pipelineId}`;

export const parseName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const projectsAt = parts.lastIndexOf("projects");
  const locationsAt = parts.lastIndexOf("locations");
  const pipelinesAt = parts.lastIndexOf("pipelines");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    pipelineId:
      pipelinesAt >= 0 && parts[pipelinesAt + 1]
        ? parts[pipelinesAt + 1]!
        : lastSegment(name),
    parent:
      pipelinesAt > 0
        ? parts.slice(0, pipelinesAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const rfc1035 = (
  name: string,
  maxLength = MAX_ID_LENGTH,
  fallback = "pipeline",
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `p${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return fallback.slice(0, maxLength);
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, maxLength - 1)}0`;
  }
  return next.slice(0, maxLength);
};

export const sanitizeDisplayName = (value: string) => {
  let next = value
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  if (next.length === 0) return "pipeline";
  if (!/^[A-Za-z]/.test(next)) {
    next = `p${next}`.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }
  return next;
};

export const toPipelineId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return rfc1035(requested);
    }
    if (existing !== undefined && existing.length > 0) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

export const toDisplayName = (
  requested: string | undefined,
  fallback: string,
) =>
  requested !== undefined && requested.length > 0
    ? sanitizeDisplayName(requested)
    : sanitizeDisplayName(fallback);

export const stringMapOf = (
  value: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(value);

export const userSources = (
  sources: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(stringMapOf(sources));

export const ownershipSources = (
  labels: Record<string, string>,
  user?: Record<string, string>,
): Record<string, string> => ({
  ...(user ?? {}),
  [alchemyLabelKeys.stack]: labels[alchemyLabelKeys.stack] ?? "x",
  [alchemyLabelKeys.stage]: labels[alchemyLabelKeys.stage] ?? "x",
  [alchemyLabelKeys.id]: labels[alchemyLabelKeys.id] ?? "x",
});

export const hasOwnershipMarker = (
  sources: Record<string, string | undefined> | null | undefined,
) => Object.keys(sources ?? {}).some((key) => key.startsWith("alchemy-"));

export const ownedByAlchemy = (
  id: string,
  sources: Record<string, string | undefined> | null | undefined,
) => hasAlchemyLabels(id, stringMapOf(sources));

export const scheduleKey = (
  info: datapipelines.GoogleCloudDatapipelinesV1ScheduleSpec | undefined,
) => ({
  schedule: info?.schedule ?? "",
  timeZone: info?.timeZone ?? "",
});

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousLocation?: string;
  nextLocation?: string;
  previousType?: string;
  nextType?: string;
}) => {
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousLocation !== undefined &&
    input.nextLocation !== undefined &&
    input.previousLocation !== input.nextLocation
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousType !== undefined &&
    input.nextType !== undefined &&
    input.previousType !== input.nextType
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

export const getPipeline = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datapipelines
        .getProjectsLocationsPipelines({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ignoreMissing = <A, R>(
  effect: Effect.Effect<
    A,
    datapipelines.DeleteProjectsLocationsPipelinesError,
    R
  >,
) => effect.pipe(Effect.catchTag("NotFound", () => Effect.void));

const emptyList = <A>() => Effect.succeed([] as A[]);

export const listPipelinesAt = (parent: string) =>
  datapipelines.listProjectsLocationsPipelines
    .pages({
      parent,
      pageSize: 200,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.pipelines ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        emptyList<datapipelines.GoogleCloudDatapipelinesV1Pipeline>(),
      ),
    );

export const listOwnedPipelines = (project: string, region: string) =>
  Effect.gen(function* () {
    const pages = yield* Effect.forEach(
      [...new Set([region, ...LIST_LOCATIONS])],
      (location) => listPipelinesAt(locationParent(project, location)),
      { concurrency: 2 },
    );
    const seen = new Set<string>();
    const owned: datapipelines.GoogleCloudDatapipelinesV1Pipeline[] = [];
    for (const row of pages.flat()) {
      const name = row.name ?? "";
      if (name.length > 0 && seen.has(name)) continue;
      if (!hasOwnershipMarker(row.pipelineSources)) continue;
      if (name.length > 0) seen.add(name);
      owned.push(row);
    }
    return owned;
  });

export const findOwnedPipeline = (
  id: string,
  project: string,
  region: string,
  name?: string,
) =>
  Effect.gen(function* () {
    const existing = yield* getPipeline(name ?? "");
    if (existing !== undefined) return existing;
    const rows = yield* listOwnedPipelines(project, region);
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.pipelineSources)) {
        return row;
      }
    }
    return undefined;
  });
