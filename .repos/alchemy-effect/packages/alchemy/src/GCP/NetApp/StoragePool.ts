import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  expandParent,
  fieldMask,
  gibOf,
  listAtLocation,
  listLabeledPages,
  networkName,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const DEFAULT_SERVICE_LEVEL: netapp.StoragePoolServiceLevelEnum = "STANDARD";
const DEFAULT_CAPACITY_GIB = 2048;

export type StoragePoolProps = {
  /**
   * Storage pool id (the `{storagePool}` segment of
   * `projects/{project}/locations/{location}/storagePools/{storagePool}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the pool.
   */
  storagePoolId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the pool. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * VPC network name (`default`) or path
   * `projects/{project}/global/networks/{network}`. Immutable — changing
   * it replaces the pool.
   * @default "default"
   */
  network?: string;
  /**
   * Service level. Immutable — changing it replaces the pool.
   * @default "STANDARD"
   */
  serviceLevel?: netapp.StoragePoolServiceLevelEnum | (string & {});
  /**
   * Pool capacity in GiB. STANDARD/PREMIUM/EXTREME minimum is 2048.
   * @default 2048
   */
  capacityGib?: number | string;
  /**
   * Active zone for a regional Flex pool. Immutable — changing it
   * replaces the pool.
   */
  zone?: string;
  /**
   * Replica zone for a regional Flex pool. Immutable — changing it
   * replaces the pool.
   */
  replicaZone?: string;
  /**
   * KMS config used to encrypt volumes. Full name or id. Immutable —
   * changing it replaces the pool.
   */
  kmsConfig?: string;
  /**
   * Active Directory used for SMB volumes. Full name or id.
   */
  activeDirectory?: string;
  /**
   * Enable NFS LDAP. Immutable — changing it replaces the pool.
   */
  ldapEnabled?: boolean;
  /**
   * Allow auto-tiering on volumes. Can be enabled after create but not
   * disabled.
   */
  allowAutoTiering?: boolean;
  /**
   * Pool type. Immutable — changing it replaces the pool.
   */
  type?: netapp.StoragePoolTypeEnum | (string & {});
  /**
   * Pool mode. Immutable — changing it replaces the pool.
   */
  mode?: netapp.StoragePoolModeEnum | (string & {});
  /**
   * QoS type.
   */
  qosType?: netapp.StoragePoolQosTypeEnum | (string & {});
  /**
   * Enable independent scaling of capacity and performance. Immutable —
   * changing it replaces the pool.
   */
  customPerformanceEnabled?: boolean;
  /**
   * Custom total throughput in MiB/s.
   */
  totalThroughputMibps?: number | string;
  /**
   * Custom total IOPS.
   */
  totalIops?: number | string;
  /**
   * Hot-tier size in GiB (Flex only).
   */
  hotTierSizeGib?: number | string;
  /**
   * Auto-increase hot-tier by 10% when it hits 100%.
   */
  enableHotTierAutoResize?: boolean;
  /**
   * Scale type. Immutable — changing it replaces the pool.
   */
  scaleType?: netapp.StoragePoolScaleTypeEnum | (string & {});
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type StoragePool = Resource<
  "GCP.NetApp.StoragePool",
  StoragePoolProps,
  {
    /** Full resource name. */
    name: string;
    /** Storage pool id (last path segment). */
    storagePoolId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** VPC network path. */
    network: string | undefined;
    /** Service level. */
    serviceLevel: string | undefined;
    /** Capacity in GiB. */
    capacityGib: string | undefined;
    /** Allocated volume capacity in GiB. */
    volumeCapacityGib: string | undefined;
    /** Number of volumes. */
    volumeCount: number | undefined;
    /** Active zone. */
    zone: string | undefined;
    /** Replica zone. */
    replicaZone: string | undefined;
    /** KMS config name. */
    kmsConfig: string | undefined;
    /** Active Directory name. */
    activeDirectory: string | undefined;
    /** Whether NFS LDAP is enabled. */
    ldapEnabled: boolean | undefined;
    /** Whether auto-tiering is allowed. */
    allowAutoTiering: boolean | undefined;
    /** Pool type. */
    type: string | undefined;
    /** Pool mode. */
    mode: string | undefined;
    /** QoS type. */
    qosType: string | undefined;
    /** Whether custom performance is enabled. */
    customPerformanceEnabled: boolean | undefined;
    /** Total throughput in MiB/s. */
    totalThroughputMibps: string | undefined;
    /** Total IOPS. */
    totalIops: string | undefined;
    /** Hot-tier size in GiB. */
    hotTierSizeGib: string | undefined;
    /** Whether hot-tier auto-resize is enabled. */
    enableHotTierAutoResize: boolean | undefined;
    /** Available throughput in MiB/s. */
    availableThroughputMibps: number | undefined;
    /** Cold-tier usage in GiB. */
    coldTierSizeUsedGib: string | undefined;
    /** Hot-tier usage in GiB. */
    hotTierSizeUsedGib: string | undefined;
    /** Encryption key source. */
    encryptionType: string | undefined;
    /** Scale type. */
    scaleType: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** State details. */
    stateDetails: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud NetApp Volumes storage pool — billed capacity that hosts
 * volumes at a service level.
 *
 * Changing `storagePoolId`, `location`, `network`, `serviceLevel`,
 * `zone`, `replicaZone`, `kmsConfig`, `ldapEnabled`, `type`, `mode`,
 * `customPerformanceEnabled`, or `scaleType` replaces the pool. Capacity,
 * description, labels, QoS, and auto-tiering update in place.
 *
 * ### Creating a Storage Pool
 * **Example:** Generated name
 * ```typescript
 * const pool = yield* GCP.NetApp.StoragePool("Pool", {
 *   network: "default",
 *   serviceLevel: "STANDARD",
 *   capacityGib: 2048,
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const pool = yield* GCP.NetApp.StoragePool("Pool", {
 *   storagePoolId: "app-pool",
 *   network: "default",
 *   serviceLevel: "PREMIUM",
 *   capacityGib: 4096,
 *   description: "app volumes",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Storage Pool
 * **Example:** Capacity and labels
 * ```typescript
 * const pool = yield* GCP.NetApp.StoragePool("Pool", {
 *   network: "default",
 *   serviceLevel: "STANDARD",
 *   capacityGib: 4096,
 *   description: "app volumes v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const StoragePool = Resource<StoragePool>("GCP.NetApp.StoragePool");

const resourceName = (
  project: string,
  location: string,
  storagePoolId: string,
) => `projects/${project}/locations/${location}/storagePools/${storagePoolId}`;

const toAttrs = (item: netapp.StoragePool, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "storagePools", region);
  return {
    name,
    storagePoolId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    network: item.network,
    serviceLevel: item.serviceLevel,
    capacityGib: item.capacityGib,
    volumeCapacityGib: item.volumeCapacityGib,
    volumeCount: item.volumeCount,
    zone: item.zone,
    replicaZone: item.replicaZone,
    kmsConfig: item.kmsConfig,
    activeDirectory: item.activeDirectory,
    ldapEnabled: item.ldapEnabled,
    allowAutoTiering: item.allowAutoTiering,
    type: item.type,
    mode: item.mode,
    qosType: item.qosType,
    customPerformanceEnabled: item.customPerformanceEnabled,
    totalThroughputMibps: item.totalThroughputMibps,
    totalIops: item.totalIops,
    hotTierSizeGib: item.hotTierSizeGib,
    enableHotTierAutoResize: item.enableHotTierAutoResize,
    availableThroughputMibps: item.availableThroughputMibps,
    coldTierSizeUsedGib: item.coldTierSizeUsedGib,
    hotTierSizeUsedGib: item.hotTierSizeUsedGib,
    encryptionType: item.encryptionType,
    scaleType: item.scaleType,
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    stateDetails: item.stateDetails,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  netapp
    .getProjectsLocationsStoragePools({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      netapp.listProjectsLocationsStoragePools.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.storagePools,
      (item) => item.labels,
    ),
  );

export const StoragePoolProvider = () =>
  Provider.succeed(StoragePool, {
    stables: ["name", "storagePoolId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousNetwork = olds?.network ?? output?.network;
      const previousLevel = olds?.serviceLevel ?? output?.serviceLevel;
      const previousZone = olds?.zone ?? output?.zone;
      const previousReplica = olds?.replicaZone ?? output?.replicaZone;
      const previousKms = olds?.kmsConfig ?? output?.kmsConfig;
      const previousLdap = olds?.ldapEnabled ?? output?.ldapEnabled;
      const previousType = olds?.type ?? output?.type;
      const previousMode = olds?.mode ?? output?.mode;
      const previousCustom =
        olds?.customPerformanceEnabled ?? output?.customPerformanceEnabled;
      const previousScale = olds?.scaleType ?? output?.scaleType;
      return replaceOnIdentity({
        previousId: olds?.storagePoolId ?? output?.storagePoolId,
        nextId:
          news.storagePoolId ?? olds?.storagePoolId ?? output?.storagePoolId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousNetwork !== undefined &&
            news.network !== undefined &&
            news.network !== previousNetwork &&
            !previousNetwork.endsWith(`/${news.network}`)) ||
          (previousLevel !== undefined &&
            news.serviceLevel !== undefined &&
            news.serviceLevel !== previousLevel) ||
          (previousZone !== undefined &&
            news.zone !== undefined &&
            news.zone !== previousZone) ||
          (previousReplica !== undefined &&
            news.replicaZone !== undefined &&
            news.replicaZone !== previousReplica) ||
          (previousKms !== undefined &&
            news.kmsConfig !== undefined &&
            news.kmsConfig !== previousKms) ||
          (previousLdap !== undefined &&
            news.ldapEnabled !== undefined &&
            news.ldapEnabled !== previousLdap) ||
          (previousType !== undefined &&
            news.type !== undefined &&
            news.type !== previousType) ||
          (previousMode !== undefined &&
            news.mode !== undefined &&
            news.mode !== previousMode) ||
          (previousCustom !== undefined &&
            news.customPerformanceEnabled !== undefined &&
            news.customPerformanceEnabled !== previousCustom) ||
          (previousScale !== undefined &&
            news.scaleType !== undefined &&
            news.scaleType !== previousScale),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const storagePoolId = yield* toPhysicalId(
        id,
        olds?.storagePoolId,
        output?.storagePoolId,
        "storagepool",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, storagePoolId);
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
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const storagePoolId = yield* toPhysicalId(
        id,
        news.storagePoolId,
        output?.storagePoolId,
        "storagepool",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, storagePoolId);
      const network = networkName(env.project, news.network);
      const serviceLevel = news.serviceLevel ?? DEFAULT_SERVICE_LEVEL;
      const capacityGib = gibOf(news.capacityGib ?? DEFAULT_CAPACITY_GIB);
      const kmsConfig =
        news.kmsConfig === undefined
          ? undefined
          : expandParent(news.kmsConfig, env.project, location, "kmsConfigs");
      const activeDirectory =
        news.activeDirectory === undefined
          ? undefined
          : expandParent(
              news.activeDirectory,
              env.project,
              location,
              "activeDirectories",
            );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsStoragePools({
            parent: parentOf(env.project, location),
            storagePoolId,
            body: {
              network,
              serviceLevel,
              capacityGib,
              zone: news.zone,
              replicaZone: news.replicaZone,
              kmsConfig,
              activeDirectory,
              ldapEnabled: news.ldapEnabled,
              allowAutoTiering: news.allowAutoTiering,
              type: news.type,
              mode: news.mode,
              qosType: news.qosType,
              customPerformanceEnabled: news.customPerformanceEnabled,
              totalThroughputMibps: gibOf(news.totalThroughputMibps),
              totalIops: gibOf(news.totalIops),
              hotTierSizeGib: gibOf(news.hotTierSizeGib),
              enableHotTierAutoResize: news.enableHotTierAutoResize,
              scaleType: news.scaleType,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
        (item) => item.stateDetails,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const desiredAd = activeDirectory ?? current.activeDirectory;
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.description ?? "") !== (news.description ?? "") &&
          "description",
        (current.capacityGib ?? "") !== (capacityGib ?? "") && "capacityGib",
        (current.activeDirectory ?? "") !== (desiredAd ?? "") &&
          "activeDirectory",
        (current.allowAutoTiering ?? false) !==
          (news.allowAutoTiering ?? current.allowAutoTiering ?? false) &&
          "allowAutoTiering",
        (current.qosType ?? "") !== (news.qosType ?? current.qosType ?? "") &&
          "qosType",
        (current.totalThroughputMibps ?? "") !==
          (gibOf(news.totalThroughputMibps) ??
            current.totalThroughputMibps ??
            "") && "totalThroughputMibps",
        (current.totalIops ?? "") !==
          (gibOf(news.totalIops) ?? current.totalIops ?? "") && "totalIops",
        (current.hotTierSizeGib ?? "") !==
          (gibOf(news.hotTierSizeGib) ?? current.hotTierSizeGib ?? "") &&
          "hotTierSizeGib",
        (current.enableHotTierAutoResize ?? true) !==
          (news.enableHotTierAutoResize ??
            current.enableHotTierAutoResize ??
            true) && "enableHotTierAutoResize",
      ]);

      if (mask.length > 0) {
        const operation = yield* netapp.patchProjectsLocationsStoragePools({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            description: news.description,
            capacityGib,
            activeDirectory: desiredAd,
            allowAutoTiering: news.allowAutoTiering ?? current.allowAutoTiering,
            qosType: news.qosType ?? current.qosType,
            totalThroughputMibps:
              gibOf(news.totalThroughputMibps) ?? current.totalThroughputMibps,
            totalIops: gibOf(news.totalIops) ?? current.totalIops,
            hotTierSizeGib:
              gibOf(news.hotTierSizeGib) ?? current.hotTierSizeGib,
            enableHotTierAutoResize:
              news.enableHotTierAutoResize ?? current.enableHotTierAutoResize,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
          (item) => item.stateDetails,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* netapp
        .deleteProjectsLocationsStoragePools({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
