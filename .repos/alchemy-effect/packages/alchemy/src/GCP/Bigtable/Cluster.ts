import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  clusterLocation,
  clusterName,
  DEFAULT_SERVE_NODES,
  DEFAULT_ZONE,
  lastSegment,
  listAlchemyInstances,
  MAX_CLUSTER_ID_LENGTH,
  MIN_CLUSTER_ID_LENGTH,
  parentOwned,
  parseResourceName,
  toPhysicalId,
  waitForOperation,
  zoneOf,
  collectPages,
} from "./operations.ts";

const DEFAULT_STORAGE_TYPE = "SSD";

export type AutoscalingLimits = {
  /** Minimum nodes the autoscaler can scale down to. */
  minServeNodes?: number;
  /** Maximum nodes the autoscaler can scale up to. */
  maxServeNodes?: number;
};

export type AutoscalingTargets = {
  /**
   * Target CPU utilization percent (`10`–`80`).
   */
  cpuUtilizationPercent?: number;
  /**
   * Target storage utilization in GiB per node. SSD default `2560`;
   * HDD default `8192`.
   */
  storageUtilizationGibPerNode?: number;
};

export type ClusterAutoscalingConfig = {
  /** Minimum and maximum node counts. */
  autoscalingLimits?: AutoscalingLimits;
  /** CPU and storage utilization targets. */
  autoscalingTargets?: AutoscalingTargets;
};

export type ClusterConfig = {
  /** Autoscaling configuration. Mutually exclusive with `serveNodes`. */
  clusterAutoscalingConfig?: ClusterAutoscalingConfig;
};

export type EncryptionConfig = {
  /**
   * Cloud KMS key
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   * Must be in the same region as the cluster. Immutable — changing it
   * replaces the cluster.
   */
  kmsKeyName?: string;
};

export type ClusterResourceProps = {
  /**
   * Parent instance id (the `{instance}` segment of
   * `projects/{project}/instances/{instance}`). Full resource names are
   * accepted and reduced to the last path segment. Immutable — changing
   * it replaces the cluster.
   */
  instance: string;
  /**
   * Cluster id (the `{cluster}` segment of
   * `projects/{project}/instances/{instance}/clusters/{cluster}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 6-30 characters and match
   * `[a-z][-a-z0-9]*`. Immutable — changing it replaces the cluster.
   */
  clusterId?: string;
  /**
   * Zone where nodes and storage reside (e.g. `us-central1-b`). Full
   * location names `projects/{project}/locations/{zone}` are accepted.
   * Immutable — changing it replaces the cluster.
   * @default "us-central1-b"
   */
  location?: string;
  /**
   * Storage type used by this cluster (`SSD` or `HDD`). Immutable —
   * changing it replaces the cluster.
   * @default "SSD"
   */
  defaultStorageType?: bigtable.ClusterDefaultStorageTypeEnum | (string & {});
  /**
   * Manual node count. Mutually exclusive with
   * `clusterConfig.clusterAutoscalingConfig`. Ignored while
   * autoscaling is enabled.
   * @default 1
   */
  serveNodes?: number;
  /**
   * Node scaling factor. Immutable — changing it replaces the cluster.
   */
  nodeScalingFactor?: bigtable.ClusterNodeScalingFactorEnum | (string & {});
  /**
   * Customer-managed encryption. Immutable — changing it replaces the
   * cluster.
   */
  encryptionConfig?: EncryptionConfig;
  /**
   * Cluster configuration. Set `clusterAutoscalingConfig` to enable
   * autoscaling (and omit `serveNodes`).
   */
  clusterConfig?: ClusterConfig;
};

export type Cluster = Resource<
  "GCP.Bigtable.Cluster",
  ClusterResourceProps,
  {
    /** Full resource name `projects/{project}/instances/{instance}/clusters/{cluster}`. */
    name: string;
    /** Cluster id (last path segment). */
    clusterId: string;
    /** Parent instance resource name. */
    instance: string;
    /** Parent instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Zone id (`us-central1-b`, …). */
    location: string;
    /** Storage type (`SSD`, `HDD`). */
    defaultStorageType: string | undefined;
    /** Current node count. */
    serveNodes: number | undefined;
    /** Node scaling factor. */
    nodeScalingFactor: string | undefined;
    /** CMEK configuration, if any. */
    encryptionConfig: EncryptionConfig | undefined;
    /** Cluster configuration currently applied. */
    clusterConfig: ClusterConfig | undefined;
    /** Server-reported state (`READY`, `CREATING`, `RESIZING`, …). */
    state: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Bigtable cluster — a resizable group of nodes in one zone
 * that serves every table in the parent instance.
 *
 * An instance always has at least one cluster (created with the
 * instance). Use this resource to add additional clusters or to manage
 * an existing cluster's node count and autoscaling. You cannot delete
 * the last cluster in an instance.
 *
 * Changing `clusterId`, `instance`, `location`, `defaultStorageType`,
 * `nodeScalingFactor`, or `encryptionConfig.kmsKeyName` replaces the
 * cluster. `serveNodes` and `clusterConfig.clusterAutoscalingConfig`
 * update in place.
 *
 * Clusters have no labels field. `list` enumerates clusters on
 * alchemy-labeled instances so `pnpm nuke:gcp` can find leaked rows.
 *
 * Provisioning typically takes several minutes.
 *
 * ### Creating a Cluster
 * **Example:** Additional cluster on an existing instance
 * ```typescript
 * const replica = yield* GCP.Bigtable.Cluster("Replica", {
 *   instance: instance.instanceId,
 *   location: "us-central1-b",
 *   serveNodes: 1,
 * });
 * ```
 *
 * **Example:** Explicit id and HDD storage
 * ```typescript
 * const replica = yield* GCP.Bigtable.Cluster("Replica", {
 *   instance: "app-instance",
 *   clusterId: "app-replica",
 *   location: "us-central1-c",
 *   defaultStorageType: "HDD",
 *   serveNodes: 1,
 * });
 * ```
 *
 * ### Autoscaling
 * **Example:** Autoscaling between 1 and 3 nodes
 * ```typescript
 * const replica = yield* GCP.Bigtable.Cluster("Replica", {
 *   instance: "app-instance",
 *   location: "us-central1-f",
 *   clusterConfig: {
 *     clusterAutoscalingConfig: {
 *       autoscalingLimits: { minServeNodes: 1, maxServeNodes: 3 },
 *       autoscalingTargets: { cpuUtilizationPercent: 50 },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Bigtable
 */
export const Cluster = Resource<Cluster>("GCP.Bigtable.Cluster");

export class ClusterNotResolved extends Data.TaggedError(
  "GCP.Bigtable.ClusterNotResolved",
)<{
  name: string;
}> {}

export class ClusterNotReady extends Data.TaggedError(
  "GCP.Bigtable.ClusterNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ClusterStillExists extends Data.TaggedError(
  "GCP.Bigtable.ClusterStillExists",
)<{
  name: string;
}> {}

const instanceIdOf = (value: string) => lastSegment(value);

const normalizeStorage = (storage: string | undefined) => {
  const value = (storage ?? DEFAULT_STORAGE_TYPE).toUpperCase();
  return value === "STORAGE_TYPE_UNSPECIFIED" ? DEFAULT_STORAGE_TYPE : value;
};

const normalizeScaling = (factor: string | undefined) =>
  (factor ?? "").toUpperCase();

const encryptionOf = (
  config: bigtable.EncryptionConfig | EncryptionConfig | undefined,
): EncryptionConfig | undefined => {
  const kmsKeyName = config?.kmsKeyName;
  if (kmsKeyName === undefined || kmsKeyName.length === 0) return undefined;
  return { kmsKeyName };
};

const encryptionKey = (
  config: bigtable.EncryptionConfig | EncryptionConfig | undefined,
) => encryptionOf(config)?.kmsKeyName ?? "";

const autoscalingOf = (
  config:
    | bigtable.ClusterAutoscalingConfig
    | ClusterAutoscalingConfig
    | undefined,
): ClusterAutoscalingConfig | undefined => {
  if (config === undefined) return undefined;
  const limits = config.autoscalingLimits;
  const targets = config.autoscalingTargets;
  if (limits === undefined && targets === undefined) return undefined;
  return {
    autoscalingLimits: limits
      ? {
          minServeNodes: limits.minServeNodes,
          maxServeNodes: limits.maxServeNodes,
        }
      : undefined,
    autoscalingTargets: targets
      ? {
          cpuUtilizationPercent: targets.cpuUtilizationPercent,
          storageUtilizationGibPerNode: targets.storageUtilizationGibPerNode,
        }
      : undefined,
  };
};

const clusterConfigOf = (
  config: bigtable.ClusterConfig | ClusterConfig | undefined,
): ClusterConfig | undefined => {
  const autoscaling = autoscalingOf(config?.clusterAutoscalingConfig);
  if (autoscaling === undefined) return undefined;
  return { clusterAutoscalingConfig: autoscaling };
};

const autoscalingKey = (
  config: bigtable.ClusterConfig | ClusterConfig | undefined,
) => {
  const autoscaling = clusterConfigOf(config)?.clusterAutoscalingConfig;
  return JSON.stringify({
    minServeNodes: autoscaling?.autoscalingLimits?.minServeNodes ?? null,
    maxServeNodes: autoscaling?.autoscalingLimits?.maxServeNodes ?? null,
    cpuUtilizationPercent:
      autoscaling?.autoscalingTargets?.cpuUtilizationPercent ?? null,
    storageUtilizationGibPerNode:
      autoscaling?.autoscalingTargets?.storageUtilizationGibPerNode ?? null,
  });
};

const toAttrs = (cluster: bigtable.Cluster, project: string) => {
  const name = cluster.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    clusterId: parsed.clusterId,
    instance: parsed.instance,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    location: zoneOf(cluster.location || DEFAULT_ZONE),
    defaultStorageType: cluster.defaultStorageType,
    serveNodes: cluster.serveNodes,
    nodeScalingFactor: cluster.nodeScalingFactor,
    encryptionConfig: encryptionOf(cluster.encryptionConfig),
    clusterConfig: clusterConfigOf(cluster.clusterConfig),
    state: cluster.state,
  };
};

const getByName = (name: string) =>
  bigtable
    .getProjectsInstancesClusters({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isBusy = (state: string | undefined) =>
  state === "CREATING" ||
  state === "RESIZING" ||
  state === "STATE_NOT_KNOWN" ||
  state === undefined;

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((cluster) =>
      cluster
        ? Effect.succeed(cluster)
        : Effect.fail(new ClusterNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.ClusterNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (cluster): cluster is bigtable.Cluster => cluster !== undefined,
      () => new ClusterNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (cluster) => !isBusy(cluster.state),
      (cluster) =>
        new ClusterNotReady({
          name,
          state: cluster.state ?? "STATE_NOT_KNOWN",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Bigtable.ClusterNotReady" ||
        error._tag === "GCP.Bigtable.ClusterNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((cluster) =>
      cluster === undefined
        ? Effect.void
        : Effect.fail(new ClusterStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.ClusterStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const toCreateBody = (
  news: ClusterResourceProps,
  project: string,
  zone: string,
  storage: string,
): bigtable.Cluster => {
  const autoscaling = clusterConfigOf(news.clusterConfig);
  return {
    location: clusterLocation(project, zone),
    defaultStorageType: storage,
    nodeScalingFactor: news.nodeScalingFactor,
    encryptionConfig: news.encryptionConfig,
    serveNodes:
      autoscaling === undefined
        ? (news.serveNodes ?? DEFAULT_SERVE_NODES)
        : undefined,
    clusterConfig: autoscaling,
  };
};

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: [
      "name",
      "clusterId",
      "instance",
      "instanceId",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.clusterId ?? output?.clusterId;
      const nextId = news.clusterId ?? previousId;
      const previousInstance = instanceIdOf(
        olds?.instance ?? output?.instance ?? output?.instanceId ?? "",
      );
      const nextInstance = instanceIdOf(news.instance);
      const previousZone = zoneOf(olds?.location ?? output?.location);
      const nextZone = zoneOf(news.location ?? output?.location);
      const previousStorage = normalizeStorage(
        olds?.defaultStorageType ?? output?.defaultStorageType,
      );
      const nextStorage = normalizeStorage(
        news.defaultStorageType ?? output?.defaultStorageType,
      );
      const previousScaling = normalizeScaling(
        olds?.nodeScalingFactor ?? output?.nodeScalingFactor,
      );
      const nextScaling = normalizeScaling(
        news.nodeScalingFactor ?? output?.nodeScalingFactor,
      );
      const previousCmek = encryptionKey(
        olds?.encryptionConfig ?? output?.encryptionConfig,
      );
      const nextCmek = encryptionKey(
        news.encryptionConfig ?? output?.encryptionConfig,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousInstance.length > 0 &&
          nextInstance.length > 0 &&
          previousInstance !== nextInstance) ||
        previousZone !== nextZone ||
        previousStorage !== nextStorage ||
        (previousScaling.length > 0 &&
          nextScaling.length > 0 &&
          previousScaling !== nextScaling) ||
        previousCmek !== nextCmek;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousInstance === nextInstance &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = instanceIdOf(
        olds?.instance ?? output?.instance ?? output?.instanceId ?? "",
      );
      if (instanceId.length === 0) return undefined;
      const clusterId = yield* toPhysicalId(
        id,
        olds?.clusterId,
        output?.clusterId,
        MAX_CLUSTER_ID_LENGTH,
        MIN_CLUSTER_ID_LENGTH,
      );
      const name =
        output?.name ?? clusterName(env.project, instanceId, clusterId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* parentOwned(attrs.instance)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = yield* listAlchemyInstances(env.project);
        const labeled = new Set(
          instances
            .map((instance) => instance.name ?? "")
            .filter((name) => name.length > 0),
        );
        if (labeled.size === 0) return [];
        const clusters = yield* collectPages(
          bigtable.listProjectsInstancesClusters.pages({
            parent: `projects/${env.project}/instances/-`,
          }),
          (page) => page.clusters,
        );
        return clusters
          .filter((cluster) =>
            labeled.has(parseResourceName(cluster.name ?? "").instance),
          )
          .map((cluster) => toAttrs(cluster, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = instanceIdOf(news.instance);
      const clusterId = yield* toPhysicalId(
        id,
        news.clusterId,
        output?.clusterId,
        MAX_CLUSTER_ID_LENGTH,
        MIN_CLUSTER_ID_LENGTH,
      );
      const zone = zoneOf(news.location ?? output?.location);
      const storage = normalizeStorage(news.defaultStorageType);
      const name = clusterName(env.project, instanceId, clusterId);
      const desiredAutoscaling = clusterConfigOf(news.clusterConfig);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bigtable
          .createProjectsInstancesClusters({
            parent: `projects/${env.project}/instances/${instanceId}`,
            clusterId,
            body: toCreateBody(news, env.project, zone, storage),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      if (isBusy(current.state)) {
        current = yield* waitUntilReady(name);
      }

      const observedAutoscaling = clusterConfigOf(current.clusterConfig);
      const autoscalingChanged =
        desiredAutoscaling !== undefined &&
        autoscalingKey(current.clusterConfig) !==
          autoscalingKey(news.clusterConfig);
      const disableAutoscaling =
        desiredAutoscaling === undefined &&
        news.serveNodes !== undefined &&
        observedAutoscaling !== undefined;
      const serveNodesChanged =
        desiredAutoscaling === undefined &&
        news.serveNodes !== undefined &&
        (current.serveNodes ?? DEFAULT_SERVE_NODES) !== news.serveNodes;

      if (autoscalingChanged) {
        const patched =
          yield* bigtable.partialUpdateClusterProjectsInstancesClusters({
            name,
            updateMask: "cluster_config.cluster_autoscaling_config",
            body: {
              name,
              clusterConfig: desiredAutoscaling,
            },
          });
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      } else if (disableAutoscaling || serveNodesChanged) {
        const serveNodes =
          news.serveNodes ?? current.serveNodes ?? DEFAULT_SERVE_NODES;
        if (disableAutoscaling) {
          const patched =
            yield* bigtable.partialUpdateClusterProjectsInstancesClusters({
              name,
              updateMask:
                "serve_nodes,cluster_config.cluster_autoscaling_config",
              body: {
                name,
                serveNodes,
                clusterConfig: {},
              },
            });
          yield* waitForOperation(patched);
        } else {
          const updated = yield* bigtable.updateProjectsInstancesClusters({
            name,
            body: {
              name,
              location: current.location ?? clusterLocation(env.project, zone),
              serveNodes,
              defaultStorageType: current.defaultStorageType ?? storage,
            },
          });
          yield* waitForOperation(updated);
        }
        current = yield* waitUntilReady(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const result = yield* bigtable
        .deleteProjectsInstancesClusters({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
          Effect.as("deleted" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("deleted" as const)),
          // The instance's last cluster goes away with the instance.
          Effect.catchTag("LastClusterDeletion", () =>
            Effect.succeed("kept" as const),
          ),
        );
      if (result === "deleted") {
        yield* waitUntilGone(output.name);
      }
    }),
  });
