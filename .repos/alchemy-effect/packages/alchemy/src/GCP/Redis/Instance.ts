import * as redis from "@distilled.cloud/gcp/redis_v1";
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
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

const DEFAULT_TIER = "BASIC";
const DEFAULT_CONNECT_MODE = "DIRECT_PEERING";
const DEFAULT_TRANSIT_ENCRYPTION = "DISABLED";
const DEFAULT_MEMORY_SIZE_GB = 1;

/**
 * Memorystore create, delete, and resize operations take minutes (a BASIC
 * 1 GiB create is ~4 minutes). Poll every 10s for up to 12 minutes.
 */
const LONG_POLL = { times: 72, schedule: Schedule.spaced("10 seconds") };
const MAX_NAME_LENGTH = 40;

export type RedisTimeOfDay = {
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
  day?: redis.WeeklyMaintenanceWindowDayEnum | (string & {});
  /** Start time of the window in UTC. */
  startTime?: RedisTimeOfDay;
};

export type MaintenancePolicy = {
  /** Description of the policy. Max 512 characters. */
  description?: string;
  /** Weekly windows. Current API maximum is one window. */
  weeklyMaintenanceWindow?: WeeklyMaintenanceWindow[];
};

export type PersistenceConfig = {
  /**
   * Persistence mode. `DISABLED` deletes existing snapshots; `RDB` enables
   * RDB snapshots.
   */
  persistenceMode?: redis.PersistenceConfigPersistenceModeEnum | (string & {});
  /**
   * Period between RDB snapshots (`ONE_HOUR`, `SIX_HOURS`, `TWELVE_HOURS`,
   * `TWENTY_FOUR_HOURS`).
   */
  rdbSnapshotPeriod?:
    | redis.PersistenceConfigRdbSnapshotPeriodEnum
    | (string & {});
  /**
   * Alignment timestamp for snapshots (RFC3339). If omitted, the current
   * time is used.
   */
  rdbSnapshotStartTime?: string;
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
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Zone to provision the primary node in (e.g. `us-central1-a`).
   * Immutable. If omitted, Memorystore picks a zone.
   */
  locationId?: string;
  /**
   * Additional zone for STANDARD_HA. Immutable. Must differ from
   * `locationId`.
   */
  alternativeLocationId?: string;
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Redis software version (`REDIS_7_0`, `REDIS_7_2`, …). Upgrading uses
   * `instances.upgrade`; downgrading replaces the instance.
   */
  redisVersion?: string;
  /**
   * Reserved IP CIDR (`DIRECT_PEERING`) or allocated range name
   * (`PRIVATE_SERVICE_ACCESS`). Immutable.
   */
  reservedIpRange?: string;
  /**
   * Extra IP range used when enabling read replicas (`auto` or a CIDR /
   * allocated range name).
   */
  secondaryIpRange?: string;
  /**
   * Redis config parameters (`maxmemory-policy`, `notify-keyspace-events`,
   * …). See Memorystore supported parameters.
   */
  redisConfigs?: Record<string, string>;
  /**
   * Service tier. Immutable — changing it replaces the instance.
   * @default "BASIC"
   */
  tier?: redis.InstanceTierEnum | (string & {});
  /**
   * Memory size in GiB.
   * @default 1
   */
  memorySizeGb?: number;
  /**
   * VPC network
   * (`projects/{project}/global/networks/{network}`). Immutable. Defaults
   * to the project `default` network.
   */
  authorizedNetwork?: string;
  /**
   * Network connect mode. Immutable.
   * @default "DIRECT_PEERING"
   */
  connectMode?: redis.InstanceConnectModeEnum | (string & {});
  /**
   * Enable OSS Redis AUTH.
   * @default false
   */
  authEnabled?: boolean;
  /**
   * In-transit TLS mode. Immutable.
   * @default "DISABLED"
   */
  transitEncryptionMode?:
    | redis.InstanceTransitEncryptionModeEnum
    | (string & {});
  /**
   * Maintenance policy. If omitted, Memorystore may perform maintenance
   * at any time.
   */
  maintenancePolicy?: MaintenancePolicy;
  /**
   * Replica count. BASIC is `0`. STANDARD_HA without read replicas is
   * `1`. STANDARD_HA with read replicas is `1`–`5`.
   */
  replicaCount?: number;
  /**
   * Read replica mode. Create-time only — changing it replaces the
   * instance.
   */
  readReplicasMode?: redis.InstanceReadReplicasModeEnum | (string & {});
  /**
   * Customer-managed KMS key for at-rest encryption
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`). Immutable.
   */
  customerManagedKey?: string;
  /**
   * RDB persistence configuration.
   */
  persistenceConfig?: PersistenceConfig;
  /**
   * Self-service maintenance version (e.g. `"20210712_00_00"`).
   */
  maintenanceVersion?: string;
};

export type Instance = Resource<
  "GCP.Redis.Instance",
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
    /** Provisioned primary zone. */
    locationId: string | undefined;
    /** Additional STANDARD_HA zone. */
    alternativeLocationId: string | undefined;
    /** Current primary zone (may change after failover). */
    currentLocationId: string | undefined;
    /** Redis software version. */
    redisVersion: string | undefined;
    /** Reserved IP CIDR or allocated range name. */
    reservedIpRange: string | undefined;
    /** Extra IP range for read replicas. */
    secondaryIpRange: string | undefined;
    /** Redis endpoint hostname or IP. */
    host: string | undefined;
    /** Redis endpoint port. */
    port: number | undefined;
    /** Server-reported state (`READY`, `CREATING`, …). */
    state: string | undefined;
    /** Extra status text, if any. */
    statusMessage: string | undefined;
    /** Redis config parameters currently applied. */
    redisConfigs: Record<string, string>;
    /** Service tier (`BASIC`, `STANDARD_HA`). */
    tier: string;
    /** Memory size in GiB. */
    memorySizeGb: number;
    /** Authorized VPC network. */
    authorizedNetwork: string | undefined;
    /** IAM identity used for import/export. */
    persistenceIamIdentity: string | undefined;
    /** Network connect mode. */
    connectMode: string | undefined;
    /** Whether OSS Redis AUTH is enabled. */
    authEnabled: boolean;
    /** In-transit TLS mode. */
    transitEncryptionMode: string | undefined;
    /** Replica count. */
    replicaCount: number | undefined;
    /** Per-node info. */
    nodes: redis.NodeInfo[];
    /** Read replica endpoint hostname (STANDARD_HA). */
    readEndpoint: string | undefined;
    /** Read replica endpoint port. */
    readEndpointPort: number | undefined;
    /** Read replica mode. */
    readReplicasMode: string | undefined;
    /** Customer-managed KMS key, if any. */
    customerManagedKey: string | undefined;
    /** Persistence configuration currently applied. */
    persistenceConfig: PersistenceConfig | undefined;
    /** Self-service maintenance version. */
    maintenanceVersion: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Memorystore for Redis instance.
 *
 * Changing `instanceId`, `location`, `tier`, `connectMode`,
 * `authorizedNetwork`, `reservedIpRange`, `locationId`,
 * `alternativeLocationId`, `transitEncryptionMode`, `customerManagedKey`,
 * or `readReplicasMode` replaces the instance. Redis version upgrades use
 * `instances.upgrade`; a downgrade replaces the instance.
 *
 * Provisioning typically takes several minutes.
 *
 * ### Creating an Instance
 * **Example:** Generated name, BASIC 1 GiB
 * ```typescript
 * const cache = yield* GCP.Redis.Instance("Cache", {});
 * ```
 *
 * **Example:** Explicit id, labels, and AUTH
 * ```typescript
 * const cache = yield* GCP.Redis.Instance("Cache", {
 *   instanceId: "app-cache",
 *   location: "us-central1",
 *   memorySizeGb: 1,
 *   authEnabled: true,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Binding from a Function
 * **Example:** ReadWriteRedis from a Function
 * ```typescript
 * export class Api extends GCP.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const cache = yield* GCP.Redis.Instance("Cache", { memorySizeGb: 1 });
 *     const redis = yield* GCP.Redis.ReadWriteRedis(cache);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* redis.set("k", "v").pipe(Effect.orDie);
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide([GCP.Redis.ReadWriteRedisHttp])),
 * ) {}
 * ```
 *
 * ### Destroying an Instance
 * **Example:** Delete waits out CREATING
 * ```typescript
 * const cache = yield* GCP.Redis.Instance("Cache", { memorySizeGb: 1 });
 * ```
 * `alchemy destroy` waits for `CREATING` to finish, then retries `Conflict` until the instance is gone.
 *
 * ### High Availability
 * **Example:** STANDARD_HA across two zones
 * ```typescript
 * const cache = yield* GCP.Redis.Instance("Cache", {
 *   tier: "STANDARD_HA",
 *   locationId: "us-central1-a",
 *   alternativeLocationId: "us-central1-f",
 *   memorySizeGb: 1,
 * });
 * ```
 *
 * @resource
 * @category Redis
 */
export const Instance = Resource<Instance>("GCP.Redis.Instance");

export class InstanceNotResolved extends Data.TaggedError(
  "GCP.Redis.InstanceNotResolved",
)<{
  name: string;
}> {}

export class InstanceNotReady extends Data.TaggedError(
  "GCP.Redis.InstanceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class InstanceOperationPending extends Data.TaggedError(
  "GCP.Redis.InstanceOperationPending",
)<{
  operation: string;
}> {}

export class InstanceStillExists extends Data.TaggedError(
  "GCP.Redis.InstanceStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const normalizeTier = (tier: string | undefined) => {
  const value = (tier ?? DEFAULT_TIER).toUpperCase();
  return value === "TIER_UNSPECIFIED" ? DEFAULT_TIER : value;
};

const normalizeConnectMode = (mode: string | undefined) => {
  const value = (mode ?? DEFAULT_CONNECT_MODE).toUpperCase();
  return value === "CONNECT_MODE_UNSPECIFIED" ? DEFAULT_CONNECT_MODE : value;
};

const normalizeTransit = (mode: string | undefined) => {
  const value = (mode ?? DEFAULT_TRANSIT_ENCRYPTION).toUpperCase();
  return value === "TRANSIT_ENCRYPTION_MODE_UNSPECIFIED"
    ? DEFAULT_TRANSIT_ENCRYPTION
    : value;
};

const normalizeReadReplicas = (mode: string | undefined) =>
  (mode ?? "READ_REPLICAS_DISABLED").toUpperCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `r${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "instance";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const resourceName = (project: string, location: string, instanceId: string) =>
  `projects/${project}/locations/${location}/instances/${instanceId}`;

const parseName = (name: string, fallbackLocation: string) => {
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
        : fallbackLocation,
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

const configsOf = (
  configs: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(configs ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const configsKey = (
  configs: Record<string, string | undefined> | null | undefined,
) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(configsOf(configs)).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

const persistenceOf = (
  config: redis.PersistenceConfig | PersistenceConfig | undefined,
): PersistenceConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    persistenceMode: config.persistenceMode,
    rdbSnapshotPeriod: config.rdbSnapshotPeriod,
    rdbSnapshotStartTime: config.rdbSnapshotStartTime,
  };
};

const persistenceKey = (
  config: redis.PersistenceConfig | PersistenceConfig | undefined,
) => {
  const value = persistenceOf(config);
  return JSON.stringify({
    persistenceMode: (value?.persistenceMode ?? "").toUpperCase(),
    rdbSnapshotPeriod: (value?.rdbSnapshotPeriod ?? "").toUpperCase(),
    rdbSnapshotStartTime: value?.rdbSnapshotStartTime ?? "",
  });
};

const windowKey = (window: WeeklyMaintenanceWindow) =>
  JSON.stringify({
    day: (window.day ?? "").toUpperCase(),
    hours: window.startTime?.hours ?? 0,
    minutes: window.startTime?.minutes ?? 0,
    seconds: window.startTime?.seconds ?? 0,
    nanos: window.startTime?.nanos ?? 0,
  });

const maintenanceKey = (policy: MaintenancePolicy | undefined) =>
  JSON.stringify({
    description: policy?.description ?? "",
    windows: (policy?.weeklyMaintenanceWindow ?? []).map(windowKey),
  });

const parseRedisVersion = (version: string | undefined) => {
  if (version === undefined) return undefined;
  const match = version.toUpperCase().match(/^REDIS_(\d+)_(\d+|X)$/);
  if (!match) return undefined;
  const minor = match[2] === "X" ? 99 : Number(match[2]);
  return Number(match[1]) * 100 + minor;
};

const versionDecreasing = (previous: string | undefined, next: string) => {
  const oldN = parseRedisVersion(previous);
  const newN = parseRedisVersion(next);
  if (oldN === undefined || newN === undefined) return previous !== next;
  return newN < oldN;
};

const toAttrs = (instance: redis.Instance, project: string, region: string) => {
  const name = instance.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    location: parsed.location,
    displayName: instance.displayName,
    labels: userLabels(instance.labels),
    locationId: instance.locationId,
    alternativeLocationId: instance.alternativeLocationId,
    currentLocationId: instance.currentLocationId,
    redisVersion: instance.redisVersion,
    reservedIpRange: instance.reservedIpRange,
    secondaryIpRange: instance.secondaryIpRange,
    host: instance.host,
    port: instance.port,
    state: instance.state,
    statusMessage: instance.statusMessage,
    redisConfigs: configsOf(instance.redisConfigs),
    tier: normalizeTier(instance.tier),
    memorySizeGb: instance.memorySizeGb ?? DEFAULT_MEMORY_SIZE_GB,
    authorizedNetwork: instance.authorizedNetwork,
    persistenceIamIdentity: instance.persistenceIamIdentity,
    connectMode: instance.connectMode,
    authEnabled: instance.authEnabled === true,
    transitEncryptionMode: instance.transitEncryptionMode,
    replicaCount: instance.replicaCount,
    nodes: instance.nodes ?? [],
    readEndpoint: instance.readEndpoint,
    readEndpointPort: instance.readEndpointPort,
    readReplicasMode: instance.readReplicasMode,
    customerManagedKey: instance.customerManagedKey,
    persistenceConfig: persistenceOf(instance.persistenceConfig),
    maintenanceVersion: instance.maintenanceVersion,
    createTime: instance.createTime,
  };
};

const isPlaceholder = (instance: redis.Instance) => {
  const name = instance.name ?? "";
  return name.endsWith("/instances/-") || name.endsWith("/instances/");
};

const getByName = (name: string) =>
  redis
    .getProjectsLocationsInstances({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/** Wait for an operation through the shared GCP waiter. */
const waitForOperation = (
  operation: redis.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      redis
        .getProjectsLocationsOperations({ name })
        .pipe(
          Effect.catchTag("NotFound", (error) =>
            options?.notFoundOk === true
              ? Effect.succeed<redis.Operation>({ name, done: true })
              : Effect.fail(error),
          ),
        ),
    { budget: "30 minutes" },
  ).pipe(
    // ALREADY_EXISTS (6): a concurrent create won the race. NOT_FOUND (5)
    // is success for a delete.
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
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
      while: (error) => error._tag === "GCP.Redis.InstanceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (instance): instance is redis.Instance => instance !== undefined,
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
        error._tag === "GCP.Redis.InstanceNotReady" ||
        error._tag === "GCP.Redis.InstanceNotResolved",
      ...LONG_POLL,
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
      while: (error) => error._tag === "GCP.Redis.InstanceStillExists",
      ...LONG_POLL,
    }),
  );

const toCreateBody = (
  news: InstanceProps,
  desiredLabels: Record<string, string>,
  tier: string,
  connectMode: string,
  transitEncryptionMode: string,
  memorySizeGb: number,
  authEnabled: boolean,
): redis.Instance => ({
  displayName: news.displayName,
  labels: desiredLabels,
  locationId: news.locationId,
  alternativeLocationId: news.alternativeLocationId,
  redisVersion: news.redisVersion,
  reservedIpRange: news.reservedIpRange,
  secondaryIpRange: news.secondaryIpRange,
  redisConfigs: news.redisConfigs,
  tier,
  memorySizeGb,
  authorizedNetwork: news.authorizedNetwork,
  connectMode,
  authEnabled,
  transitEncryptionMode,
  maintenancePolicy: news.maintenancePolicy,
  replicaCount: news.replicaCount,
  readReplicasMode: news.readReplicasMode,
  customerManagedKey: news.customerManagedKey,
  persistenceConfig: news.persistenceConfig,
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
      const previousTier = normalizeTier(olds?.tier ?? output?.tier);
      const nextTier = normalizeTier(news.tier ?? output?.tier);
      const previousConnect = normalizeConnectMode(
        olds?.connectMode ?? output?.connectMode,
      );
      const nextConnect = normalizeConnectMode(
        news.connectMode ?? output?.connectMode,
      );
      const previousTransit = normalizeTransit(
        olds?.transitEncryptionMode ?? output?.transitEncryptionMode,
      );
      const nextTransit = normalizeTransit(
        news.transitEncryptionMode ?? output?.transitEncryptionMode,
      );
      const previousNetwork =
        olds?.authorizedNetwork ?? output?.authorizedNetwork ?? "";
      const nextNetwork = news.authorizedNetwork ?? previousNetwork;
      const previousRange =
        olds?.reservedIpRange ?? output?.reservedIpRange ?? "";
      const nextRange = news.reservedIpRange ?? previousRange;
      const previousZone = olds?.locationId ?? output?.locationId ?? "";
      const nextZone = news.locationId ?? previousZone;
      const previousAlt =
        olds?.alternativeLocationId ?? output?.alternativeLocationId ?? "";
      const nextAlt = news.alternativeLocationId ?? previousAlt;
      const previousCmek =
        olds?.customerManagedKey ?? output?.customerManagedKey ?? "";
      const nextCmek = news.customerManagedKey ?? previousCmek;
      const previousReplicas = normalizeReadReplicas(
        olds?.readReplicasMode ?? output?.readReplicasMode,
      );
      const nextReplicas = normalizeReadReplicas(
        news.readReplicasMode ?? output?.readReplicasMode,
      );
      const previousVersion = olds?.redisVersion ?? output?.redisVersion;
      const nextVersion = news.redisVersion;
      const downgrade =
        nextVersion !== undefined &&
        previousVersion !== undefined &&
        versionDecreasing(previousVersion, nextVersion);

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousTier !== nextTier ||
        previousConnect !== nextConnect ||
        previousTransit !== nextTransit ||
        previousNetwork !== nextNetwork ||
        previousRange !== nextRange ||
        previousZone !== nextZone ||
        previousAlt !== nextAlt ||
        previousCmek !== nextCmek ||
        previousReplicas !== nextReplicas ||
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
        return yield* redis.listProjectsLocationsInstances
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
      const tier = normalizeTier(news.tier);
      const connectMode = normalizeConnectMode(news.connectMode);
      const transitEncryptionMode = normalizeTransit(
        news.transitEncryptionMode,
      );
      const memorySizeGb = news.memorySizeGb ?? DEFAULT_MEMORY_SIZE_GB;
      const authEnabled = news.authEnabled === true;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* redis
          .createProjectsLocationsInstances({
            parent: `projects/${env.project}/locations/${location}`,
            instanceId,
            body: toCreateBody(
              news,
              desiredLabels,
              tier,
              connectMode,
              transitEncryptionMode,
              memorySizeGb,
              authEnabled,
            ),
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

      const desiredVersion = news.redisVersion;
      const currentVersion = current.redisVersion;
      if (
        desiredVersion !== undefined &&
        currentVersion !== undefined &&
        desiredVersion !== currentVersion &&
        !versionDecreasing(currentVersion, desiredVersion)
      ) {
        const upgraded = yield* redis.upgradeProjectsLocationsInstances({
          name,
          body: { redisVersion: desiredVersion },
        });
        yield* waitForOperation(upgraded);
        current = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const memoryChanged =
        (current.memorySizeGb ?? DEFAULT_MEMORY_SIZE_GB) !== memorySizeGb;
      const authChanged = (current.authEnabled === true) !== authEnabled;
      const configsChanged =
        news.redisConfigs !== undefined &&
        configsKey(current.redisConfigs) !== configsKey(news.redisConfigs);
      const persistenceChanged =
        news.persistenceConfig !== undefined &&
        persistenceKey(current.persistenceConfig) !==
          persistenceKey(news.persistenceConfig);
      const maintenanceChanged =
        news.maintenancePolicy !== undefined &&
        maintenanceKey(current.maintenancePolicy) !==
          maintenanceKey(news.maintenancePolicy);
      const replicaChanged =
        news.replicaCount !== undefined &&
        (current.replicaCount ?? 0) !== news.replicaCount;
      const secondaryChanged =
        news.secondaryIpRange !== undefined &&
        (current.secondaryIpRange ?? "") !== news.secondaryIpRange;
      const maintenanceVersionChanged =
        news.maintenanceVersion !== undefined &&
        (current.maintenanceVersion ?? "") !== news.maintenanceVersion;

      if (
        labelsChanged ||
        displayNameChanged ||
        memoryChanged ||
        authChanged ||
        configsChanged ||
        persistenceChanged ||
        maintenanceChanged ||
        replicaChanged ||
        secondaryChanged ||
        maintenanceVersionChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "displayName" : undefined,
          memoryChanged ? "memorySizeGb" : undefined,
          authChanged ? "authEnabled" : undefined,
          configsChanged ? "redisConfig" : undefined,
          persistenceChanged ? "persistenceConfig" : undefined,
          maintenanceChanged ? "maintenancePolicy" : undefined,
          replicaChanged ? "replica_count" : undefined,
          secondaryChanged ? "secondaryIpRange" : undefined,
          maintenanceVersionChanged ? "maintenanceVersion" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* redis.patchProjectsLocationsInstances({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            labels: desiredLabels,
            displayName: news.displayName,
            memorySizeGb,
            authEnabled,
            redisConfigs: news.redisConfigs,
            persistenceConfig: news.persistenceConfig,
            maintenancePolicy: news.maintenancePolicy,
            replicaCount: news.replicaCount,
            secondaryIpRange: news.secondaryIpRange,
            maintenanceVersion: news.maintenanceVersion,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* getByName(output.name).pipe(
        Effect.filterOrFail(
          (instance) =>
            instance === undefined || (instance.state ?? "") !== "CREATING",
          () => new InstanceOperationPending({ operation: output.name }),
        ),
        Effect.retry({
          while: (error) => error._tag === "GCP.Redis.InstanceOperationPending",
          ...LONG_POLL,
        }),
      );
      const operation = yield* redis
        .deleteProjectsLocationsInstances({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 24,
            schedule: Schedule.spaced("8 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
