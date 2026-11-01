import * as observability from "@distilled.cloud/gcp/observability_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import { alchemyLabelKeys } from "../Labels.ts";

export const MAX_NAME_LENGTH = 100;
export const DEFAULT_TRACE_LOCATION = "global";
export const DEFAULT_BUCKET_ID = "_Trace";
export const DEFAULT_DATASET_ID = "Spans";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

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

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const expandProjectName = (value: string, project: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.startsWith("projects/")) return trimmed;
  if (trimmed.length === 0) return `projects/${project}`;
  return `projects/${lastSegment(trimmed)}`;
};

export const expandResourceNames = (
  names: readonly string[] | undefined,
  project: string,
) =>
  (names === undefined || names.length === 0
    ? [`projects/${project}`]
    : [...names]
  ).map((name) => expandProjectName(name, project));

export const toScopeId = (
  id: string,
  explicit: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z0-9]/.test(generated)
      ? generated
      : `s${generated}`.slice(0, MAX_NAME_LENGTH);
  });

export const toLinkId = (
  id: string,
  explicit: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
      delimiter: "_",
    });
    const cleaned = generated.replace(/-/g, "_").replace(/[^a-z0-9_]/g, "_");
    return /^[a-z]/.test(cleaned)
      ? cleaned
      : `l${cleaned}`.slice(0, MAX_NAME_LENGTH);
  });

export type ParsedLinkName = {
  project: string;
  location: string;
  bucketId: string;
  datasetId: string;
  linkId: string;
};

export const parseLinkName = (name: string): ParsedLinkName | undefined => {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)\/datasets\/([^/]+)\/links\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    project: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
    datasetId: match[4]!,
    linkId: match[5]!,
  };
};

export const parseDatasetName = (name: string) => {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)\/datasets\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    name: match[0]!,
    project: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
    datasetId: match[4]!,
  };
};

export const parseBucketName = (name: string) => {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    name: match[0]!,
    project: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
  };
};

export const parseScopeName = (name: string) => {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/traceScopes\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    project: match[1]!,
    location: match[2]!,
    traceScopeId: match[3]!,
  };
};

export const datasetResourceName = (
  project: string,
  location: string,
  bucketId: string,
  datasetId: string,
) =>
  `projects/${project}/locations/${location}/buckets/${bucketId}/datasets/${datasetId}`;

export const linkResourceName = (
  project: string,
  location: string,
  bucketId: string,
  datasetId: string,
  linkId: string,
) =>
  `${datasetResourceName(project, location, bucketId, datasetId)}/links/${linkId}`;

export const scopeResourceName = (
  project: string,
  location: string,
  traceScopeId: string,
) => `projects/${project}/locations/${location}/traceScopes/${traceScopeId}`;

export const resolveDatasetParent = (
  dataset: string,
  bucket: string | undefined,
  location: string,
  project: string,
) => {
  const fromDataset = parseDatasetName(dataset);
  if (fromDataset) return fromDataset;
  const fromBucket = bucket ? parseBucketName(bucket) : undefined;
  const bucketId =
    fromBucket?.bucketId ??
    (bucket !== undefined && bucket.length > 0
      ? lastSegment(bucket)
      : DEFAULT_BUCKET_ID);
  const resolvedLocation = fromBucket?.location ?? location;
  const resolvedProject = fromBucket?.project ?? project;
  const datasetId =
    dataset.length > 0 ? lastSegment(dataset) : DEFAULT_DATASET_ID;
  return {
    name: datasetResourceName(
      resolvedProject,
      resolvedLocation,
      bucketId,
      datasetId,
    ),
    project: resolvedProject,
    location: resolvedLocation,
    bucketId,
    datasetId,
  };
};

export const listLocationIds = (project: string, region: string) =>
  observability.listProjectsLocations
    .pages({
      name: `projects/${project}`,
      pageSize: 200,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.locations ?? [])),
      Stream.map(
        (location) => location.locationId ?? lastSegment(location.name ?? ""),
      ),
      Stream.filter((id) => id.length > 0),
      Stream.runCollect,
      Effect.map((chunk) => {
        const ids = new Set(Array.from(chunk));
        ids.add(DEFAULT_TRACE_LOCATION);
        ids.add(region);
        return [...ids];
      }),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([DEFAULT_TRACE_LOCATION, region]),
      ),
    );

const listBucketsAt = (parent: string) =>
  observability.listProjectsLocationsBuckets
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.buckets ?? [])),
      Stream.filter((bucket) => (bucket.name ?? "").length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as observability.Bucket[]),
      ),
    );

export const listProjectBuckets = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const wildcard = yield* listBucketsAt(
      `projects/${env.project}/locations/-`,
    );
    if (wildcard.length > 0) return wildcard;
    const locations = yield* listLocationIds(env.project, env.region);
    const pages = yield* Effect.forEach(
      locations,
      (location) =>
        listBucketsAt(`projects/${env.project}/locations/${location}`),
      { concurrency: 4 },
    );
    const byName = new Map<string, observability.Bucket>();
    for (const bucket of pages.flat()) {
      if (bucket.name) byName.set(bucket.name, bucket);
    }
    return [...byName.values()];
  });

const listDatasetsAt = (parent: string) =>
  observability.listProjectsLocationsBucketsDatasets
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.datasets ?? [])),
      Stream.filter((dataset) => (dataset.name ?? "").length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as observability.Dataset[]),
      ),
    );

export const listProjectDatasets = () =>
  Effect.gen(function* () {
    const buckets = yield* listProjectBuckets();
    const pages = yield* Effect.forEach(
      buckets,
      (bucket) => listDatasetsAt(bucket.name!),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listLinksAt = (parent: string) =>
  observability.listProjectsLocationsBucketsDatasetsLinks
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.links ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as observability.Link[]),
      ),
    );
