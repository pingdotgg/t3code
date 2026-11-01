import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForDeleteOperation, waitForOperation } from "./operations.ts";

const DEFAULT_INSTANCE_TYPE = "PRIMARY";
const DEFAULT_CPU_COUNT = 2;
const DEFAULT_READ_POOL_NODES = 1;
const MAX_NAME_LENGTH = 63;

export type MachineConfig = {
  /**
   * vCPU count. Must match `machineType` when both are set. Minimum 2
   * for PRIMARY instances.
   * @default 2
   */
  cpuCount?: number;
  /**
   * Machine type (e.g. `n2-highmem-4`, `n2-highmem-8`).
   */
  machineType?: string;
};

export type ReadPoolConfig = {
  /**
   * Node count in the read pool. Required when `instanceType` is
   * `READ_POOL`.
   * @default 1
   */
  nodeCount?: number;
};

export type QueryInsightsConfig = alloydb.QueryInsightsInstanceConfig;
export type ObservabilityConfig = alloydb.ObservabilityInstanceConfig;
export type ClientConnectionConfig = alloydb.ClientConnectionConfig;
export type InstanceNetworkConfig = alloydb.InstanceNetworkConfig;
export type PscInstanceConfig = alloydb.PscInstanceConfig;
export type ConnectionPoolConfig = alloydb.ConnectionPoolConfig;

export type InstanceProps = {
  /**
   * Parent cluster id or full resource name
   * (`projects/{project}/locations/{location}/clusters/{cluster}`).
   * Immutable — changing it replaces the instance.
   */
  cluster: string;
  /**
   * Region of the parent cluster (`us-central1`, …). Ignored when
   * `cluster` is a full resource name. Immutable — changing it replaces
   * the instance. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Instance id (the `{instance}` segment of
   * `.../clusters/{cluster}/instances/{instance}`). If omitted, a unique
   * RFC1035 name is generated. Must match
   * `[a-z]([a-z0-9-]{0,61}[a-z0-9])?`. Immutable — changing it replaces
   * the instance.
   */
  instanceId?: string;
  /**
   * Instance type. `SECONDARY` uses `instances.createsecondary`.
   * Immutable — changing it replaces the instance.
   * @default "PRIMARY"
   */
  instanceType?: alloydb.InstanceInstanceTypeEnum | (string & {});
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Arbitrary client annotations (distinct from labels).
   */
  annotations?: Record<string, string>;
  /**
   * VM shape for the database engine. Defaults to 2 vCPU.
   */
  machineConfig?: MachineConfig;
  /**
   * Availability type. PRIMARY defaults to `REGIONAL`. `gceZone` is only
   * valid with `ZONAL`.
   */
  availabilityType?: alloydb.InstanceAvailabilityTypeEnum | (string & {});
  /**
   * Compute Engine zone for `ZONAL` instances (e.g. `us-central1-a`).
   */
  gceZone?: string;
  /**
   * Whether the instance should run. `NEVER` stops it; `ALWAYS` starts
   * it.
   */
  activationPolicy?: alloydb.InstanceActivationPolicyEnum | (string & {});
  /**
   * Database flags (`"key": "value"`). Booleans use `on` / `off`.
   */
  databaseFlags?: Record<string, string>;
  /**
   * Read-pool size. Required when `instanceType` is `READ_POOL`.
   */
  readPoolConfig?: ReadPoolConfig;
  /**
   * Query Insights configuration.
   */
  queryInsightsConfig?: QueryInsightsConfig;
  /**
   * Observability configuration.
   */
  observabilityConfig?: ObservabilityConfig;
  /**
   * Client connection and SSL settings.
   */
  clientConnectionConfig?: ClientConnectionConfig;
  /**
   * Instance-level network configuration (public IP, authorized CIDRs).
   */
  networkConfig?: InstanceNetworkConfig;
  /**
   * Private Service Connect configuration for this instance.
   */
  pscInstanceConfig?: PscInstanceConfig;
  /**
   * Managed Connection Pool (MCP) configuration.
   */
  connectionPoolConfig?: ConnectionPoolConfig;
  /**
   * Controls the Data API (`executeSql`).
   */
  dataApiAccess?: alloydb.InstanceDataApiAccessEnum | (string & {});
};

export type Instance = Resource<
  "GCP.AlloyDB.Instance",
  InstanceProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/clusters/{cluster}/instances/{instance}`. */
    name: string;
    /** Instance id (last path segment). */
    instanceId: string;
    /** Parent cluster id. */
    clusterId: string;
    /** Parent cluster resource name. */
    clusterName: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** Instance type (`PRIMARY`, `READ_POOL`, `SECONDARY`). */
    instanceType: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Client annotations. */
    annotations: Record<string, string>;
    /** Serving state (`READY`, `CREATING`, `STOPPED`, …). */
    state: string | undefined;
    /** Private IP address. */
    ipAddress: string | undefined;
    /** Public IP address, if enabled. */
    publicIpAddress: string | undefined;
    /** Machine configuration currently applied. */
    machineConfig: MachineConfig | undefined;
    /** Availability type (`ZONAL`, `REGIONAL`). */
    availabilityType: string | undefined;
    /** Zone for ZONAL instances. */
    gceZone: string | undefined;
    /** Activation policy (`ALWAYS`, `NEVER`). */
    activationPolicy: string | undefined;
    /** Database flags currently applied. */
    databaseFlags: Record<string, string>;
    /** Read-pool configuration, if any. */
    readPoolConfig: ReadPoolConfig | undefined;
    /** Whether the service is reconciling intended vs actual state. */
    reconciling: boolean;
    /** System-generated UID. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An AlloyDB instance (compute attached to a cluster).
 *
 * Changing `cluster`, `location`, `instanceId`, or `instanceType`
 * replaces the instance. Machine size, flags, labels, activation policy,
 * and read-pool size update in place.
 *
 * A cluster may exist without instances (`EMPTY`). Creating a PRIMARY
 * instance typically takes several minutes.
 *
 * ### Creating an Instance
 * **Example:** Primary instance on a cluster
 * ```typescript
 * const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
 *   pscConfig: { pscEnabled: true },
 * });
 * const primary = yield* GCP.AlloyDB.Instance("Primary", {
 *   cluster: cluster.name,
 *   instanceType: "PRIMARY",
 *   machineConfig: { cpuCount: 2 },
 * });
 * ```
 *
 * **Example:** Explicit id, display name, and labels
 * ```typescript
 * const primary = yield* GCP.AlloyDB.Instance("Primary", {
 *   cluster: cluster.name,
 *   instanceId: "app-db-primary",
 *   displayName: "app-db-primary",
 *   labels: { env: "prod" },
 *   machineConfig: { cpuCount: 2 },
 * });
 * ```
 *
 * ### Read Pool
 * **Example:** Two-node read pool
 * ```typescript
 * const pool = yield* GCP.AlloyDB.Instance("Reads", {
 *   cluster: cluster.name,
 *   instanceType: "READ_POOL",
 *   readPoolConfig: { nodeCount: 2 },
 *   machineConfig: { cpuCount: 2 },
 * });
 * ```
 *
 * @resource
 * @category AlloyDB
 */
export const Instance = Resource<Instance>("GCP.AlloyDB.Instance");

export class InstanceNotResolved extends Data.TaggedError(
  "GCP.AlloyDB.InstanceNotResolved",
)<{
  name: string;
}> {}

export class InstanceClusterMissing extends Data.TaggedError(
  "GCP.AlloyDB.InstanceClusterMissing",
)<{
  message: string;
}> {}

export class InstanceNotReady extends Data.TaggedError(
  "GCP.AlloyDB.InstanceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class InstanceFailed extends Data.TaggedError(
  "GCP.AlloyDB.InstanceFailed",
)<{
  name: string;
  state: string;
}> {}

export class InstanceStillExists extends Data.TaggedError(
  "GCP.AlloyDB.InstanceStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

const normalizeInstanceType = (type: string | undefined) => {
  const value = (type ?? DEFAULT_INSTANCE_TYPE).toUpperCase();
  return value === "INSTANCE_TYPE_UNSPECIFIED" ? DEFAULT_INSTANCE_TYPE : value;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `i${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "instance";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const resourceName = (
  project: string,
  location: string,
  clusterId: string,
  instanceId: string,
) =>
  `projects/${project}/locations/${location}/clusters/${clusterId}/instances/${instanceId}`;

const clusterNameOf = (project: string, location: string, clusterId: string) =>
  `projects/${project}/locations/${location}/clusters/${clusterId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const instancesAt = parts.lastIndexOf("instances");
  const clustersAt = parts.lastIndexOf("clusters");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    clusterId:
      clustersAt >= 0 && parts[clustersAt + 1] ? parts[clustersAt + 1]! : "",
    instanceId:
      instancesAt >= 0 && parts[instancesAt + 1]
        ? parts[instancesAt + 1]!
        : lastSegment(name),
  };
};

const parseClusterRef = (
  cluster: string,
  fallbackProject: string,
  fallbackLocation: string,
) => {
  const trimmed = cluster.trim();
  if (trimmed.length === 0) {
    return {
      project: fallbackProject,
      location: normalizeLocation(fallbackLocation),
      clusterId: "",
    };
  }
  if (trimmed.includes("/clusters/") || trimmed.includes("projects/")) {
    const parsed = parseName(
      trimmed.includes("/instances/") ? trimmed : `${trimmed}/instances/_`,
    );
    return {
      project: parsed.project || fallbackProject,
      location: normalizeLocation(parsed.location || fallbackLocation),
      clusterId: parsed.clusterId === "_" ? "" : parsed.clusterId,
    };
  }
  return {
    project: fallbackProject,
    location: normalizeLocation(fallbackLocation),
    clusterId: lastSegment(trimmed),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const stringMapOf = (
  map: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[1].length > 0,
    ),
  );

const toId = (id: string, instanceId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      instanceId ??
      existing ??
      rfc1035(
        yield* createPhysicalName({
          id,
          maxLength: MAX_NAME_LENGTH,
          lowercase: true,
        }),
      )
    );
  });

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

const specifiedChanged = (
  desired: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
) => {
  if (desired === undefined) return false;
  const picked: Record<string, unknown> = {};
  const current: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    picked[key] = value;
    current[key] = observed?.[key];
  }
  return fingerprint(picked) !== fingerprint(current);
};

const toMachineConfig = (
  config: alloydb.MachineConfig | MachineConfig | undefined,
): MachineConfig | undefined => {
  if (config === undefined) return undefined;
  if (config.cpuCount === undefined && config.machineType === undefined) {
    return undefined;
  }
  return {
    cpuCount: config.cpuCount,
    machineType: config.machineType,
  };
};

const toReadPoolConfig = (
  config: alloydb.ReadPoolConfig | ReadPoolConfig | undefined,
): ReadPoolConfig | undefined => {
  if (config === undefined || config.nodeCount === undefined) return undefined;
  return { nodeCount: config.nodeCount };
};

const desiredMachineConfig = (news: InstanceProps): MachineConfig => ({
  cpuCount: news.machineConfig?.cpuCount ?? DEFAULT_CPU_COUNT,
  machineType: news.machineConfig?.machineType,
});

const desiredReadPoolConfig = (
  news: InstanceProps,
  instanceType: string,
): ReadPoolConfig | undefined => {
  if (instanceType !== "READ_POOL") return news.readPoolConfig;
  return {
    nodeCount: news.readPoolConfig?.nodeCount ?? DEFAULT_READ_POOL_NODES,
  };
};

const isAvailable = (state: string | undefined) => {
  const value = (state ?? "").toUpperCase();
  return value === "READY" || value === "STOPPED";
};

const isFailed = (state: string | undefined) =>
  (state ?? "").toUpperCase() === "FAILED";

const toAttrs = (instance: alloydb.Instance, project: string) => {
  const name = instance.name ?? "";
  const parsed = parseName(name);
  const clusterId = parsed.clusterId;
  const location = parsed.location;
  const resolvedProject = parsed.project || project;
  return {
    name,
    instanceId: parsed.instanceId,
    clusterId,
    clusterName: clusterNameOf(resolvedProject, location, clusterId),
    project: resolvedProject,
    location,
    instanceType: normalizeInstanceType(instance.instanceType),
    displayName: instance.displayName,
    labels: userLabels(instance.labels),
    annotations: stringMapOf(instance.annotations),
    state: instance.state,
    ipAddress: instance.ipAddress,
    publicIpAddress: instance.publicIpAddress,
    machineConfig: toMachineConfig(instance.machineConfig),
    availabilityType: instance.availabilityType,
    gceZone: instance.gceZone,
    activationPolicy: instance.activationPolicy,
    databaseFlags: stringMapOf(instance.databaseFlags),
    readPoolConfig: toReadPoolConfig(instance.readPoolConfig),
    reconciling: instance.reconciling === true,
    uid: instance.uid,
    createTime: instance.createTime,
    updateTime: instance.updateTime,
  };
};

const isPlaceholder = (instance: alloydb.Instance) => {
  const name = instance.name ?? "";
  return name.endsWith("/instances/-") || name.endsWith("/instances/");
};

const getByName = (name: string) =>
  alloydb
    .getProjectsLocationsClustersInstances({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(new InstanceNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.InstanceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  Effect.gen(function* () {
    const instance = yield* getByName(name);
    if (instance === undefined) {
      return yield* new InstanceNotReady({ name, state: "MISSING" });
    }
    if (isFailed(instance.state)) {
      return yield* new InstanceFailed({
        name,
        state: instance.state ?? "FAILED",
      });
    }
    if (!(isAvailable(instance.state) && instance.reconciling !== true)) {
      return yield* new InstanceNotReady({
        name,
        state: instance.state ?? "STATE_UNSPECIFIED",
      });
    }
    return instance;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.InstanceNotReady",
      times: 120,
      schedule: Schedule.spaced("15 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((instance) =>
      instance === undefined
        ? Effect.void
        : Effect.fail(new InstanceStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.InstanceStillExists",
      times: 120,
      schedule: Schedule.spaced("15 seconds"),
    }),
  );

const toCreateBody = (
  news: InstanceProps,
  desiredLabels: Record<string, string>,
  instanceType: string,
  machineConfig: MachineConfig,
  readPoolConfig: ReadPoolConfig | undefined,
): alloydb.Instance => {
  const body: alloydb.Instance = {
    instanceType,
    displayName: news.displayName,
    labels: desiredLabels,
    machineConfig,
  };
  if (news.annotations !== undefined) {
    body.annotations = news.annotations;
  }
  if (news.availabilityType !== undefined) {
    body.availabilityType = news.availabilityType;
  }
  if (news.gceZone !== undefined) {
    body.gceZone = news.gceZone;
  }
  if (news.activationPolicy !== undefined) {
    body.activationPolicy = news.activationPolicy;
  }
  if (news.databaseFlags !== undefined) {
    body.databaseFlags = news.databaseFlags;
  }
  if (readPoolConfig !== undefined) {
    body.readPoolConfig = readPoolConfig;
  }
  if (news.queryInsightsConfig !== undefined) {
    body.queryInsightsConfig = news.queryInsightsConfig;
  }
  if (news.observabilityConfig !== undefined) {
    body.observabilityConfig = news.observabilityConfig;
  }
  if (news.clientConnectionConfig !== undefined) {
    body.clientConnectionConfig = news.clientConnectionConfig;
  }
  if (news.networkConfig !== undefined) {
    body.networkConfig = news.networkConfig;
  }
  if (news.pscInstanceConfig !== undefined) {
    body.pscInstanceConfig = news.pscInstanceConfig;
  }
  if (news.connectionPoolConfig !== undefined) {
    body.connectionPoolConfig = news.connectionPoolConfig;
  }
  if (news.dataApiAccess !== undefined) {
    body.dataApiAccess = news.dataApiAccess;
  }
  return body;
};

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: [
      "name",
      "instanceId",
      "clusterId",
      "clusterName",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.instanceId ?? output?.instanceId;
      const nextId = news.instanceId ?? previousId;
      const previousCluster = lastSegment(olds?.cluster ?? output?.clusterId);
      const nextCluster = lastSegment(news.cluster ?? previousCluster);
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const previousType = normalizeInstanceType(
        olds?.instanceType ?? output?.instanceType,
      );
      const nextType = normalizeInstanceType(
        news.instanceType ?? output?.instanceType,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousCluster.length > 0 &&
          nextCluster.length > 0 &&
          previousCluster !== nextCluster) ||
        previousLocation !== nextLocation ||
        previousType !== nextType;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousCluster === nextCluster &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (output?.name) {
        const existing = yield* getByName(output.name);
        if (existing === undefined) return undefined;
        const attrs = toAttrs(existing, env.project);
        return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
          ? attrs
          : Unowned(attrs);
      }
      const instanceId = yield* toId(id, olds?.instanceId, output?.instanceId);
      const ref = parseClusterRef(
        olds?.cluster ?? output?.clusterName ?? output?.clusterId ?? "",
        env.project,
        olds?.location ?? output?.location ?? env.region,
      );
      if (ref.clusterId.length === 0) return undefined;
      const name = resourceName(
        ref.project,
        ref.location,
        ref.clusterId,
        instanceId,
      );
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* alloydb.listProjectsLocationsClustersInstances
          .pages({
            parent: `projects/${env.project}/locations/-/clusters/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
            Stream.filter(
              (instance) =>
                !isPlaceholder(instance) &&
                Object.keys(instance.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
            ),
            Stream.map((instance) => toAttrs(instance, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = yield* toId(id, news.instanceId, output?.instanceId);
      const ref = parseClusterRef(
        news.cluster,
        env.project,
        news.location ?? output?.location ?? env.region,
      );
      if (ref.clusterId.length === 0) {
        return yield* new InstanceClusterMissing({
          message:
            "GCP.AlloyDB.Instance requires `cluster` (cluster id or full resource name)",
        });
      }
      const name = resourceName(
        ref.project,
        ref.location,
        ref.clusterId,
        instanceId,
      );
      const parent = clusterNameOf(ref.project, ref.location, ref.clusterId);
      const instanceType = normalizeInstanceType(news.instanceType);
      const machineConfig = desiredMachineConfig(news);
      const readPoolConfig = desiredReadPoolConfig(news, instanceType);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const body = toCreateBody(
          news,
          desiredLabels,
          instanceType,
          machineConfig,
          readPoolConfig,
        );
        yield* (
          instanceType === "SECONDARY"
            ? alloydb.createsecondaryProjectsLocationsClustersInstances({
                parent,
                instanceId,
                body,
              })
            : alloydb.createProjectsLocationsClustersInstances({
                parent,
                instanceId,
                body,
              })
        ).pipe(
          Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          Effect.tap((created) =>
            created === undefined ? Effect.void : waitForOperation(created),
          ),
          // AlloyDB intermittently fails the create operation with INTERNAL
          // ("an internal error has occurred") after a long provisioning wait;
          // the failed instance is removed, so the create is retried.
          Effect.retry({
            while: (error) =>
              error._tag === "GCP.OperationFailed" && error.code === 13,
            times: 2,
            schedule: Schedule.spaced("30 seconds"),
          }),
        );
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new InstanceNotResolved({ name });
      }

      if (!isAvailable(current.state) || current.reconciling === true) {
        current = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      // AlloyDB omits `displayName` from instance reads (as for clusters and
      // backups); compare against the last applied value instead.
      const observedDisplayName =
        current.displayName ?? output?.displayName ?? olds?.displayName;
      const displayNameChanged =
        (observedDisplayName ?? "") !== (news.displayName ?? "");
      const annotationsChanged =
        news.annotations !== undefined &&
        fingerprint(stringMapOf(current.annotations)) !==
          fingerprint(news.annotations);
      const machineChanged = specifiedChanged(
        news.machineConfig as Record<string, unknown> | undefined,
        current.machineConfig as Record<string, unknown> | undefined,
      );
      const availabilityChanged =
        news.availabilityType !== undefined &&
        (current.availabilityType ?? "") !== news.availabilityType;
      const zoneChanged =
        news.gceZone !== undefined && (current.gceZone ?? "") !== news.gceZone;
      const activationChanged =
        news.activationPolicy !== undefined &&
        (current.activationPolicy ?? "") !== news.activationPolicy;
      const flagsChanged =
        news.databaseFlags !== undefined &&
        fingerprint(stringMapOf(current.databaseFlags)) !==
          fingerprint(news.databaseFlags);
      const readPoolChanged =
        news.readPoolConfig !== undefined &&
        (current.readPoolConfig?.nodeCount ?? 0) !==
          (news.readPoolConfig.nodeCount ??
            current.readPoolConfig?.nodeCount ??
            0);
      const insightsChanged = specifiedChanged(
        news.queryInsightsConfig as Record<string, unknown> | undefined,
        current.queryInsightsConfig as Record<string, unknown> | undefined,
      );
      const observabilityChanged = specifiedChanged(
        news.observabilityConfig as Record<string, unknown> | undefined,
        current.observabilityConfig as Record<string, unknown> | undefined,
      );
      const clientChanged = specifiedChanged(
        news.clientConnectionConfig as Record<string, unknown> | undefined,
        current.clientConnectionConfig as Record<string, unknown> | undefined,
      );
      const networkChanged = specifiedChanged(
        news.networkConfig as Record<string, unknown> | undefined,
        current.networkConfig as Record<string, unknown> | undefined,
      );
      const pscChanged = specifiedChanged(
        news.pscInstanceConfig as Record<string, unknown> | undefined,
        current.pscInstanceConfig as Record<string, unknown> | undefined,
      );
      const poolChanged = specifiedChanged(
        news.connectionPoolConfig as Record<string, unknown> | undefined,
        current.connectionPoolConfig as Record<string, unknown> | undefined,
      );
      const dataApiChanged =
        news.dataApiAccess !== undefined &&
        (current.dataApiAccess ?? "") !== news.dataApiAccess;

      if (
        labelsChanged ||
        displayNameChanged ||
        annotationsChanged ||
        machineChanged ||
        availabilityChanged ||
        zoneChanged ||
        activationChanged ||
        flagsChanged ||
        readPoolChanged ||
        insightsChanged ||
        observabilityChanged ||
        clientChanged ||
        networkChanged ||
        pscChanged ||
        poolChanged ||
        dataApiChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "displayName" : undefined,
          annotationsChanged ? "annotations" : undefined,
          machineChanged ? "machineConfig" : undefined,
          availabilityChanged ? "availabilityType" : undefined,
          zoneChanged ? "gceZone" : undefined,
          activationChanged ? "activationPolicy" : undefined,
          flagsChanged ? "databaseFlags" : undefined,
          readPoolChanged ? "readPoolConfig" : undefined,
          insightsChanged ? "queryInsightsConfig" : undefined,
          observabilityChanged ? "observabilityConfig" : undefined,
          clientChanged ? "clientConnectionConfig" : undefined,
          networkChanged ? "networkConfig" : undefined,
          pscChanged ? "pscInstanceConfig" : undefined,
          poolChanged ? "connectionPoolConfig" : undefined,
          dataApiChanged ? "dataApiAccess" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* alloydb
          .patchProjectsLocationsClustersInstances({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              displayName: news.displayName,
              annotations: news.annotations,
              machineConfig,
              availabilityType: news.availabilityType,
              gceZone: news.gceZone,
              activationPolicy: news.activationPolicy,
              databaseFlags: news.databaseFlags,
              readPoolConfig,
              queryInsightsConfig: news.queryInsightsConfig,
              observabilityConfig: news.observabilityConfig,
              clientConnectionConfig: news.clientConnectionConfig,
              networkConfig: news.networkConfig,
              pscInstanceConfig: news.pscInstanceConfig,
              connectionPoolConfig: news.connectionPoolConfig,
              dataApiAccess: news.dataApiAccess,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 40,
              schedule: Schedule.spaced("15 seconds"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      return toAttrs(
        { ...current, displayName: current.displayName ?? news.displayName },
        env.project,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* alloydb
        .deleteProjectsLocationsClustersInstances({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 40,
            schedule: Schedule.spaced("15 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(output.name);
    }),
  });
