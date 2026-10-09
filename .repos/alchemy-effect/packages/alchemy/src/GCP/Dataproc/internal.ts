import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";

export const DEFAULT_ZONE = "us-central1-a";
export const MAX_POLICY_ID_LENGTH = 50;
// Cluster, batch, and session operations run for minutes; poll for up to ~10
// minutes (at 5-8s spacing) before giving up.
export const MAX_POLLS = 120;
export const MAX_WORKLOAD_ID_LENGTH = 63;
export const MIN_WORKLOAD_ID_LENGTH = 4;
// Session template ids match `[a-zA-Z0-9][-_a-zA-Z0-9]{1,48}[a-zA-Z0-9]`.
export const MAX_SESSION_TEMPLATE_ID_LENGTH = 50;
// Managed cluster name prefixes match `[a-z]([-a-z0-9]{0,34}[a-z0-9])?`.
export const MAX_MANAGED_CLUSTER_PREFIX_LENGTH = 36;

export const LIST_LOCATIONS = [
  "us-central1",
  "us-east1",
  "us-east4",
  "us-west1",
  "europe-west1",
  "asia-east1",
] as const;

export class DataprocNotResolved extends Data.TaggedError(
  "GCP.Dataproc.ResourceNotResolved",
)<{
  name: string;
}> {}

export class DataprocStillExists extends Data.TaggedError(
  "GCP.Dataproc.ResourceStillExists",
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
  `projects/${project}/locations/${location}`;

export const regionParent = (project: string, region: string) =>
  `projects/${project}/regions/${region}`;

export const parseResourceName = (
  name: string,
  collection: string,
  fallbackLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const regionsAt = parts.lastIndexOf("regions");
  const projectsAt = parts.lastIndexOf("projects");
  const placeAt = locationsAt >= 0 ? locationsAt : regionsAt;
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      placeAt >= 0 && parts[placeAt + 1]
        ? parts[placeAt + 1]!
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

export const rfc1035 = (
  name: string,
  maxLength: number,
  fallback: string,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "d"}${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) next = fallback;
  if (next.length < MIN_WORKLOAD_ID_LENGTH) {
    next = `${next}${fallback}xxxx`.slice(0, MIN_WORKLOAD_ID_LENGTH);
  }
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength: number,
  fallback: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, maxLength, fallback);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      maxLength,
      fallback,
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

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
  effect: Effect.Effect<A[], E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.succeed([] as A[]),
    ),
  );

/**
 * Wait for a Dataproc operation. Cluster creates and batch/session
 * startups take several minutes (clusters up to ~20). An operation that
 * finished with `ALREADY_EXISTS` (6) is a lost create race; `notFoundOk`
 * also accepts `NOT_FOUND` (5).
 */
export const waitForOperation = (
  operation: dataproc.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      (name.includes("/regions/")
        ? dataproc.getProjectsRegionsOperations({ name })
        : dataproc.getProjectsLocationsOperations({ name })
      ).pipe(
        Effect.catchTag("NotFound", (error) =>
          options?.notFoundOk === true
            ? Effect.succeed<dataproc.Operation>({ name, done: true })
            : Effect.fail(error),
        ),
      ),
    { budget: "30 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
    Effect.asVoid,
  );

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(new DataprocNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataproc.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : Effect.fail(new DataprocStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataproc.ResourceStillExists",
      times: MAX_POLLS,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

export const defaultYarnConfig = (): dataproc.BasicYarnAutoscalingConfig => ({
  gracefulDecommissionTimeout: "3600s",
  scaleUpFactor: 0.5,
  scaleDownFactor: 0,
  scaleUpMinWorkerFraction: 0,
  scaleDownMinWorkerFraction: 0,
});

export const defaultWorkerConfig =
  (): dataproc.InstanceGroupAutoscalingPolicyConfig => ({
    minInstances: 2,
    maxInstances: 3,
    weight: 1,
  });

export const defaultSparkBatch = (): dataproc.SparkBatch => ({
  mainClass: "org.apache.spark.examples.SparkPi",
  jarFileUris: ["file:///usr/lib/spark/examples/jars/spark-examples.jar"],
  args: ["1"],
});

export const defaultWorkflowJobs = (): dataproc.OrderedJobList => [
  {
    stepId: "spark-pi",
    sparkJob: defaultSparkBatch(),
  },
];

export const defaultWorkflowPlacement = (
  clusterName: string,
): dataproc.WorkflowTemplatePlacement => ({
  managedCluster: {
    clusterName,
    config: {
      gceClusterConfig: { zoneUri: DEFAULT_ZONE },
      masterConfig: {
        numInstances: 1,
        machineTypeUri: "n1-standard-2",
        diskConfig: { bootDiskSizeGb: 30 },
      },
      workerConfig: { numInstances: 2 },
      softwareConfig: { imageVersion: "2.2-debian12" },
    },
  },
});
