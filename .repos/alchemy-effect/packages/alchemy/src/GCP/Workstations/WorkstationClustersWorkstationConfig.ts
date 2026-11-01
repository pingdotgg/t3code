import * as workstations from "@distilled.cloud/gcp/workstations_v1";
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
  fingerprint,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameBool,
  sameNumber,
  sameText,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type Container = {
  /**
   * Docker image that defines the workstation environment. Public images
   * or Artifact Registry images the host service account can pull.
   */
  image?: string;
  /**
   * Environment variables passed to the container entrypoint.
   */
  env?: Record<string, string>;
  /**
   * Override the image ENTRYPOINT.
   */
  command?: string[];
  /**
   * Arguments passed to the entrypoint.
   */
  args?: string[];
  /**
   * Override the image working directory.
   */
  workingDir?: string;
  /**
   * Run the container as this uid.
   */
  runAsUser?: number;
};

export type ReadinessCheck = {
  /** Path the readiness probe requests. */
  path?: string;
  /** Port the readiness probe requests. */
  port?: number;
};

export type Accelerator = {
  /** Accelerator type (`nvidia-tesla-p100`, …). */
  type?: string;
  /** Number of accelerator cards. */
  count?: number;
};

export type GceShieldedInstanceConfig = {
  /** Enable Secure Boot. */
  enableSecureBoot?: boolean;
  /** Enable vTPM. */
  enableVtpm?: boolean;
  /** Enable integrity monitoring. */
  enableIntegrityMonitoring?: boolean;
};

export type GceConfidentialInstanceConfig = {
  /** Enable Confidential Compute. */
  enableConfidentialCompute?: boolean;
};

export type BoostConfig = {
  /** Boost configuration id. Required when listed. */
  id?: string;
  /** Machine type for boosted VMs. */
  machineType?: string;
  /** Idle boost VMs to keep ready. */
  poolSize?: number;
  /** Boot disk size in GB (minimum 30). */
  bootDiskSizeGb?: number;
  /** Enable nested virtualization on boosted VMs. */
  enableNestedVirtualization?: boolean;
  /** Accelerators attached to boosted VMs. */
  accelerators?: Accelerator[];
};

export type GceInstance = {
  /**
   * Machine type (`e2-standard-4`, …).
   */
  machineType?: string;
  /**
   * Boot disk size in GB. Minimum 30, default 50.
   */
  bootDiskSizeGb?: number;
  /**
   * Idle VMs kept ready for fast start. Default 0.
   */
  poolSize?: number;
  /**
   * Disable public IPs. Requires Private Google Access or Cloud NAT.
   * @default false
   */
  disablePublicIpAddresses?: boolean;
  /**
   * Disable SSH access to the VM.
   */
  disableSsh?: boolean;
  /**
   * Enable nested virtualization (N1/N2 machine series only).
   */
  enableNestedVirtualization?: boolean;
  /**
   * Service account email for workstation VMs.
   */
  serviceAccount?: string;
  /**
   * Scopes granted to `serviceAccount`.
   */
  serviceAccountScopes?: string[];
  /**
   * Network tags applied to workstation VMs.
   */
  tags?: string[];
  /**
   * Resource Manager tags bound to the VM
   * (`tagKeys/{id}` → `tagValues/{id}`).
   */
  vmTags?: Record<string, string>;
  /**
   * Custom instance metadata.
   */
  instanceMetadata?: Record<string, string>;
  /**
   * GCS URI of a startup script (`gs://{bucket}/{object}`).
   */
  startupScriptUri?: string;
  /**
   * Shielded VM options.
   */
  shieldedInstanceConfig?: GceShieldedInstanceConfig;
  /**
   * Confidential VM options.
   */
  confidentialInstanceConfig?: GceConfidentialInstanceConfig;
  /**
   * Accelerators attached to the VM.
   */
  accelerators?: Accelerator[];
  /**
   * Boost configurations users may choose at start.
   */
  boostConfigs?: BoostConfig[];
};

export type Host = {
  /** Compute Engine VM that backs workstations. */
  gceInstance?: GceInstance;
};

export type CustomerEncryptionKey = {
  /**
   * Cloud KMS key
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Immutable.
   */
  kmsKey?: string;
  /**
   * Service account used with the KMS key. Immutable.
   */
  kmsKeyServiceAccount?: string;
};

export type GcePersistentDisk = {
  /** Source disk image. Mutually exclusive with `sourceSnapshot`. */
  sourceImage?: string;
  /** Source snapshot. Mutually exclusive with `sourceImage`. */
  sourceSnapshot?: string;
  /** When true the disk is read-only and may be shared. */
  readOnly?: boolean;
  /**
   * Disk type.
   * @default "pd-standard"
   */
  diskType?: string;
};

export type EphemeralDirectory = {
  /** Mount path inside the workstation. */
  mountPath?: string;
  /** Persistent-disk backing for the ephemeral directory. */
  gcePd?: GcePersistentDisk;
};

export type GceRegionalPersistentDisk = {
  /**
   * Capacity in GB (`10`, `50`, `100`, `200`, `500`, or `1000`).
   * Default 200.
   */
  sizeGb?: number;
  /**
   * Disk type (`pd-standard`, `pd-balanced`, `pd-ssd`).
   * @default "pd-standard"
   */
  diskType?: string;
  /**
   * File system type.
   * @default "ext4"
   */
  fsType?: string;
  /**
   * Whether to delete the disk when the workstation is deleted.
   * @default "DELETE"
   */
  reclaimPolicy?:
    | workstations.GceRegionalPersistentDiskReclaimPolicyEnum
    | (string & {});
  /** Snapshot used as the disk source. */
  sourceSnapshot?: string;
  /**
   * Seconds to wait before archiving the disk as a snapshot (`"0s"`
   * disables archival).
   */
  archiveTimeout?: string;
  /** Maximum resize size in GB. */
  maxSizeGb?: number;
};

export type GceHyperdiskBalancedHighAvailability = {
  /**
   * Capacity in GB (`10`, `50`, `100`, `200`, `500`, or `1000`).
   * Default 200.
   */
  sizeGb?: number;
  /**
   * Whether to delete the disk when the workstation is deleted.
   * @default "DELETE"
   */
  reclaimPolicy?:
    | workstations.GceHyperdiskBalancedHighAvailabilityReclaimPolicyEnum
    | (string & {});
  /** Snapshot used as the disk source. */
  sourceSnapshot?: string;
  /**
   * Seconds to wait before archiving the disk as a snapshot.
   */
  archiveTimeout?: string;
  /** Maximum resize size in GB. */
  maxSizeGb?: number;
};

export type PersistentDirectory = {
  /** Mount path inside the workstation. */
  mountPath?: string;
  /** Regional persistent disk backing. */
  gcePd?: GceRegionalPersistentDisk;
  /** Hyperdisk Balanced HA backing. */
  gceHd?: GceHyperdiskBalancedHighAvailability;
};

export type PortRange = {
  /** Inclusive start port (22, 80, or 1024-65535). */
  first?: number;
  /** Inclusive end port (22, 80, or 1024-65535). */
  last?: number;
};

export type WorkstationClustersWorkstationConfigProps = {
  /**
   * Parent workstation cluster. Full name
   * `projects/{project}/locations/{location}/workstationClusters/{workstationCluster}`
   * or a cluster id (combined with `location`). Immutable — changing it
   * replaces the configuration.
   */
  workstationCluster: string;
  /**
   * Configuration id (the `{workstationConfig}` segment). If omitted, a
   * unique RFC1035 name is generated from the stack, stage, and logical
   * id. Immutable — changing it replaces the configuration.
   */
  workstationConfigId?: string;
  /**
   * Region used when `workstationCluster` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Human-readable display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Client-specified annotations.
   */
  annotations?: Record<string, string>;
  /**
   * Container that runs on each workstation using this configuration.
   */
  container?: Container;
  /**
   * Runtime host for workstations created from this configuration.
   */
  host?: Host;
  /**
   * Readiness checks that must return 200 before the workstation is
   * marked running.
   */
  readinessChecks?: ReadinessCheck[];
  /**
   * Idle timeout before automatic stop (`"1200s"` default, `"0s"` never).
   */
  idleTimeout?: string;
  /**
   * Maximum running time (`"43200s"` default, `"0s"` never).
   */
  runningTimeout?: string;
  /**
   * Directories persisted across workstation sessions.
   */
  persistentDirectories?: PersistentDirectory[];
  /**
   * Directories that are recreated on every start.
   */
  ephemeralDirectories?: EphemeralDirectory[];
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionKey?: CustomerEncryptionKey;
  /**
   * Zones used to replicate VM and disk resources. Exactly two zones in
   * the cluster region. Immutable.
   */
  replicaZones?: string[];
  /**
   * Maximum workstations a user may have `workstations.workstation.use`
   * on. `0` is unlimited.
   */
  maxUsableWorkstations?: number;
  /**
   * Enable Linux `auditd` logging. Requires a host service account with
   * log/metric writer roles.
   */
  enableAuditAgent?: boolean;
  /**
   * Disable the websocket TCP relay (SSH and other plain TCP).
   */
  disableTcpConnections?: boolean;
  /**
   * Ports exposed on the workstation. Defaults to 22, 80, and 1024-65535.
   */
  allowedPorts?: PortRange[];
  /**
   * Grant the creator `roles/workstations.policyAdmin` on workstations
   * they create.
   * @default false
   */
  grantWorkstationAdminRoleOnCreate?: boolean;
};

export type WorkstationClustersWorkstationConfig = Resource<
  "GCP.Workstations.WorkstationClustersWorkstationConfig",
  WorkstationClustersWorkstationConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Configuration id (last path segment). */
    workstationConfigId: string;
    /** Parent cluster name. */
    workstationCluster: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Client-specified annotations. */
    annotations: Record<string, string>;
    /** Container configuration. */
    container: Container | undefined;
    /** Runtime host configuration. */
    host: Host | undefined;
    /** Readiness checks. */
    readinessChecks: ReadinessCheck[] | undefined;
    /** Idle timeout. */
    idleTimeout: string | undefined;
    /** Running timeout. */
    runningTimeout: string | undefined;
    /** Persistent directories. */
    persistentDirectories: PersistentDirectory[] | undefined;
    /** Ephemeral directories. */
    ephemeralDirectories: EphemeralDirectory[] | undefined;
    /** Customer-managed encryption key. */
    encryptionKey: CustomerEncryptionKey | undefined;
    /** Replica zones. */
    replicaZones: string[] | undefined;
    /** Max usable workstations per user. */
    maxUsableWorkstations: number | undefined;
    /** Whether auditd logging is enabled. */
    enableAuditAgent: boolean;
    /** Whether the TCP relay is disabled. */
    disableTcpConnections: boolean;
    /** Exposed port ranges. */
    allowedPorts: PortRange[] | undefined;
    /** Whether creators get policyAdmin. */
    grantWorkstationAdminRoleOnCreate: boolean;
    /** Whether the configuration is reconciling. */
    reconciling: boolean;
    /** Whether the configuration is degraded. */
    degraded: boolean;
    /** Server-generated resource uid. */
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
 * A Cloud Workstations configuration — the template for workstation VMs
 * (machine type, image, disks, timeouts).
 *
 * Changing `workstationConfigId`, `location`, `workstationCluster`,
 * `replicaZones`, or `encryptionKey` replaces the configuration. Display
 * name, labels, container, host, timeouts, directories, and ports update
 * in place.
 *
 * ### Creating a Configuration
 * **Example:** Generated name
 * ```typescript
 * const config = yield* GCP.Workstations.WorkstationClustersWorkstationConfig(
 *   "Code",
 *   { workstationCluster: cluster.name },
 * );
 * ```
 *
 * **Example:** Custom machine type and image
 * ```typescript
 * const config = yield* GCP.Workstations.WorkstationClustersWorkstationConfig(
 *   "Code",
 *   {
 *     workstationCluster: cluster.name,
 *     idleTimeout: "1800s",
 *     host: { gceInstance: { machineType: "e2-standard-4", poolSize: 0 } },
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * ### Updating a Configuration
 * **Example:** Display name and idle timeout
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const config = yield* GCP.Workstations.WorkstationClustersWorkstationConfig(
 *   "Code",
 *   {
 *     workstationCluster: cluster.name,
 *     displayName: "code v2",
 *     idleTimeout: "3600s",
 *   },
 * );
 * ```
 *
 * @resource
 * @category Workstations
 */
export const WorkstationClustersWorkstationConfig =
  Resource<WorkstationClustersWorkstationConfig>(
    "GCP.Workstations.WorkstationClustersWorkstationConfig",
  );

const resourceName = (cluster: string, workstationConfigId: string) =>
  `${cluster}/workstationConfigs/${workstationConfigId}`;

const toContainer = (
  value: workstations.Container | Container | undefined,
): Container | undefined =>
  value === undefined
    ? undefined
    : {
        image: value.image,
        env: stringMap(value.env),
        command: value.command,
        args: value.args,
        workingDir: value.workingDir,
        runAsUser: value.runAsUser,
      };

const toGceInstance = (
  value: workstations.GceInstance | GceInstance | undefined,
): GceInstance | undefined =>
  value === undefined
    ? undefined
    : {
        machineType: value.machineType,
        bootDiskSizeGb: value.bootDiskSizeGb,
        poolSize: value.poolSize,
        disablePublicIpAddresses: value.disablePublicIpAddresses,
        disableSsh: value.disableSsh,
        enableNestedVirtualization: value.enableNestedVirtualization,
        serviceAccount: value.serviceAccount,
        serviceAccountScopes: value.serviceAccountScopes,
        tags: value.tags,
        vmTags: stringMap(value.vmTags),
        instanceMetadata: stringMap(value.instanceMetadata),
        startupScriptUri: value.startupScriptUri,
        shieldedInstanceConfig: value.shieldedInstanceConfig,
        confidentialInstanceConfig: value.confidentialInstanceConfig,
        accelerators: value.accelerators,
        boostConfigs: value.boostConfigs,
      };

const toHost = (
  value: workstations.Host | Host | undefined,
): Host | undefined =>
  value === undefined
    ? undefined
    : { gceInstance: toGceInstance(value.gceInstance) };

// Reads omit proto3 defaults (`poolSize: 0`, `false`) and add server defaults
// the user never set (scopes, disk size), so compare only the fields the user
// declared, treating an omitted default as equal to its zero value.
const isZero = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === 0 ||
  value === false ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && Object.keys(value as object).length === 0);

const hostMatches = (
  observed: workstations.Host | undefined,
  desired: Host,
): boolean => {
  const want = toGceInstance(desired.gceInstance);
  if (want === undefined) return true;
  const have = toGceInstance(observed?.gceInstance) ?? {};
  return Object.entries(want).every(([key, value]) => {
    if (value === undefined) return true;
    const current = have[key as keyof GceInstance];
    return isZero(value)
      ? isZero(current)
      : fingerprint(current) === fingerprint(value);
  });
};

const toPersistent = (
  value: workstations.PersistentDirectory | PersistentDirectory,
): PersistentDirectory => ({
  mountPath: value.mountPath,
  gcePd: value.gcePd,
  gceHd: value.gceHd,
});

const toEphemeral = (
  value: workstations.EphemeralDirectory | EphemeralDirectory,
): EphemeralDirectory => ({
  mountPath: value.mountPath,
  gcePd: value.gcePd,
});

const toAttrs = (
  item: workstations.WorkstationConfig,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "workstationConfigs", region);
  return {
    name,
    workstationConfigId: parsed.id,
    workstationCluster: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    labels: userLabels(item.labels),
    annotations: stringMap(item.annotations) ?? {},
    container: toContainer(item.container),
    host: toHost(item.host),
    readinessChecks: item.readinessChecks,
    idleTimeout: item.idleTimeout,
    runningTimeout: item.runningTimeout,
    persistentDirectories: item.persistentDirectories?.map(toPersistent),
    ephemeralDirectories: item.ephemeralDirectories?.map(toEphemeral),
    encryptionKey: item.encryptionKey,
    replicaZones: item.replicaZones,
    maxUsableWorkstations: item.maxUsableWorkstations,
    enableAuditAgent: item.enableAuditAgent === true,
    disableTcpConnections: item.disableTcpConnections === true,
    allowedPorts: item.allowedPorts,
    grantWorkstationAdminRoleOnCreate:
      item.grantWorkstationAdminRoleOnCreate === true,
    reconciling: item.reconciling === true,
    degraded: item.degraded === true,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  workstations
    .getProjectsLocationsWorkstationClustersWorkstationConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtNested(project, region, "workstationClusters/-", (parent) =>
    listLabeledPages(
      workstations.listProjectsLocationsWorkstationClustersWorkstationConfigs.pages(
        {
          parent,
          pageSize: 1000,
        },
      ),
      (page) => page.workstationConfigs,
      (item) => item.labels,
    ),
  );

const replicaKey = (zones: string[] | undefined) =>
  fingerprint([...(zones ?? [])].map((zone) => zone.toLowerCase()).sort());

export const WorkstationClustersWorkstationConfigProvider = () =>
  Provider.succeed(WorkstationClustersWorkstationConfig, {
    stables: [
      "name",
      "workstationConfigId",
      "workstationCluster",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKey = olds?.encryptionKey ?? output?.encryptionKey;
      const previousZones = olds?.replicaZones ?? output?.replicaZones;
      return replaceOnIdentity({
        previousId: olds?.workstationConfigId ?? output?.workstationConfigId,
        nextId:
          news.workstationConfigId ??
          olds?.workstationConfigId ??
          output?.workstationConfigId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.workstationCluster ?? output?.workstationCluster,
        nextParent: news.workstationCluster,
        extra:
          (previousKey?.kmsKey !== undefined &&
            news.encryptionKey?.kmsKey !== undefined &&
            previousKey.kmsKey !== news.encryptionKey.kmsKey) ||
          (previousZones !== undefined &&
            news.replicaZones !== undefined &&
            replicaKey(previousZones) !== replicaKey(news.replicaZones)),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.workstationCluster ?? output?.workstationCluster;
      // A config cannot exist before its cluster's name resolved.
      if (output?.name === undefined && !parent) return undefined;
      const workstationConfigId = yield* toPhysicalId(
        id,
        olds?.workstationConfigId,
        output?.workstationConfigId,
        "config",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const cluster = expandParent(
        parent ?? "",
        env.project,
        location,
        "workstationClusters",
      );
      const name = output?.name ?? resourceName(cluster, workstationConfigId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const workstationConfigId = yield* toPhysicalId(
        id,
        news.workstationConfigId,
        output?.workstationConfigId,
        "config",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const cluster = expandParent(
        news.workstationCluster,
        env.project,
        location,
        "workstationClusters",
      );
      const name = resourceName(cluster, workstationConfigId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = stringMap(news.annotations);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* workstations
          .createProjectsLocationsWorkstationClustersWorkstationConfigs({
            parent: cluster,
            workstationConfigId,
            body: {
              displayName: news.displayName,
              labels: desiredLabels,
              annotations: desiredAnnotations,
              container: news.container,
              host: news.host,
              readinessChecks: news.readinessChecks,
              idleTimeout: news.idleTimeout,
              runningTimeout: news.runningTimeout,
              persistentDirectories: news.persistentDirectories,
              ephemeralDirectories: news.ephemeralDirectories,
              encryptionKey: news.encryptionKey,
              replicaZones: news.replicaZones,
              maxUsableWorkstations: news.maxUsableWorkstations,
              enableAuditAgent: news.enableAuditAgent,
              disableTcpConnections: news.disableTcpConnections,
              allowedPorts: news.allowedPorts,
              grantWorkstationAdminRoleOnCreate:
                news.grantWorkstationAdminRoleOnCreate,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.displayName, news.displayName) && "displayName",
        fingerprint(stringMap(current.annotations)) !==
          fingerprint(desiredAnnotations) && "annotations",
        news.container !== undefined &&
          fingerprint(toContainer(current.container)) !==
            fingerprint(toContainer(news.container)) &&
          "container",
        news.host !== undefined &&
          !hostMatches(current.host, news.host) &&
          "host",
        news.readinessChecks !== undefined &&
          fingerprint(current.readinessChecks) !==
            fingerprint(news.readinessChecks) &&
          "readinessChecks",
        news.idleTimeout !== undefined &&
          !sameText(current.idleTimeout, news.idleTimeout) &&
          "idleTimeout",
        news.runningTimeout !== undefined &&
          !sameText(current.runningTimeout, news.runningTimeout) &&
          "runningTimeout",
        news.persistentDirectories !== undefined &&
          fingerprint(current.persistentDirectories?.map(toPersistent)) !==
            fingerprint(news.persistentDirectories.map(toPersistent)) &&
          "persistentDirectories",
        news.ephemeralDirectories !== undefined &&
          fingerprint(current.ephemeralDirectories?.map(toEphemeral)) !==
            fingerprint(news.ephemeralDirectories.map(toEphemeral)) &&
          "ephemeralDirectories",
        news.maxUsableWorkstations !== undefined &&
          !sameNumber(
            current.maxUsableWorkstations,
            news.maxUsableWorkstations,
          ) &&
          "maxUsableWorkstations",
        news.enableAuditAgent !== undefined &&
          !sameBool(current.enableAuditAgent, news.enableAuditAgent) &&
          "enableAuditAgent",
        news.disableTcpConnections !== undefined &&
          !sameBool(
            current.disableTcpConnections,
            news.disableTcpConnections,
          ) &&
          "disableTcpConnections",
        news.allowedPorts !== undefined &&
          fingerprint(current.allowedPorts) !==
            fingerprint(news.allowedPorts) &&
          "allowedPorts",
        news.grantWorkstationAdminRoleOnCreate !== undefined &&
          !sameBool(
            current.grantWorkstationAdminRoleOnCreate,
            news.grantWorkstationAdminRoleOnCreate,
          ) &&
          "grantWorkstationAdminRoleOnCreate",
      ]);

      if (mask.length > 0) {
        const operation = yield* workstations
          .patchProjectsLocationsWorkstationClustersWorkstationConfigs({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              labels: desiredLabels,
              displayName: news.displayName,
              annotations: desiredAnnotations,
              container: news.container,
              host: news.host,
              readinessChecks: news.readinessChecks,
              idleTimeout: news.idleTimeout,
              runningTimeout: news.runningTimeout,
              persistentDirectories: news.persistentDirectories,
              ephemeralDirectories: news.ephemeralDirectories,
              maxUsableWorkstations: news.maxUsableWorkstations,
              enableAuditAgent: news.enableAuditAgent,
              disableTcpConnections: news.disableTcpConnections,
              allowedPorts: news.allowedPorts,
              grantWorkstationAdminRoleOnCreate:
                news.grantWorkstationAdminRoleOnCreate,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* workstations
        .deleteProjectsLocationsWorkstationClustersWorkstationConfigs({
          name: output.name,
          force: true,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
