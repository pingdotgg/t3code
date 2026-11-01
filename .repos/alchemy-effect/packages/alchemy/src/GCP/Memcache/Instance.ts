import * as memcache from "@distilled.cloud/gcp/memcache_v1";
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
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_NODE_COUNT = 1;
const DEFAULT_CPU_COUNT = 1;
const DEFAULT_MEMORY_SIZE_MB = 1024;
const MAX_NAME_LENGTH = 40;

export type TimeOfDay = {
  /** Hours of day in 24-hour format (`0`–`23`). */
  hours?: number;
  /** Minutes of hour (`0`–`59`). */
  minutes?: number;
  /** Seconds of minute (`0`–`59`). */
  seconds?: number;
  /** Fractional seconds, in nanoseconds. */
  nanos?: number;
};

export type WeeklyMaintenanceWindow = {
  /** Day of week that maintenance occurs (`MONDAY` … `SUNDAY`). */
  day?: memcache.WeeklyMaintenanceWindowDayEnum | (string & {});
  /** Start time of the window in UTC. */
  startTime?: TimeOfDay;
  /** Window length as a duration string (e.g. `"10800s"` for 3 hours). */
  duration?: string;
};

export type MaintenancePolicy = {
  /** Description of the policy. Max 512 characters. */
  description?: string;
  /** Weekly windows. Current API maximum is one window. */
  weeklyMaintenanceWindow?: WeeklyMaintenanceWindow[];
};

export type NodeConfig = {
  /**
   * vCPUs per Memcached node.
   * @default 1
   */
  cpuCount?: number;
  /**
   * Memory per node in MiB.
   * @default 1024
   */
  memorySizeMb?: number;
};

export type InstanceProps = {
  /**
   * Instance id (the `{instance}` segment of
   * `projects/{project}/locations/{location}/instances/{instance}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must match `^[a-z][a-z0-9-]{0,38}[a-z0-9]$` (1-40
   * characters). Immutable — changing it replaces the instance.
   */
  instanceId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the instance. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name. Max 80 characters.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * VPC network
   * (`projects/{project}/global/networks/{network}`). Immutable. Defaults
   * to the project `default` network.
   */
  authorizedNetwork?: string;
  /**
   * Zones to place nodes in. Nodes are spread evenly. Immutable. If
   * omitted, Memorystore uses every zone in the region.
   */
  zones?: string[];
  /**
   * Number of Memcached nodes.
   * @default 1
   */
  nodeCount?: number;
  /**
   * Per-node CPU and memory. Immutable — changing it replaces the
   * instance.
   */
  nodeConfig?: NodeConfig;
  /**
   * Memcached software version (`MEMCACHE_1_5`, `MEMCACHE_1_6_15`).
   * Upgrading uses `instances.upgrade`; downgrading replaces the instance.
   */
  memcacheVersion?: memcache.InstanceMemcacheVersionEnum | (string & {});
  /**
   * User-defined memcached process parameters (`max_item_size`, …).
   * Staged with `updateParameters` and applied with `applyParameters`.
   */
  parameters?: Record<string, string>;
  /**
   * Maintenance policy. If omitted, Memorystore may perform maintenance
   * at any time.
   */
  maintenancePolicy?: MaintenancePolicy;
  /**
   * Allocated private-service-access range ids (e.g. `"default"`).
   * Immutable.
   */
  reservedIpRangeId?: string[];
  /**
   * Self-service maintenance version (e.g. `"20210712_00_00"`).
   */
  maintenanceVersion?: string;
};

export type Instance = Resource<
  "GCP.Memcache.Instance",
  InstanceProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/instances/{instance}`. */
    name: string;
    /** Instance id (last path segment). */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Authorized VPC network. */
    authorizedNetwork: string | undefined;
    /** Zones nodes were provisioned in. */
    zones: string[];
    /** Number of Memcached nodes. */
    nodeCount: number;
    /** Per-node CPU and memory currently applied. */
    nodeConfig: NodeConfig;
    /** Memcached software version. */
    memcacheVersion: string | undefined;
    /** Full memcached version string (e.g. `memcached-1.5.16`). */
    memcacheFullVersion: string | undefined;
    /** User-defined memcached process parameters currently staged. */
    parameters: Record<string, string>;
    /** Server-assigned parameter-set id. */
    parameterId: string | undefined;
    /** Per-node info. */
    memcacheNodes: memcache.Node[];
    /** Server-reported state (`READY`, `CREATING`, …). */
    state: string | undefined;
    /** Discovery API endpoint. */
    discoveryEndpoint: string | undefined;
    /** Allocated private-service-access range ids. */
    reservedIpRangeId: string[];
    /** Self-service maintenance version. */
    maintenanceVersion: string | undefined;
    /** Effective maintenance version. */
    effectiveMaintenanceVersion: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Memorystore for Memcached instance.
 *
 * Changing `instanceId`, `location`, `authorizedNetwork`, `zones`,
 * `nodeConfig`, or `reservedIpRangeId` replaces the instance. Memcached
 * version upgrades use `instances.upgrade`; a downgrade replaces the
 * instance.
 *
 * Provisioning typically takes several minutes.
 *
 * ### Creating an Instance
 * **Example:** Generated name, 1 node
 * ```typescript
 * const cache = yield* GCP.Memcache.Instance("Cache", {
 *   nodeCount: 1,
 *   nodeConfig: { cpuCount: 1, memorySizeMb: 1024 },
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and display name
 * ```typescript
 * const cache = yield* GCP.Memcache.Instance("Cache", {
 *   instanceId: "app-memcache",
 *   location: "us-central1",
 *   displayName: "app cache",
 *   labels: { env: "prod" },
 *   nodeCount: 1,
 *   nodeConfig: { cpuCount: 1, memorySizeMb: 1024 },
 * });
 * ```
 *
 * ### Scaling Nodes
 * **Example:** Increase node count in place
 * ```typescript
 * const cache = yield* GCP.Memcache.Instance("Cache", {
 *   nodeCount: 2,
 *   nodeConfig: { cpuCount: 1, memorySizeMb: 1024 },
 * });
 * ```
 *
 * @resource
 * @category Memcache
 */
export const Instance = Resource<Instance>("GCP.Memcache.Instance");

export class InstanceNotResolved extends Data.TaggedError(
  "GCP.Memcache.InstanceNotResolved",
)<{
  name: string;
}> {}

export class InstanceNotReady extends Data.TaggedError(
  "GCP.Memcache.InstanceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class InstanceStillExists extends Data.TaggedError(
  "GCP.Memcache.InstanceStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `m${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "instance";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const resourceName = (project: string, location: string, instanceId: string) =>
  `projects/${project}/locations/${location}/instances/${instanceId}`;

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const instancesAt = parts.lastIndexOf("instances");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    instanceId:
      instancesAt >= 0 && parts[instancesAt + 1]
        ? parts[instancesAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

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

const paramsOf = (
  params: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(params ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const paramsKey = (
  params: Record<string, string | undefined> | null | undefined,
) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(paramsOf(params)).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

const listKey = (values: readonly string[] | undefined) =>
  JSON.stringify(
    [...(values ?? [])].map((value) => value.toLowerCase()).sort(),
  );

const nodeConfigOf = (config: NodeConfig | undefined): NodeConfig => ({
  cpuCount: config?.cpuCount ?? DEFAULT_CPU_COUNT,
  memorySizeMb: config?.memorySizeMb ?? DEFAULT_MEMORY_SIZE_MB,
});

const nodeConfigKey = (config: NodeConfig | undefined) => {
  const value = nodeConfigOf(config);
  return JSON.stringify({
    cpuCount: value.cpuCount,
    memorySizeMb: value.memorySizeMb,
  });
};

const windowKey = (window: WeeklyMaintenanceWindow) =>
  JSON.stringify({
    day: (window.day ?? "").toUpperCase(),
    hours: window.startTime?.hours ?? 0,
    minutes: window.startTime?.minutes ?? 0,
    seconds: window.startTime?.seconds ?? 0,
    nanos: window.startTime?.nanos ?? 0,
    duration: window.duration ?? "",
  });

const maintenanceOf = (
  policy:
    | memcache.GoogleCloudMemcacheV1MaintenancePolicy
    | MaintenancePolicy
    | undefined,
): MaintenancePolicy | undefined => {
  if (policy === undefined) return undefined;
  return {
    description: policy.description,
    weeklyMaintenanceWindow: policy.weeklyMaintenanceWindow,
  };
};

const maintenanceKey = (policy: MaintenancePolicy | undefined) =>
  JSON.stringify({
    description: policy?.description ?? "",
    windows: (policy?.weeklyMaintenanceWindow ?? []).map(windowKey),
  });

const parseMemcacheVersion = (version: string | undefined) => {
  if (version === undefined) return undefined;
  const match = version
    .toUpperCase()
    .match(/^MEMCACHE_(\d+)_(\d+)(?:_(\d+))?$/);
  if (!match) return undefined;
  return (
    Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3] ?? 0)
  );
};

const versionDecreasing = (previous: string | undefined, next: string) => {
  const oldN = parseMemcacheVersion(previous);
  const newN = parseMemcacheVersion(next);
  if (oldN === undefined || newN === undefined) return previous !== next;
  return newN < oldN;
};

const toAttrs = (
  instance: memcache.Instance,
  project: string,
  region: string,
) => {
  const name = instance.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    location: parsed.location,
    displayName: instance.displayName,
    labels: userLabels(instance.labels),
    authorizedNetwork: instance.authorizedNetwork,
    zones: instance.zones ?? [],
    nodeCount: instance.nodeCount ?? DEFAULT_NODE_COUNT,
    nodeConfig: nodeConfigOf(instance.nodeConfig),
    memcacheVersion: instance.memcacheVersion,
    memcacheFullVersion: instance.memcacheFullVersion,
    parameters: paramsOf(instance.parameters?.params),
    parameterId: instance.parameters?.id,
    memcacheNodes: instance.memcacheNodes ?? [],
    state: instance.state,
    discoveryEndpoint: instance.discoveryEndpoint,
    reservedIpRangeId: instance.reservedIpRangeId ?? [],
    maintenanceVersion: instance.maintenanceVersion,
    effectiveMaintenanceVersion: instance.effectiveMaintenanceVersion,
    createTime: instance.createTime,
    updateTime: instance.updateTime,
  };
};

const isPlaceholder = (instance: memcache.Instance) => {
  const name = instance.name ?? "";
  return name.endsWith("/instances/-") || name.endsWith("/instances/");
};

const getByName = (name: string) =>
  memcache
    .getProjectsLocationsInstances({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Wait for a Memorystore for Memcached operation; instance create,
 * resize, and upgrade take 10–20 minutes. With `notFoundOk`, NOT_FOUND
 * (code 5) and an operation that is already gone count as success
 * (delete race).
 */
const waitForOperation = (
  operation: memcache.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) => memcache.getProjectsLocationsOperations({ name }),
    { budget: "30 minutes", interval: "10 seconds" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        options?.notFoundOk === true &&
        (error._tag === "NotFound" ||
          (error._tag === "GCP.OperationFailed" && error.code === 5)),
      () => Effect.succeed(operation),
    ),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(new InstanceNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Memcache.InstanceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (instance): instance is memcache.Instance => instance !== undefined,
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
        error._tag === "GCP.Memcache.InstanceNotReady" ||
        error._tag === "GCP.Memcache.InstanceNotResolved",
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
      while: (error) => error._tag === "GCP.Memcache.InstanceStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const toCreateBody = (
  news: InstanceProps,
  desiredLabels: Record<string, string>,
  nodeCount: number,
  nodeConfig: NodeConfig,
): memcache.Instance => ({
  displayName: news.displayName,
  labels: desiredLabels,
  authorizedNetwork: news.authorizedNetwork,
  zones: news.zones,
  nodeCount,
  nodeConfig,
  memcacheVersion: news.memcacheVersion,
  parameters:
    news.parameters === undefined ? undefined : { params: news.parameters },
  maintenancePolicy: news.maintenancePolicy,
  reservedIpRangeId: news.reservedIpRangeId,
});

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["name", "instanceId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.instanceId ?? output?.instanceId;
      const nextId = news.instanceId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousNetwork =
        olds?.authorizedNetwork ?? output?.authorizedNetwork ?? "";
      const nextNetwork = news.authorizedNetwork ?? previousNetwork;
      const previousZones = listKey(olds?.zones ?? output?.zones);
      const nextZones =
        news.zones !== undefined ? listKey(news.zones) : previousZones;
      const previousNodeConfig = nodeConfigKey(
        olds?.nodeConfig ?? output?.nodeConfig,
      );
      const nextNodeConfig = nodeConfigKey(
        news.nodeConfig ?? output?.nodeConfig,
      );
      const previousRanges = listKey(
        olds?.reservedIpRangeId ?? output?.reservedIpRangeId,
      );
      const nextRanges =
        news.reservedIpRangeId !== undefined
          ? listKey(news.reservedIpRangeId)
          : previousRanges;
      const previousVersion = olds?.memcacheVersion ?? output?.memcacheVersion;
      const nextVersion = news.memcacheVersion;
      const downgrade =
        nextVersion !== undefined &&
        previousVersion !== undefined &&
        versionDecreasing(previousVersion, nextVersion);

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousNetwork !== nextNetwork ||
        previousZones !== nextZones ||
        previousNodeConfig !== nextNodeConfig ||
        previousRanges !== nextRanges ||
        downgrade;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = yield* toId(id, olds?.instanceId, output?.instanceId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, instanceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* memcache.listProjectsLocationsInstances
          .pages({
            parent: `projects/${env.project}/locations/-`,
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
            Stream.map((instance) =>
              toAttrs(instance, env.project, env.region),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = yield* toId(id, news.instanceId, output?.instanceId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, instanceId);
      const nodeCount = news.nodeCount ?? DEFAULT_NODE_COUNT;
      const nodeConfig = nodeConfigOf(news.nodeConfig);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* memcache
          .createProjectsLocationsInstances({
            parent: `projects/${env.project}/locations/${location}`,
            instanceId,
            body: toCreateBody(news, desiredLabels, nodeCount, nodeConfig),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new InstanceNotResolved({ name });
      }

      if ((current.state ?? "") !== "READY") {
        current = yield* waitUntilReady(name);
      }

      const desiredVersion = news.memcacheVersion;
      const currentVersion = current.memcacheVersion;
      if (
        desiredVersion !== undefined &&
        currentVersion !== undefined &&
        desiredVersion !== currentVersion &&
        !versionDecreasing(currentVersion, desiredVersion)
      ) {
        const upgraded = yield* memcache.upgradeProjectsLocationsInstances({
          name,
          body: { memcacheVersion: desiredVersion },
        });
        yield* waitForOperation(upgraded);
        current = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const desiredNodeCount = news.nodeCount ?? current.nodeCount ?? nodeCount;
      const nodeCountChanged =
        (current.nodeCount ?? DEFAULT_NODE_COUNT) !== desiredNodeCount;
      const maintenanceChanged =
        news.maintenancePolicy !== undefined &&
        maintenanceKey(maintenanceOf(current.maintenancePolicy)) !==
          maintenanceKey(news.maintenancePolicy);
      const maintenanceVersionChanged =
        news.maintenanceVersion !== undefined &&
        (current.maintenanceVersion ?? "") !== news.maintenanceVersion;

      if (
        labelsChanged ||
        displayNameChanged ||
        nodeCountChanged ||
        maintenanceChanged ||
        maintenanceVersionChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "displayName" : undefined,
          nodeCountChanged ? "nodeCount" : undefined,
          maintenanceChanged ? "maintenancePolicy" : undefined,
          maintenanceVersionChanged ? "maintenanceVersion" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* memcache.patchProjectsLocationsInstances({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            labels: desiredLabels,
            displayName: news.displayName,
            nodeCount: desiredNodeCount,
            maintenancePolicy: news.maintenancePolicy,
            maintenanceVersion: news.maintenanceVersion,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      const parametersChanged =
        news.parameters !== undefined &&
        paramsKey(current.parameters?.params) !== paramsKey(news.parameters);
      if (parametersChanged) {
        const updated =
          yield* memcache.updateParametersProjectsLocationsInstances({
            name,
            body: {
              updateMask: "parameters",
              parameters: { params: news.parameters },
            },
          });
        yield* waitForOperation(updated);
        const applied =
          yield* memcache.applyParametersProjectsLocationsInstances({
            name,
            body: { applyAll: true },
          });
        yield* waitForOperation(applied);
        current = yield* waitUntilReady(name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* memcache
        .deleteProjectsLocationsInstances({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
