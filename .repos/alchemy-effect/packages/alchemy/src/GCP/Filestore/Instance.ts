import * as file from "@distilled.cloud/gcp/file_v1";
import * as Data from "effect/Data";
import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
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
import { waitForOperation as waitForLongRunningOperation } from "../Operation.ts";

const DEFAULT_ZONAL_LOCATION = "us-central1-a";
const DEFAULT_TIER = "BASIC_HDD";
const DEFAULT_PROTOCOL = "NFS_V3";
const DEFAULT_CONNECT_MODE = "DIRECT_PEERING";
const DEFAULT_NETWORK = "default";
const DEFAULT_SHARE_NAME = "share1";
const DEFAULT_MODE = "MODE_IPV4";
const MAX_NAME_LENGTH = 63;

const REGIONAL_TIERS = new Set(["ENTERPRISE", "REGIONAL"]);

export type PscConfig = {
  /**
   * Consumer service project for the Private Service Connect endpoint
   * (Shared VPC). Defaults to the VPC host project.
   */
  endpointProject?: string;
};

export type NetworkConfig = {
  /**
   * VPC network name (`default`) or path
   * (`projects/{project}/global/networks/{network}`). Immutable.
   * @default "default"
   */
  network?: string;
  /**
   * Internet protocol versions assigned to the instance.
   * @default ["MODE_IPV4"]
   */
  modes?: Array<file.NetworkConfigModesItemEnum | (string & {})>;
  /**
   * Reserved IP CIDR (`DIRECT_PEERING`) or allocated range name
   * (`PRIVATE_SERVICE_ACCESS`). Immutable. BASIC uses a /29, Enterprise a
   * /26, High Scale a /24. If omitted, Filestore picks a free block.
   */
  reservedIpRange?: string;
  /**
   * Network connect mode. Immutable.
   * @default "DIRECT_PEERING"
   */
  connectMode?: file.NetworkConfigConnectModeEnum | (string & {});
  /**
   * Private Service Connect configuration. Set only when `connectMode` is
   * `PRIVATE_SERVICE_CONNECT`.
   */
  pscConfig?: PscConfig;
};

export type NfsExportOptions = {
  /**
   * Root squash. `NO_ROOT_SQUASH` (default) allows root; `ROOT_SQUASH`
   * maps root to `anonUid`/`anonGid`.
   */
  squashMode?: file.NfsExportOptionsSquashModeEnum | (string & {});
  /**
   * Source VPC for `ipRanges`. Required for Private Service Connect.
   * Must match `NetworkConfig.network` when set.
   */
  network?: string;
  /**
   * Anonymous group id used with `ROOT_SQUASH`. Default 65534.
   */
  anonGid?: number;
  /**
   * IPv4 addresses or CIDR ranges allowed to mount the share. Max 64
   * across all export options on a share. Overlaps are rejected.
   */
  ipRanges?: string[];
  /**
   * Mount access. `READ_WRITE` (default) or `READ_ONLY`.
   */
  accessMode?: file.NfsExportOptionsAccessModeEnum | (string & {});
  /**
   * Anonymous user id used with `ROOT_SQUASH`. Default 65534.
   */
  anonUid?: number;
};

export type FileShareConfig = {
  /**
   * Share name. 1-16 characters for Basic, 1-63 otherwise. Lowercase
   * letters, numbers, and underscores; must start with a letter.
   * Immutable — changing it replaces the instance.
   * @default "share1"
   */
  name?: string;
  /**
   * Capacity in GiB (1024^3 bytes). BASIC_HDD minimum is 1024, BASIC_SSD
   * 2560, HIGH_SCALE_SSD 10240. Omit to use the tier minimum.
   */
  capacityGb?: number;
  /**
   * NFS export options. Max 10 per share. Omit to allow all clients with
   * `READ_WRITE` and `NO_ROOT_SQUASH`.
   */
  nfsExportOptions?: NfsExportOptions[];
  /**
   * Filestore backup to restore
   * (`projects/{project}/locations/{location}/backups/{backup}`).
   * Immutable.
   */
  sourceBackup?: string;
  /**
   * BackupDR backup to restore. Immutable.
   */
  sourceBackupdrBackup?: string;
};

export type IopsPerTb = {
  /** Maximum IOPS per TiB of capacity. */
  maxIopsPerTb?: number;
};

export type FixedIops = {
  /** Fixed provisioned IOPS. Must be a multiple of 1000. */
  maxIops?: number;
};

export type PerformanceConfig = {
  /**
   * Provision IOPS as `capacityTiB * maxIopsPerTb`. Mutually exclusive
   * with `fixedIops`.
   */
  iopsPerTb?: IopsPerTb;
  /**
   * Fixed provisioned IOPS, independent of capacity. Mutually exclusive
   * with `iopsPerTb`.
   */
  fixedIops?: FixedIops;
};

export type LdapConfig = {
  /** LDAP servers as DNS names or IP addresses (one format, not mixed). */
  servers?: string[];
  /** LDAP domain (`example.com`). */
  domain?: string;
  /** Optional groups OU to speed LDAP lookups. */
  groupsOu?: string;
  /** Optional users OU to speed LDAP lookups. */
  usersOu?: string;
};

export type DirectoryServicesConfig = {
  /** LDAP configuration for NFSv4.1 Kerberos. */
  ldap?: LdapConfig;
};

export type ReplicaConfig = {
  /**
   * Source instance
   * (`projects/{project}/locations/{location}/instances/{instance}`).
   * Required when creating a standby replica.
   */
  peerInstance?: string;
};

export type Replication = {
  /** Replication role. New replicas must set `STANDBY`. */
  role?: file.ReplicationRoleEnum | (string & {});
  /** Replica peers. The API supports a single replica. */
  replicas?: ReplicaConfig[];
};

export type PerformanceLimits = {
  /** Maximum read IOPS. */
  maxReadIops: number | undefined;
  /** Maximum read throughput in bytes per second. */
  maxReadThroughputBps: number | undefined;
  /** Maximum IOPS. */
  maxIops: number | undefined;
  /** Maximum write IOPS. */
  maxWriteIops: number | undefined;
  /** Maximum write throughput in bytes per second. */
  maxWriteThroughputBps: number | undefined;
};

export type InstanceProps = {
  /**
   * Instance id (the `{instance}` segment of
   * `projects/{project}/locations/{location}/instances/{instance}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-63 characters, start with a letter, and end
   * with a letter or digit. Immutable — changing it replaces the instance.
   */
  instanceId?: string;
  /**
   * Location of the instance. Basic, Zonal, and High Scale use a zone
   * (`us-central1-a`). Enterprise and Regional use a region
   * (`us-central1`). Immutable — changing it replaces the instance.
   * `US-CENTRAL1-A` is accepted and normalized to `us-central1-a`.
   * @default "us-central1-a" (zonal tiers) or the stack's GCP region
   * (`GCP.Region`, profile region, `us-central1`) for regional tiers
   */
  location?: string;
  /**
   * Service tier. Immutable — changing it replaces the instance.
   * `STANDARD` is an alias for `BASIC_HDD`; `PREMIUM` for `BASIC_SSD`.
   * @default "BASIC_HDD"
   */
  tier?: file.InstanceTierEnum | (string & {});
  /**
   * File protocol for every share. Immutable.
   * @default "NFS_V3"
   */
  protocol?: file.InstanceProtocolEnum | (string & {});
  /**
   * Human-readable description (2048 characters or less).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * File shares. The API supports a single share. Omit to create
   * `share1` at the tier minimum capacity.
   */
  fileShares?: FileShareConfig[];
  /**
   * VPC networks. The API supports a single network. Immutable — changing
   * network, modes, connect mode, or reserved range replaces the instance.
   * @default [{ network: "default", modes: ["MODE_IPV4"] }]
   */
  networks?: NetworkConfig[];
  /**
   * Customer-managed KMS key for at-rest encryption
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Immutable.
   */
  kmsKeyName?: string;
  /**
   * Custom performance. Only for tiers that report
   * `customPerformanceSupported`.
   */
  performanceConfig?: PerformanceConfig;
  /**
   * Directory Services (LDAP) for `NFS_V4_1`. Immutable.
   */
  directoryServices?: DirectoryServicesConfig;
  /**
   * Block `instances.delete` until protection is cleared.
   * @default false
   */
  deletionProtectionEnabled?: boolean;
  /**
   * Reason recorded when deletion protection is enabled.
   */
  deletionProtectionReason?: string;
  /**
   * Replication configuration. Create-time only; new replicas set
   * `role: "STANDBY"`.
   */
  replication?: Replication;
  /**
   * Resource Manager tags (namespaced key to short value). Input-only and
   * immutable.
   */
  tags?: Record<string, string>;
};

export type Instance = Resource<
  "GCP.Filestore.Instance",
  InstanceProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/instances/{instance}`. */
    name: string;
    /** Instance id (last path segment). */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Location id (zone or region). */
    location: string;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Service tier. */
    tier: string;
    /** File protocol. */
    protocol: string | undefined;
    /** Server-reported state (`READY`, `CREATING`, …). */
    state: string | undefined;
    /** Extra status text, if any. */
    statusMessage: string | undefined;
    /** File shares currently configured. */
    fileShares: FileShareConfig[];
    /** VPC networks, including assigned `ipAddresses`. */
    networks: Array<
      NetworkConfig & {
        /** Assigned IPv4/IPv6 addresses. */
        ipAddresses: string[];
      }
    >;
    /** Customer-managed KMS key, if any. */
    kmsKeyName: string | undefined;
    /** Custom performance configuration currently applied. */
    performanceConfig: PerformanceConfig | undefined;
    /** Enforced performance limits. */
    performanceLimits: PerformanceLimits | undefined;
    /** Directory Services configuration. */
    directoryServices: DirectoryServicesConfig | undefined;
    /** Whether deletion protection is enabled. */
    deletionProtectionEnabled: boolean;
    /** Reason for deletion protection. */
    deletionProtectionReason: string | undefined;
    /** Whether the instance accepts `performanceConfig`. */
    customPerformanceSupported: boolean | undefined;
    /** Minimum capacity in GiB. */
    minCapacityGb: number | undefined;
    /** Maximum capacity in GiB. */
    maxCapacityGb: number | undefined;
    /** Capacity step size in GiB. */
    capacityStepSizeGb: number | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** Replication configuration currently applied. */
    replication: Replication | undefined;
    /** Reasons the instance is `SUSPENDED`, if any. */
    suspensionReasons: string[];
  },
  never,
  Providers
>;

/**
 * A Cloud Filestore instance (NFS file share).
 *
 * Changing `instanceId`, `location`, `tier`, `protocol`, `kmsKeyName`,
 * share `name`/`sourceBackup`, or network identity (network, modes,
 * connect mode, reserved range) replaces the instance. Description,
 * labels, share capacity, NFS export options, performance, and deletion
 * protection update in place.
 *
 * Provisioning a Basic HDD 1 TiB instance typically takes 5-10 minutes.
 *
 * ### Creating an Instance
 * **Example:** Generated name, Basic HDD 1 TiB
 * ```typescript
 * const nfs = yield* GCP.Filestore.Instance("Nfs", {});
 * ```
 *
 * **Example:** Explicit id, labels, and description
 * ```typescript
 * const nfs = yield* GCP.Filestore.Instance("Nfs", {
 *   instanceId: "app-nfs",
 *   location: "us-central1-a",
 *   tier: "BASIC_HDD",
 *   fileShares: [{ name: "share1", capacityGb: 1024 }],
 *   networks: [{ network: "default", modes: ["MODE_IPV4"] }],
 *   description: "app file share",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### NFS export options
 * **Example:** Restrict clients and enable root squash
 * ```typescript
 * const nfs = yield* GCP.Filestore.Instance("Nfs", {
 *   fileShares: [{
 *     name: "share1",
 *     capacityGb: 1024,
 *     nfsExportOptions: [{
 *       accessMode: "READ_WRITE",
 *       squashMode: "ROOT_SQUASH",
 *       ipRanges: ["10.0.0.0/8"],
 *     }],
 *   }],
 * });
 * ```
 *
 * @resource
 * @category Filestore
 */
export const Instance = Resource<Instance>("GCP.Filestore.Instance");

export class InstanceNotResolved extends Data.TaggedError(
  "GCP.Filestore.InstanceNotResolved",
)<{
  name: string;
}> {}

export class InstanceNotReady extends Data.TaggedError(
  "GCP.Filestore.InstanceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class InstanceFailed extends Data.TaggedError(
  "GCP.Filestore.InstanceFailed",
)<{
  name: string;
  state: string;
  statusMessage: string | undefined;
}> {}

export class InstanceStillExists extends Data.TaggedError(
  "GCP.Filestore.InstanceStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const canonicalizeTier = (tier: string | undefined) => {
  const value = (tier ?? DEFAULT_TIER).toUpperCase();
  if (value === "TIER_UNSPECIFIED") return DEFAULT_TIER;
  if (value === "STANDARD") return "BASIC_HDD";
  if (value === "PREMIUM") return "BASIC_SSD";
  return value;
};

const isRegionalTier = (tier: string | undefined) =>
  REGIONAL_TIERS.has(canonicalizeTier(tier));

const defaultLocationFor = (tier: string | undefined, region: string) =>
  isRegionalTier(tier) ? region : DEFAULT_ZONAL_LOCATION;

const normalizeLocation = (
  location: string | undefined,
  tier: string | undefined,
  region: string,
) => lastSegment(location ?? defaultLocationFor(tier, region)).toLowerCase();

const normalizeProtocol = (protocol: string | undefined) => {
  const value = (protocol ?? DEFAULT_PROTOCOL).toUpperCase();
  return value === "FILE_PROTOCOL_UNSPECIFIED" ? DEFAULT_PROTOCOL : value;
};

const normalizeConnectMode = (mode: string | undefined) => {
  const value = (mode ?? DEFAULT_CONNECT_MODE).toUpperCase();
  return value === "CONNECT_MODE_UNSPECIFIED" ? DEFAULT_CONNECT_MODE : value;
};

const defaultCapacityGb = (tier: string | undefined) => {
  const value = canonicalizeTier(tier);
  if (value === "BASIC_SSD") return 2560;
  if (value === "HIGH_SCALE_SSD") return 10240;
  return 1024;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `f${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "instance";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const resourceName = (project: string, location: string, instanceId: string) =>
  `projects/${project}/locations/${location}/instances/${instanceId}`;

const parseName = (name: string) => {
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
        : DEFAULT_ZONAL_LOCATION,
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

const asNumber = (value: string | number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const asIntString = (value: number | string | undefined): string | undefined =>
  value === undefined ? undefined : String(value);

const stringsOf = (
  values: ReadonlyArray<string | undefined> | null | undefined,
): string[] =>
  (values ?? []).filter((value): value is string => value !== undefined);

const networkId = (network: string | undefined) =>
  lastSegment(network ?? DEFAULT_NETWORK);

const modesOf = (
  modes: ReadonlyArray<string | undefined> | null | undefined,
): string[] => {
  const values = stringsOf(modes).map((mode) => mode.toUpperCase());
  return values.length > 0 ? values : [DEFAULT_MODE];
};

const modesKey = (
  modes: ReadonlyArray<string | undefined> | null | undefined,
) => [...modesOf(modes)].sort().join("\0");

const nfsOf = (
  options: file.NfsExportOptions | NfsExportOptions,
): NfsExportOptions => ({
  squashMode: options.squashMode,
  network: options.network,
  anonGid: asNumber(options.anonGid),
  ipRanges: options.ipRanges ? [...options.ipRanges] : undefined,
  accessMode: options.accessMode,
  anonUid: asNumber(options.anonUid),
});

const nfsKey = (options: NfsExportOptions) =>
  JSON.stringify({
    squashMode: (options.squashMode ?? "NO_ROOT_SQUASH").toUpperCase(),
    network: options.network ?? "",
    anonGid: options.anonGid ?? "",
    ipRanges: [...(options.ipRanges ?? [])].sort(),
    accessMode: (options.accessMode ?? "READ_WRITE").toUpperCase(),
    anonUid: options.anonUid ?? "",
  });

const shareOf = (
  share: file.FileShareConfig | FileShareConfig,
  tier: string | undefined,
): FileShareConfig => ({
  name: share.name ?? DEFAULT_SHARE_NAME,
  capacityGb: asNumber(share.capacityGb) ?? defaultCapacityGb(tier),
  nfsExportOptions: share.nfsExportOptions?.map(nfsOf),
  sourceBackup: share.sourceBackup,
  sourceBackupdrBackup: share.sourceBackupdrBackup,
});

const sharesOf = (
  shares: ReadonlyArray<file.FileShareConfig | FileShareConfig> | undefined,
  tier: string | undefined,
): FileShareConfig[] => {
  if (shares === undefined || shares.length === 0) {
    return [
      {
        name: DEFAULT_SHARE_NAME,
        capacityGb: defaultCapacityGb(tier),
      },
    ];
  }
  return shares.map((share) => shareOf(share, tier));
};

const shareIdentityKey = (share: FileShareConfig) =>
  JSON.stringify({
    name: share.name ?? DEFAULT_SHARE_NAME,
    sourceBackup: share.sourceBackup ?? "",
    sourceBackupdrBackup: share.sourceBackupdrBackup ?? "",
  });

const shareCapacity = (share: FileShareConfig) => share.capacityGb ?? 0;

const networkOf = (
  network: file.NetworkConfig | NetworkConfig,
): NetworkConfig & { ipAddresses: string[] } => ({
  network: network.network ?? DEFAULT_NETWORK,
  modes: modesOf(network.modes),
  reservedIpRange: network.reservedIpRange,
  connectMode: network.connectMode,
  pscConfig: network.pscConfig
    ? { endpointProject: network.pscConfig.endpointProject }
    : undefined,
  ipAddresses: "ipAddresses" in network ? stringsOf(network.ipAddresses) : [],
});

const networksOf = (
  networks: ReadonlyArray<file.NetworkConfig | NetworkConfig> | undefined,
): Array<NetworkConfig & { ipAddresses: string[] }> => {
  if (networks === undefined || networks.length === 0) {
    return [
      {
        network: DEFAULT_NETWORK,
        modes: [DEFAULT_MODE],
        ipAddresses: [],
      },
    ];
  }
  return networks.map(networkOf);
};

const networkIdentityKey = (
  network: NetworkConfig,
  options?: { includeReserved?: boolean },
) =>
  JSON.stringify({
    network: networkId(network.network),
    modes: modesKey(network.modes),
    connectMode: normalizeConnectMode(network.connectMode),
    reservedIpRange:
      options?.includeReserved === true ? (network.reservedIpRange ?? "") : "",
    endpointProject: network.pscConfig?.endpointProject ?? "",
  });

const performanceOf = (
  config: file.PerformanceConfig | PerformanceConfig | undefined,
): PerformanceConfig | undefined => {
  if (config === undefined) return undefined;
  const iopsPerTb = config.iopsPerTb
    ? { maxIopsPerTb: asNumber(config.iopsPerTb.maxIopsPerTb) }
    : undefined;
  const fixedIops = config.fixedIops
    ? { maxIops: asNumber(config.fixedIops.maxIops) }
    : undefined;
  if (iopsPerTb === undefined && fixedIops === undefined) return undefined;
  return { iopsPerTb, fixedIops };
};

const performanceKey = (
  config: file.PerformanceConfig | PerformanceConfig | undefined,
) =>
  JSON.stringify({
    iopsPerTb: performanceOf(config)?.iopsPerTb?.maxIopsPerTb ?? "",
    fixedIops: performanceOf(config)?.fixedIops?.maxIops ?? "",
  });

const ldapOf = (
  ldap: file.LdapConfig | LdapConfig | undefined,
): LdapConfig | undefined => {
  if (ldap === undefined) return undefined;
  return {
    servers: ldap.servers ? [...ldap.servers] : undefined,
    domain: ldap.domain,
    groupsOu: ldap.groupsOu,
    usersOu: ldap.usersOu,
  };
};

const directoryOf = (
  config: file.DirectoryServicesConfig | DirectoryServicesConfig | undefined,
): DirectoryServicesConfig | undefined => {
  if (config === undefined) return undefined;
  const ldap = ldapOf(config.ldap);
  if (ldap === undefined) return undefined;
  return { ldap };
};

const directoryKey = (
  config: file.DirectoryServicesConfig | DirectoryServicesConfig | undefined,
) =>
  JSON.stringify({
    servers: [...(directoryOf(config)?.ldap?.servers ?? [])].sort(),
    domain: directoryOf(config)?.ldap?.domain ?? "",
    groupsOu: directoryOf(config)?.ldap?.groupsOu ?? "",
    usersOu: directoryOf(config)?.ldap?.usersOu ?? "",
  });

const replicationOf = (
  config: file.Replication | Replication | undefined,
): Replication | undefined => {
  if (config === undefined) return undefined;
  return {
    role: config.role,
    replicas: config.replicas?.map((replica) => ({
      peerInstance: replica.peerInstance,
    })),
  };
};

const replicationKey = (config: file.Replication | Replication | undefined) =>
  JSON.stringify({
    role: (replicationOf(config)?.role ?? "").toUpperCase(),
    peers: (replicationOf(config)?.replicas ?? [])
      .map((replica) => replica.peerInstance ?? "")
      .sort(),
  });

const limitsOf = (
  limits: file.PerformanceLimits | undefined,
): PerformanceLimits | undefined => {
  if (limits === undefined) return undefined;
  return {
    maxReadIops: asNumber(limits.maxReadIops),
    maxReadThroughputBps: asNumber(limits.maxReadThroughputBps),
    maxIops: asNumber(limits.maxIops),
    maxWriteIops: asNumber(limits.maxWriteIops),
    maxWriteThroughputBps: asNumber(limits.maxWriteThroughputBps),
  };
};

const toApiNfs = (options: NfsExportOptions): file.NfsExportOptions => ({
  squashMode: options.squashMode,
  network: options.network,
  anonGid: asIntString(options.anonGid),
  ipRanges: options.ipRanges,
  accessMode: options.accessMode,
  anonUid: asIntString(options.anonUid),
});

const toApiShare = (share: FileShareConfig): file.FileShareConfig => ({
  name: share.name,
  capacityGb: asIntString(share.capacityGb),
  nfsExportOptions: share.nfsExportOptions?.map(toApiNfs),
  sourceBackup: share.sourceBackup,
  sourceBackupdrBackup: share.sourceBackupdrBackup,
});

const toApiNetwork = (network: NetworkConfig): file.NetworkConfig => ({
  network: network.network,
  modes: network.modes,
  reservedIpRange: network.reservedIpRange,
  connectMode: network.connectMode,
  pscConfig: network.pscConfig,
});

const toApiPerformance = (
  config: PerformanceConfig | undefined,
): file.PerformanceConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    iopsPerTb:
      config.iopsPerTb === undefined
        ? undefined
        : { maxIopsPerTb: asIntString(config.iopsPerTb.maxIopsPerTb) },
    fixedIops:
      config.fixedIops === undefined
        ? undefined
        : { maxIops: asIntString(config.fixedIops.maxIops) },
  };
};

const toAttrs = (instance: file.Instance, project: string) => {
  const name = instance.name ?? "";
  const parsed = parseName(name);
  const tier = canonicalizeTier(instance.tier);
  return {
    name,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    location: parsed.location,
    description: instance.description,
    labels: userLabels(instance.labels),
    tier,
    protocol: instance.protocol,
    state: instance.state,
    statusMessage: instance.statusMessage,
    fileShares: sharesOf(instance.fileShares, tier),
    networks: networksOf(instance.networks),
    kmsKeyName: instance.kmsKeyName,
    performanceConfig: performanceOf(instance.performanceConfig),
    performanceLimits: limitsOf(instance.performanceLimits),
    directoryServices: directoryOf(instance.directoryServices),
    deletionProtectionEnabled: instance.deletionProtectionEnabled === true,
    deletionProtectionReason: instance.deletionProtectionReason,
    customPerformanceSupported: instance.customPerformanceSupported,
    minCapacityGb: asNumber(instance.minCapacityGb),
    maxCapacityGb: asNumber(instance.maxCapacityGb),
    capacityStepSizeGb: asNumber(instance.capacityStepSizeGb),
    etag: instance.etag,
    createTime: instance.createTime,
    replication: replicationOf(instance.replication),
    suspensionReasons: stringsOf(instance.suspensionReasons),
  };
};

const isPlaceholder = (instance: file.Instance) => {
  const name = instance.name ?? "";
  return (
    name.length === 0 ||
    name.endsWith("/instances/-") ||
    name.endsWith("/instances/")
  );
};

const getByName = (name: string) =>
  file
    .getProjectsLocationsInstances({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Wait on a Filestore instance long-running operation (5–20 minutes).
 * `ALREADY_EXISTS` (a create race) counts as success; so does `NOT_FOUND`
 * when `notFoundOk` (deletes). Returns the final operation.
 */
const waitForOperation = (
  operation: file.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.suspend(() => {
    let latest = operation;
    return waitForLongRunningOperation(
      operation,
      (name) => {
        const get = file.getProjectsLocationsOperations({ name }).pipe(
          Effect.tap((current) =>
            Effect.sync(() => {
              latest = current;
            }),
          ),
        );
        const observe: Effect.Effect<
          file.Operation,
          file.GetProjectsLocationsOperationsError,
          GcpOpContext
        > =
          options?.notFoundOk === true
            ? get.pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.succeed<file.Operation>({ name, done: true }),
                ),
              )
            : get.pipe(
                // A just-returned operation can briefly 404 on read.
                Effect.retry({
                  while: (error) => error._tag === "NotFound",
                  times: 5,
                  schedule: Schedule.exponential("250 millis"),
                }),
              );
        return observe;
      },
      { budget: "30 minutes", interval: "10 seconds" },
    ).pipe(
      Effect.map(() => latest),
      // google.rpc.Code ALREADY_EXISTS = 6, NOT_FOUND = 5.
      Effect.catchTag("GCP.OperationFailed", (error) =>
        error.code === 6 || (options?.notFoundOk === true && error.code === 5)
          ? Effect.succeed(latest)
          : Effect.fail(error),
      ),
    );
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(new InstanceNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Filestore.InstanceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (instance): instance is file.Instance => instance !== undefined,
      () => new InstanceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (instance) => (instance.state ?? "") !== "ERROR",
      (instance) =>
        new InstanceFailed({
          name,
          state: instance.state ?? "ERROR",
          statusMessage: instance.statusMessage,
        }),
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
        error._tag === "GCP.Filestore.InstanceNotReady" ||
        error._tag === "GCP.Filestore.InstanceNotResolved",
      // Instances take 5–20 minutes to provision.
      times: 120,
      schedule: Schedule.spaced("10 seconds"),
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
      while: (error) => error._tag === "GCP.Filestore.InstanceStillExists",
      // Instance deletion takes several minutes.
      times: 120,
      schedule: Schedule.spaced("10 seconds"),
    }),
  );

const desiredShares = (news: InstanceProps, tier: string): FileShareConfig[] =>
  sharesOf(news.fileShares, tier);

const desiredNetworks = (news: InstanceProps) => networksOf(news.networks);

const toCreateBody = (
  news: InstanceProps,
  desiredLabels: Record<string, string>,
  tier: string,
  protocol: string,
): file.Instance => ({
  description: news.description,
  labels: desiredLabels,
  tier,
  protocol,
  fileShares: desiredShares(news, tier).map(toApiShare),
  networks: desiredNetworks(news).map(toApiNetwork),
  kmsKeyName: news.kmsKeyName,
  performanceConfig: toApiPerformance(news.performanceConfig),
  directoryServices: news.directoryServices,
  deletionProtectionEnabled: news.deletionProtectionEnabled === true,
  deletionProtectionReason: news.deletionProtectionReason,
  replication: news.replication,
  tags: news.tags,
});

const sharesIdentityChanged = (
  observed: FileShareConfig[],
  desired: FileShareConfig[],
) =>
  observed.length !== desired.length ||
  observed.some(
    (share, index) =>
      shareIdentityKey(share) !== shareIdentityKey(desired[index]!),
  );

const sharesMutableChanged = (
  observed: FileShareConfig[],
  desired: FileShareConfig[],
) =>
  observed.length !== desired.length ||
  observed.some((share, index) => {
    const next = desired[index];
    if (next === undefined) return true;
    if (shareCapacity(share) !== shareCapacity(next)) return true;
    if (next.nfsExportOptions === undefined) return false;
    return (
      (share.nfsExportOptions ?? []).map(nfsKey).join("\0") !==
      next.nfsExportOptions.map(nfsKey).join("\0")
    );
  });

const sharesForPatch = (
  desired: FileShareConfig[],
  observed: FileShareConfig[],
): FileShareConfig[] =>
  desired.map((share, index) => ({
    ...share,
    nfsExportOptions:
      share.nfsExportOptions ?? observed[index]?.nfsExportOptions,
  }));

const networksIdentityChanged = (
  observed: Array<NetworkConfig>,
  desired: Array<NetworkConfig>,
) => {
  if (observed.length !== desired.length) return true;
  return observed.some((network, index) => {
    const next = desired[index]!;
    const includeReserved = next.reservedIpRange !== undefined;
    return (
      networkIdentityKey(network, { includeReserved }) !==
      networkIdentityKey(next, { includeReserved })
    );
  });
};

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["name", "instanceId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.instanceId ?? output?.instanceId;
      const nextId = news.instanceId ?? previousId;
      const previousTier = canonicalizeTier(olds?.tier ?? output?.tier);
      const nextTier = canonicalizeTier(news.tier ?? output?.tier);
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        previousTier,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        nextTier,
        env.region,
      );
      const previousProtocol = normalizeProtocol(
        olds?.protocol ?? output?.protocol,
      );
      const nextProtocol = normalizeProtocol(news.protocol ?? output?.protocol);
      const previousKey = olds?.kmsKeyName ?? output?.kmsKeyName ?? "";
      const nextKey = news.kmsKeyName ?? previousKey;
      const previousShares = sharesOf(
        olds?.fileShares ?? output?.fileShares,
        previousTier,
      );
      const nextShares = sharesOf(
        news.fileShares ?? olds?.fileShares ?? output?.fileShares,
        nextTier,
      );
      const previousNetworks = networksOf(olds?.networks ?? output?.networks);
      const nextNetworks = networksOf(
        news.networks ?? olds?.networks ?? output?.networks,
      );
      const previousDirectory = directoryKey(
        olds?.directoryServices ?? output?.directoryServices,
      );
      const nextDirectory = directoryKey(
        news.directoryServices ??
          olds?.directoryServices ??
          output?.directoryServices,
      );
      const previousReplication = replicationKey(
        olds?.replication ?? output?.replication,
      );
      const nextReplication = replicationKey(
        news.replication ?? olds?.replication ?? output?.replication,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousTier !== nextTier ||
        previousProtocol !== nextProtocol ||
        previousKey !== nextKey ||
        sharesIdentityChanged(previousShares, nextShares) ||
        networksIdentityChanged(previousNetworks, nextNetworks) ||
        previousDirectory !== nextDirectory ||
        previousReplication !== nextReplication;

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
      const tier = canonicalizeTier(olds?.tier ?? output?.tier);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        tier,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, instanceId);
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
        return yield* file.listProjectsLocationsInstances
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
            Stream.map((instance) => toAttrs(instance, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = yield* toId(id, news.instanceId, output?.instanceId);
      const tier = canonicalizeTier(news.tier);
      const location = normalizeLocation(
        news.location ?? output?.location,
        tier,
        env.region,
      );
      const protocol = normalizeProtocol(news.protocol);
      const name = resourceName(env.project, location, instanceId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredProtection = news.deletionProtectionEnabled === true;

      let current = yield* getByName(output?.name ?? name);

      if (current !== undefined && (current.state ?? "") === "DELETING") {
        yield* waitUntilGone(current.name ?? name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* file
          .createProjectsLocationsInstances({
            parent: `projects/${env.project}/locations/${location}`,
            instanceId,
            body: toCreateBody(news, desiredLabels, tier, protocol),
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

      if ((current.state ?? "") === "ERROR") {
        return yield* new InstanceFailed({
          name,
          state: current.state ?? "ERROR",
          statusMessage: current.statusMessage,
        });
      }

      if ((current.state ?? "") !== "READY") {
        current = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const protectionChanged =
        (current.deletionProtectionEnabled === true) !== desiredProtection;
      const reasonChanged =
        (current.deletionProtectionReason ?? "") !==
        (news.deletionProtectionReason ?? "");
      const observedShares = sharesOf(current.fileShares, tier);
      const nextShares = desiredShares(news, tier);
      const fileSharesChanged =
        news.fileShares !== undefined &&
        sharesMutableChanged(observedShares, nextShares);
      const performanceChanged =
        news.performanceConfig !== undefined &&
        performanceKey(current.performanceConfig) !==
          performanceKey(news.performanceConfig);

      if (
        labelsChanged ||
        descriptionChanged ||
        protectionChanged ||
        reasonChanged ||
        fileSharesChanged ||
        performanceChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          fileSharesChanged ? "file_shares" : undefined,
          performanceChanged ? "performance_config" : undefined,
          protectionChanged ? "deletion_protection_enabled" : undefined,
          reasonChanged ? "deletion_protection_reason" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* file.patchProjectsLocationsInstances({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            labels: desiredLabels,
            description: news.description,
            fileShares: sharesForPatch(nextShares, observedShares).map(
              toApiShare,
            ),
            performanceConfig: toApiPerformance(news.performanceConfig),
            deletionProtectionEnabled: desiredProtection,
            deletionProtectionReason: news.deletionProtectionReason,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;

      if (existing.deletionProtectionEnabled === true) {
        const patched = yield* file
          .patchProjectsLocationsInstances({
            name: output.name,
            updateMask:
              "deletion_protection_enabled,deletion_protection_reason",
            body: {
              name: output.name,
              deletionProtectionEnabled: false,
              deletionProtectionReason: "",
            },
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (patched !== undefined) {
          yield* waitForOperation(patched, { notFoundOk: true });
        }
      }

      const operation = yield* file
        .deleteProjectsLocationsInstances({
          name: output.name,
          force: true,
        })
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
