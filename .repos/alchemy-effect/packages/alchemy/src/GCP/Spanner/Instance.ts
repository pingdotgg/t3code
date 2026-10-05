import * as spanner from "@distilled.cloud/gcp/spanner_v1";
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
import { waitForOperation } from "./operations.ts";

const DEFAULT_PROCESSING_UNITS = 100;
const DEFAULT_INSTANCE_TYPE = "PROVISIONED";
const DEFAULT_EDITION = "STANDARD";
const DEFAULT_BACKUP_SCHEDULE = "NONE";
const MAX_INSTANCE_ID_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 30;
const MIN_DISPLAY_NAME_LENGTH = 4;

export type InstanceType = spanner.InstanceInstanceTypeEnum | (string & {});
export type InstanceEdition = spanner.InstanceEditionEnum | (string & {});
export type InstanceDefaultBackupScheduleType =
  | spanner.InstanceDefaultBackupScheduleTypeEnum
  | (string & {});

export type AutoscalingLimits = {
  /** Minimum nodes. Mutually exclusive with processing-unit limits. */
  minNodes?: number;
  /** Minimum processing units (multiples of 1000). */
  minProcessingUnits?: number;
  /** Maximum nodes. */
  maxNodes?: number;
  /** Maximum processing units (multiples of 1000). */
  maxProcessingUnits?: number;
};

export type AutoscalingTargets = {
  /** Target high-priority CPU percent (`10`–`90`). */
  highPriorityCpuUtilizationPercent?: number;
  /** Target total CPU percent (`10`–`90`). */
  totalCpuUtilizationPercent?: number;
  /** Target storage percent (`10`–`99`). */
  storageUtilizationPercent?: number;
};

export type AutoscalingConfig = {
  /** Min/max compute capacity. */
  autoscalingLimits?: AutoscalingLimits;
  /** CPU and storage targets. */
  autoscalingTargets?: AutoscalingTargets;
};

export type ReplicaComputeCapacity = {
  /** Replica location (e.g. `us-central1`). */
  location?: string;
  /** Nodes allocated to this replica selection. */
  nodeCount?: number;
  /** Processing units allocated to this replica selection. */
  processingUnits?: number;
};

export type InstanceProps = {
  /**
   * Instance id (the `{instance}` segment of
   * `projects/{project}/instances/{instance}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Must match
   * `^[a-z][-a-z0-9]*[a-z0-9]$` (2–64 characters). Immutable — changing
   * it replaces the instance.
   */
  instanceId?: string;
  /**
   * Instance configuration id (`regional-us-central1`) or full name
   * (`projects/{project}/instanceConfigs/{config}`). Immutable —
   * changing it replaces the instance.
   * @default `regional-{region}` for the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  config?: string;
  /**
   * User-facing display name. Must be unique per project and 4–30
   * characters. Defaults to a truncated instance id.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Processing units. Mutually exclusive with `nodeCount`. Ignored when
   * autoscaling is enabled or `instanceType` is `FREE_INSTANCE`.
   * @default 100
   */
  processingUnits?: number;
  /**
   * Node count. Mutually exclusive with `processingUnits`. Ignored when
   * autoscaling is enabled or `instanceType` is `FREE_INSTANCE`.
   */
  nodeCount?: number;
  /**
   * Autoscaling configuration. When set, `nodeCount` and
   * `processingUnits` become output-only.
   */
  autoscalingConfig?: AutoscalingConfig;
  /**
   * Instance type. Immutable — changing it replaces the instance.
   * @default "PROVISIONED"
   */
  instanceType?: InstanceType;
  /**
   * Edition (`STANDARD`, `ENTERPRISE`, `ENTERPRISE_PLUS`).
   * @default "STANDARD"
   */
  edition?: InstanceEdition;
  /**
   * Default backup schedule for new databases. `NONE` skips automatic
   * schedules (required for free instances).
   * @default "NONE"
   */
  defaultBackupScheduleType?: InstanceDefaultBackupScheduleType;
};

export type Instance = Resource<
  "GCP.Spanner.Instance",
  InstanceProps,
  {
    /** Full resource name `projects/{project}/instances/{instance}`. */
    name: string;
    /** Instance id (last path segment). */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Full instance config name. */
    config: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Processing units currently allocated. */
    processingUnits: number | undefined;
    /** Nodes currently allocated. */
    nodeCount: number | undefined;
    /** Autoscaling configuration, if enabled. */
    autoscalingConfig: AutoscalingConfig | undefined;
    /** Compute capacity per replica selection. */
    replicaComputeCapacity: ReplicaComputeCapacity[];
    /** Instance type (`PROVISIONED`, `FREE_INSTANCE`). */
    instanceType: string | undefined;
    /** Edition (`STANDARD`, `ENTERPRISE`, `ENTERPRISE_PLUS`). */
    edition: string | undefined;
    /** Default backup schedule type. */
    defaultBackupScheduleType: string | undefined;
    /** Current instance state (`CREATING`, `READY`). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Spanner instance.
 *
 * Changing `instanceId`, `config`, or `instanceType` replaces the
 * instance. Display name, labels, compute capacity, edition, backup
 * schedule, and autoscaling update in place. Create, update, and delete
 * are long-running operations — a 100 processing-unit regional instance
 * typically takes one to two minutes.
 *
 * ### Creating an Instance
 * **Example:** Generated name, 100 processing units
 * ```typescript
 * const instance = yield* GCP.Spanner.Instance("App", {});
 * ```
 *
 * **Example:** Explicit id, config, and labels
 * ```typescript
 * const instance = yield* GCP.Spanner.Instance("App", {
 *   instanceId: "app-spanner",
 *   config: "regional-us-central1",
 *   displayName: "app-spanner",
 *   processingUnits: 100,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Observing Instances
 * **Example:** Read the bound instance
 * ```typescript
 * const getInstance = yield* GCP.Spanner.GetInstance(instance);
 * const live = yield* getInstance();
 * ```
 *
 * @resource
 * @category Spanner
 */
export const Instance = Resource<Instance>("GCP.Spanner.Instance");

export class InstanceNotResolved extends Data.TaggedError(
  "GCP.Spanner.InstanceNotResolved",
)<{
  name: string;
}> {}

export class InstanceNotReady extends Data.TaggedError(
  "GCP.Spanner.InstanceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class InstanceStillExists extends Data.TaggedError(
  "GCP.Spanner.InstanceStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeEnum = (value: string | undefined, fallback: string) => {
  const next = (value ?? fallback).toUpperCase();
  return next.endsWith("_UNSPECIFIED") ? fallback : next;
};

const normalizeInstanceType = (value: string | undefined) =>
  normalizeEnum(value, DEFAULT_INSTANCE_TYPE);

const normalizeEdition = (value: string | undefined) =>
  normalizeEnum(value, DEFAULT_EDITION);

const normalizeBackupSchedule = (value: string | undefined) =>
  normalizeEnum(value, DEFAULT_BACKUP_SCHEDULE);

const defaultConfigId = (region: string) => `regional-${region}`;

const configIdOf = (config: string | undefined, region: string) =>
  lastSegment(config ?? defaultConfigId(region)).toLowerCase();

const configNameOf = (
  project: string,
  config: string | undefined,
  region: string,
) => {
  const raw = (config ?? defaultConfigId(region)).trim();
  if (raw.includes("/")) return raw;
  return `projects/${project}/instanceConfigs/${raw}`;
};

const resourceName = (project: string, instanceId: string) =>
  `projects/${project}/instances/${instanceId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const instancesAt = parts.lastIndexOf("instances");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    instanceId:
      instancesAt >= 0 && parts[instancesAt + 1]
        ? parts[instancesAt + 1]!
        : lastSegment(name),
  };
};

const toSpannerId = (name: string) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  next = next.replace(/^-+/, "").replace(/-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `s${next}`;
  next = next.slice(0, MAX_INSTANCE_ID_LENGTH).replace(/-+$/g, "");
  if (next.length < 2) next = `${next}xx`.slice(0, MAX_INSTANCE_ID_LENGTH);
  return next;
};

const toId = (id: string, instanceId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (instanceId !== undefined) return instanceId;
    if (existing !== undefined) return existing;
    return toSpannerId(
      yield* createPhysicalName({
        id,
        maxLength: MAX_INSTANCE_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

const displayNameOf = (instanceId: string, displayName?: string) => {
  const source = (displayName ?? instanceId).trim();
  let next = source.slice(0, MAX_DISPLAY_NAME_LENGTH);
  if (next.length < MIN_DISPLAY_NAME_LENGTH) {
    next = `${next}inst`.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }
  return next;
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const autoscalingOf = (
  config: spanner.AutoscalingConfig | undefined,
): AutoscalingConfig | undefined => {
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

const replicaCapacityOf = (
  items: spanner.ReplicaComputeCapacityList | undefined,
): ReplicaComputeCapacity[] =>
  (items ?? []).map((item) => ({
    location: item.replicaSelection?.location,
    nodeCount: item.nodeCount,
    processingUnits: item.processingUnits,
  }));

const autoscalingKey = (config: AutoscalingConfig | undefined) =>
  JSON.stringify(config ?? null);

const toAttrs = (
  instance: spanner.Instance,
  project: string,
): Instance["Attributes"] => {
  const name = instance.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    config: instance.config ?? "",
    displayName: instance.displayName,
    labels: userLabels(instance.labels),
    processingUnits: instance.processingUnits,
    nodeCount: instance.nodeCount,
    autoscalingConfig: autoscalingOf(instance.autoscalingConfig),
    replicaComputeCapacity: replicaCapacityOf(instance.replicaComputeCapacity),
    instanceType: instance.instanceType,
    edition: instance.edition,
    defaultBackupScheduleType: instance.defaultBackupScheduleType,
    state: instance.state,
    createTime: instance.createTime,
    updateTime: instance.updateTime,
  };
};

const getByName = (name: string) =>
  spanner
    .getProjectsInstances({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(new InstanceNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Spanner.InstanceNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (instance): instance is spanner.Instance => instance !== undefined,
      () => new InstanceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (instance) => (instance.state ?? "STATE_UNSPECIFIED") === "READY",
      (instance) =>
        new InstanceNotReady({
          name,
          state: instance.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Spanner.InstanceNotReady" ||
        error._tag === "GCP.Spanner.InstanceNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
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
      while: (error) => error._tag === "GCP.Spanner.InstanceStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const retryConcurrentChanges = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const toCreateInstance = (
  name: string,
  news: InstanceProps,
  project: string,
  region: string,
  desiredLabels: Record<string, string>,
  instanceType: string,
  displayName: string,
): spanner.Instance => {
  const free = instanceType === "FREE_INSTANCE";
  const autoscaling = news.autoscalingConfig;
  const body: spanner.Instance = {
    name,
    config: configNameOf(project, news.config, region),
    displayName,
    labels: desiredLabels,
    instanceType,
  };
  if (!free) {
    body.edition = news.edition
      ? normalizeEdition(news.edition)
      : DEFAULT_EDITION;
    body.defaultBackupScheduleType = news.defaultBackupScheduleType
      ? normalizeBackupSchedule(news.defaultBackupScheduleType)
      : DEFAULT_BACKUP_SCHEDULE;
  }
  if (autoscaling !== undefined) {
    body.autoscalingConfig = autoscaling;
  } else if (!free) {
    if (news.nodeCount !== undefined) {
      body.nodeCount = news.nodeCount;
    } else {
      body.processingUnits = news.processingUnits ?? DEFAULT_PROCESSING_UNITS;
    }
  }
  return body;
};

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["name", "instanceId", "project", "config", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.instanceId ?? output?.instanceId;
      const nextId = news.instanceId ?? previousId;
      const previousConfig = configIdOf(
        olds?.config ?? output?.config,
        env.region,
      );
      const nextConfig = configIdOf(news.config ?? output?.config, env.region);
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
        previousConfig !== nextConfig ||
        previousType !== nextType;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousConfig !== nextConfig ||
          previousType !== nextType ||
          (previousId !== undefined && nextId === previousId),
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = yield* toId(id, olds?.instanceId, output?.instanceId);
      const name = output?.name ?? resourceName(env.project, instanceId);
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
        return yield* spanner.listProjectsInstances
          .pages({
            parent: `projects/${env.project}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
            Stream.filter((instance) =>
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

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = yield* toId(id, news.instanceId, output?.instanceId);
      const name = resourceName(env.project, instanceId);
      const instanceType = normalizeInstanceType(news.instanceType);
      const displayName = displayNameOf(instanceId, news.displayName);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* spanner
          .createProjectsInstances({
            parent: `projects/${env.project}`,
            body: {
              instanceId,
              instance: toCreateInstance(
                name,
                news,
                env.project,
                env.region,
                desiredLabels,
                instanceType,
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

      if (current === undefined) {
        return yield* new InstanceNotResolved({ name });
      }

      if ((current.state ?? "") !== "READY") {
        current = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const editionChanged =
        news.edition !== undefined &&
        normalizeEdition(current.edition) !== normalizeEdition(news.edition);
      const backupChanged =
        news.defaultBackupScheduleType !== undefined &&
        normalizeBackupSchedule(current.defaultBackupScheduleType) !==
          normalizeBackupSchedule(news.defaultBackupScheduleType);
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
        labelsChanged ||
        displayNameChanged ||
        editionChanged ||
        backupChanged ||
        autoscalingChanged ||
        processingUnitsChanged ||
        nodeCountChanged
      ) {
        const fieldMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "display_name" : undefined,
          editionChanged ? "edition" : undefined,
          backupChanged ? "default_backup_schedule_type" : undefined,
          autoscalingChanged ? "autoscaling_config" : undefined,
          processingUnitsChanged ? "processing_units" : undefined,
          nodeCountChanged ? "node_count" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patchBody: spanner.Instance = {
          name,
          labels: desiredLabels,
          displayName,
        };
        if (editionChanged && news.edition !== undefined) {
          patchBody.edition = normalizeEdition(news.edition);
        }
        if (backupChanged && news.defaultBackupScheduleType !== undefined) {
          patchBody.defaultBackupScheduleType = normalizeBackupSchedule(
            news.defaultBackupScheduleType,
          );
        }
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
          spanner.patchProjectsInstances({
            name,
            body: {
              instance: patchBody,
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
      yield* spanner.deleteProjectsInstances({ name: output.name }).pipe(
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
