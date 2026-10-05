import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  configIdOf,
  configNameOf,
  DEFAULT_PARTITION_PROCESSING_UNITS,
  displayNameOf,
  instanceIdOf,
  instanceName,
  instancePartitionName,
  listAlchemyInstances,
  MAX_PARTITION_ID_LENGTH,
  parentOwned,
  parseResourceName,
  retryConcurrentChanges,
  toPhysicalId,
  waitForOperation,
} from "./operations.ts";

export type PartitionAutoscalingLimits = {
  /** Minimum nodes. Mutually exclusive with processing-unit limits. */
  minNodes?: number;
  /** Minimum processing units (multiples of 1000). */
  minProcessingUnits?: number;
  /** Maximum nodes. */
  maxNodes?: number;
  /** Maximum processing units (multiples of 1000). */
  maxProcessingUnits?: number;
};

export type PartitionAutoscalingTargets = {
  /** Target high-priority CPU percent (`10`–`90`). */
  highPriorityCpuUtilizationPercent?: number;
  /** Target total CPU percent (`10`–`90`). */
  totalCpuUtilizationPercent?: number;
  /** Target storage percent (`10`–`99`). */
  storageUtilizationPercent?: number;
};

export type PartitionAutoscalingConfig = {
  /** Min/max compute capacity. */
  autoscalingLimits?: PartitionAutoscalingLimits;
  /** CPU and storage targets. */
  autoscalingTargets?: PartitionAutoscalingTargets;
};

export type InstancesInstancePartitionProps = {
  /**
   * Parent instance id or full name
   * (`projects/{project}/instances/{instance}`). Immutable — changing
   * it replaces the partition.
   */
  instance: string;
  /**
   * Instance partition id (the `{partition}` segment of
   * `.../instancePartitions/{partition}`). If omitted, a unique name is
   * generated. Must match `^[a-z][-a-z0-9]*[a-z0-9]$` (2–64
   * characters). Immutable — changing it replaces the partition.
   */
  instancePartitionId?: string;
  /**
   * Instance configuration id (`regional-us-west1`) or full name.
   * Typically a different config than the parent instance. Immutable —
   * changing it replaces the partition.
   */
  config: string;
  /**
   * User-facing display name. Must be unique per project and 4–30
   * characters. Defaults to a truncated partition id.
   */
  displayName?: string;
  /**
   * Processing units. Mutually exclusive with `nodeCount`. Ignored when
   * autoscaling is enabled. Minimum is 1000 (1 node).
   * @default 1000
   */
  processingUnits?: number;
  /**
   * Node count. Mutually exclusive with `processingUnits`. Ignored when
   * autoscaling is enabled.
   */
  nodeCount?: number;
  /**
   * Autoscaling configuration. When set, `nodeCount` and
   * `processingUnits` become output-only.
   */
  autoscalingConfig?: PartitionAutoscalingConfig;
};

export type InstancesInstancePartition = Resource<
  "GCP.Spanner.InstancesInstancePartition",
  InstancesInstancePartitionProps,
  {
    /** Full resource name `.../instancePartitions/{partition}`. */
    name: string;
    /** Instance partition id (last path segment). */
    instancePartitionId: string;
    /** Parent instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Full instance config name. */
    config: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** Processing units currently allocated. */
    processingUnits: number | undefined;
    /** Nodes currently allocated. */
    nodeCount: number | undefined;
    /** Autoscaling configuration, if enabled. */
    autoscalingConfig: PartitionAutoscalingConfig | undefined;
    /** Current state (`CREATING`, `READY`). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Databases that reference this partition. */
    referencingDatabases: string[];
    /** Backups that reference this partition. */
    referencingBackups: string[];
  },
  never,
  Providers
>;

/**
 * A Cloud Spanner instance partition for geo-partitioned data placement.
 *
 * Instance partitions have no labels field. Alchemy treats a partition
 * as owned when its parent instance carries Alchemy labels, so `list` /
 * `pnpm nuke:gcp` can find it. Geo-partitioning requires Enterprise Plus
 * and typically a dual-region or multi-region parent instance. Changing
 * `instancePartitionId`, `instance`, or `config` replaces the partition.
 * Display name, compute capacity, and autoscaling update in place.
 *
 * ### Creating an Instance Partition
 * **Example:** 1000 processing units in a second region
 * ```typescript
 * const partition = yield* GCP.Spanner.InstancesInstancePartition(
 *   "West",
 *   {
 *     instance: instance.instanceId,
 *     config: "regional-us-west1",
 *     processingUnits: 1000,
 *   },
 * );
 * ```
 *
 * **Example:** Explicit id and node count
 * ```typescript
 * const partition = yield* GCP.Spanner.InstancesInstancePartition(
 *   "West",
 *   {
 *     instance: instance.name,
 *     instancePartitionId: "west",
 *     config: "regional-us-west1",
 *     displayName: "west-partition",
 *     nodeCount: 1,
 *   },
 * );
 * ```
 *
 * @resource
 * @category Spanner
 */
export const InstancesInstancePartition = Resource<InstancesInstancePartition>(
  "GCP.Spanner.InstancesInstancePartition",
);

export class InstancePartitionNotResolved extends Data.TaggedError(
  "GCP.Spanner.InstancePartitionNotResolved",
)<{
  name: string;
}> {}

export class InstancePartitionNotReady extends Data.TaggedError(
  "GCP.Spanner.InstancePartitionNotReady",
)<{
  name: string;
  state: string;
}> {}

export class InstancePartitionStillExists extends Data.TaggedError(
  "GCP.Spanner.InstancePartitionStillExists",
)<{
  name: string;
}> {}

const toId = (
  id: string,
  instancePartitionId: string | undefined,
  existing?: string,
) => toPhysicalId(id, instancePartitionId, existing, MAX_PARTITION_ID_LENGTH);

const autoscalingOf = (
  config: spanner.AutoscalingConfig | undefined,
): PartitionAutoscalingConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    autoscalingLimits: config.autoscalingLimits
      ? {
          minNodes: config.autoscalingLimits.minNodes,
          minProcessingUnits: config.autoscalingLimits.minProcessingUnits,
          maxNodes: config.autoscalingLimits.maxNodes,
          maxProcessingUnits: config.autoscalingLimits.maxProcessingUnits,
        }
      : undefined,
    autoscalingTargets: config.autoscalingTargets
      ? {
          highPriorityCpuUtilizationPercent:
            config.autoscalingTargets.highPriorityCpuUtilizationPercent,
          totalCpuUtilizationPercent:
            config.autoscalingTargets.totalCpuUtilizationPercent,
          storageUtilizationPercent:
            config.autoscalingTargets.storageUtilizationPercent,
        }
      : undefined,
  };
};

const autoscalingKey = (config: PartitionAutoscalingConfig | undefined) =>
  JSON.stringify(config ?? null);

const toAttrs = (
  partition: spanner.InstancePartition,
  project: string,
): InstancesInstancePartition["Attributes"] => {
  const name = partition.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    instancePartitionId: parsed.instancePartitionId,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    config: partition.config ?? "",
    displayName: partition.displayName,
    processingUnits: partition.processingUnits,
    nodeCount: partition.nodeCount,
    autoscalingConfig: autoscalingOf(partition.autoscalingConfig),
    state: partition.state,
    createTime: partition.createTime,
    updateTime: partition.updateTime,
    referencingDatabases: partition.referencingDatabases ?? [],
    referencingBackups: partition.referencingBackups ?? [],
  };
};

const getByName = (name: string) =>
  spanner
    .getProjectsInstancesInstancePartitions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((partition) =>
      partition
        ? Effect.succeed(partition)
        : Effect.fail(new InstancePartitionNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Spanner.InstancePartitionNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (partition): partition is spanner.InstancePartition =>
        partition !== undefined,
      () => new InstancePartitionNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (partition) => (partition.state ?? "STATE_UNSPECIFIED") === "READY",
      (partition) =>
        new InstancePartitionNotReady({
          name,
          state: partition.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Spanner.InstancePartitionNotReady" ||
        error._tag === "GCP.Spanner.InstancePartitionNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((partition) =>
      partition === undefined
        ? Effect.void
        : Effect.fail(new InstancePartitionStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Spanner.InstancePartitionStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const toCreatePartition = (
  name: string,
  news: InstancesInstancePartitionProps,
  project: string,
  region: string,
  displayName: string,
): spanner.InstancePartition => {
  const body: spanner.InstancePartition = {
    name,
    config: configNameOf(project, news.config, region),
    displayName,
  };
  if (news.autoscalingConfig !== undefined) {
    body.autoscalingConfig = news.autoscalingConfig;
  } else if (news.nodeCount !== undefined) {
    body.nodeCount = news.nodeCount;
  } else {
    body.processingUnits =
      news.processingUnits ?? DEFAULT_PARTITION_PROCESSING_UNITS;
  }
  return body;
};

export const InstancesInstancePartitionProvider = () =>
  Provider.succeed(InstancesInstancePartition, {
    stables: [
      "name",
      "instancePartitionId",
      "instanceId",
      "project",
      "config",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId =
        olds?.instancePartitionId ?? output?.instancePartitionId;
      const nextId = news.instancePartitionId ?? previousId;
      const previousInstance = instanceIdOf(
        olds?.instance ?? output?.instanceId ?? "",
      );
      const nextInstance = instanceIdOf(news.instance);
      const previousConfig = configIdOf(
        olds?.config ?? output?.config,
        env.region,
      );
      const nextConfig = configIdOf(
        news.config ?? olds?.config ?? output?.config,
        env.region,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousInstance.length > 0 && previousInstance !== nextInstance) ||
        previousConfig !== nextConfig;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousConfig !== nextConfig ||
          (previousId !== undefined && nextId === previousId),
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instancePartitionId = yield* toId(
        id,
        olds?.instancePartitionId,
        output?.instancePartitionId,
      );
      const instanceId = instanceIdOf(
        olds?.instance ?? output?.instanceId ?? "",
      );
      if (instanceId.length === 0) return undefined;
      const name =
        output?.name ??
        instancePartitionName(env.project, instanceId, instancePartitionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* parentOwned(instanceName(attrs.project, attrs.instanceId)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = yield* listAlchemyInstances(env.project);
        const pages = yield* Effect.forEach(
          instances,
          (instance) => {
            const parent = instance.name;
            if (parent === undefined || parent.length === 0) {
              return Effect.succeed(
                [] as InstancesInstancePartition["Attributes"][],
              );
            }
            return spanner.listProjectsInstancesInstancePartitions
              .pages({
                parent,
                pageSize: 1000,
              })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.instancePartitions ?? []),
                ),
                Stream.map((partition) => toAttrs(partition, env.project)),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed(
                    [] as InstancesInstancePartition["Attributes"][],
                  ),
                ),
              );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = instanceIdOf(news.instance);
      const instancePartitionId = yield* toId(
        id,
        news.instancePartitionId,
        output?.instancePartitionId,
      );
      const name = instancePartitionName(
        env.project,
        instanceId,
        instancePartitionId,
      );
      const displayName = displayNameOf(instancePartitionId, news.displayName);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* spanner
          .createProjectsInstancesInstancePartitions({
            parent: instanceName(env.project, instanceId),
            body: {
              instancePartitionId,
              instancePartition: toCreatePartition(
                name,
                news,
                env.project,
                env.region,
                displayName,
              ),
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      if ((current.state ?? "") !== "READY") {
        current = yield* waitUntilReady(name);
      }

      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const autoscalingChanged =
        news.autoscalingConfig !== undefined &&
        autoscalingKey(autoscalingOf(current.autoscalingConfig)) !==
          autoscalingKey(news.autoscalingConfig);
      const processingUnitsChanged =
        news.autoscalingConfig === undefined &&
        news.nodeCount === undefined &&
        news.processingUnits !== undefined &&
        (current.processingUnits ?? 0) !== news.processingUnits;
      const nodeCountChanged =
        news.autoscalingConfig === undefined &&
        news.nodeCount !== undefined &&
        (current.nodeCount ?? 0) !== news.nodeCount;

      if (
        displayNameChanged ||
        autoscalingChanged ||
        processingUnitsChanged ||
        nodeCountChanged
      ) {
        const fieldMask = [
          displayNameChanged ? "display_name" : undefined,
          autoscalingChanged ? "autoscaling_config" : undefined,
          processingUnitsChanged ? "processing_units" : undefined,
          nodeCountChanged ? "node_count" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patchBody: spanner.InstancePartition = {
          name,
          displayName,
        };
        if (autoscalingChanged) {
          patchBody.autoscalingConfig = news.autoscalingConfig;
        }
        if (processingUnitsChanged) {
          patchBody.processingUnits = news.processingUnits;
        }
        if (nodeCountChanged) {
          patchBody.nodeCount = news.nodeCount;
        }

        const patched = yield* retryConcurrentChanges(
          spanner.patchProjectsInstancesInstancePartitions({
            name,
            body: {
              instancePartition: patchBody,
              fieldMask: fieldMask.join(","),
            },
          }),
        );
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* spanner
        .deleteProjectsInstancesInstancePartitions({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      yield* waitUntilGone(output.name);
    }),
  });
