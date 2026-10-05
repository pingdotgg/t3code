import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
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
import { OperationFailed } from "../Operation.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { MAX_POLLS, waitForOperation } from "./internal.ts";

const DEFAULT_CLUSTER_TYPE = "SINGLE_NODE";
const DEFAULT_MACHINE_TYPE = "e2-standard-2";
const DEFAULT_BOOT_DISK_GB = 30;
const DEFAULT_BOOT_DISK_TYPE = "pd-standard";
const DEFAULT_MASTER_INSTANCES = 1;
const DEFAULT_STANDARD_WORKERS = 2;
const MAX_NAME_LENGTH = 51;

const LIST_REGIONS = [
  "us-central1",
  "us-east1",
  "us-east4",
  "us-west1",
  "europe-west1",
  "asia-east1",
] as const;

export type InitializationAction = {
  /** Cloud Storage URI of the executable (`gs://...`). */
  executableFile: string;
  /**
   * How long the executable may run (JSON Duration, e.g. `"10m"`).
   * @default "10m"
   */
  executionTimeout?: string;
};

export type ClusterProps = {
  /**
   * Cluster id unique within the project. If omitted, a unique RFC1035
   * name is generated from the stack, stage, and logical id. Must start
   * with a lowercase letter, contain only lowercase letters, numbers, and
   * hyphens, and not end with a hyphen (up to 51 characters). Immutable —
   * changing it replaces the cluster.
   */
  clusterName?: string;
  /**
   * Dataproc region (`us-central1`, `us-east1`, …). Immutable — changing
   * it replaces the cluster. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  region?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Cluster topology. `SINGLE_NODE` is a 1-VM cluster (no workers).
   * Immutable — changing it replaces the cluster.
   * @default "SINGLE_NODE"
   */
  clusterType?: dataproc.ClusterConfigClusterTypeEnum | (string & {});
  /**
   * Dataproc image version (`2.2`, `2.2-debian12`, …). Prefix matches
   * the server-resolved version. Immutable — changing it replaces the
   * cluster.
   */
  imageVersion?: string;
  /**
   * Optional components to activate (`JUPYTER`, `ZEPPELIN`, `TRINO`, …).
   * Immutable — changing them replaces the cluster.
   */
  optionalComponents?: dataproc.SoftwareConfigOptionalComponentsItemEnumList;
  /**
   * Daemon properties (`core:hadoop.tmp.dir`, `spark:spark.executor.memory`,
   * …). Immutable — changing them replaces the cluster.
   */
  properties?: Record<string, string>;
  /**
   * Compute Engine zone (`us-central1-a`). Immutable. If omitted,
   * Dataproc picks a zone in `region`.
   */
  zone?: string;
  /**
   * VPC network name or URI. Cannot be set with `subnetwork`. Immutable.
   */
  network?: string;
  /**
   * Subnetwork name or URI. Cannot be set with `network`. Immutable.
   */
  subnetwork?: string;
  /**
   * Restrict VMs to internal IPs. Immutable. Defaults to `false` so the
   * cluster can reach Google APIs without Private Google Access.
   * @default false
   */
  internalIpOnly?: boolean;
  /**
   * VM service account email. Immutable.
   */
  serviceAccount?: string;
  /**
   * Extra OAuth scopes for cluster VMs. Immutable.
   */
  serviceAccountScopes?: string[];
  /**
   * Network tags applied to every VM. Immutable.
   */
  tags?: string[];
  /**
   * Compute Engine metadata entries on every VM. Immutable.
   */
  metadata?: Record<string, string>;
  /**
   * Master instances. `1` for standard or single-node, `3` for HA.
   * Immutable — changing it replaces the cluster.
   * @default 1
   */
  masterNumInstances?: number;
  /**
   * Master machine type short name or URI.
   * @default "e2-standard-2"
   */
  masterMachineType?: string;
  /**
   * Master boot disk size in GB.
   * @default 30
   */
  masterBootDiskSizeGb?: number;
  /**
   * Master boot disk type (`pd-standard`, `pd-balanced`, `pd-ssd`).
   * @default "pd-standard"
   */
  masterBootDiskType?: string;
  /**
   * Primary worker count. `0` for single-node. Resizes in place.
   * @default 0
   */
  workerNumInstances?: number;
  /**
   * Primary worker machine type short name or URI. Immutable.
   * @default "e2-standard-2"
   */
  workerMachineType?: string;
  /**
   * Primary worker boot disk size in GB. Immutable.
   * @default 30
   */
  workerBootDiskSizeGb?: number;
  /**
   * Primary worker boot disk type. Immutable.
   * @default "pd-standard"
   */
  workerBootDiskType?: string;
  /**
   * Secondary (preemptible or non-preemptible) worker count. Resizes in
   * place.
   */
  secondaryWorkerNumInstances?: number;
  /**
   * Secondary worker machine type. Immutable.
   */
  secondaryWorkerMachineType?: string;
  /**
   * Secondary worker boot disk size in GB. Immutable.
   */
  secondaryWorkerBootDiskSizeGb?: number;
  /**
   * Secondary worker preemptibility (`PREEMPTIBLE`, `SPOT`,
   * `NON_PREEMPTIBLE`). Immutable.
   */
  secondaryWorkerPreemptibility?:
    | dataproc.InstanceGroupConfigPreemptibilityEnum
    | (string & {});
  /**
   * Autoscaling policy resource name. Updated in place.
   */
  autoscalingPolicyUri?: string;
  /**
   * Idle TTL before the cluster is deleted (JSON Duration). Immutable.
   */
  idleDeleteTtl?: string;
  /**
   * Lifetime TTL before the cluster is deleted (JSON Duration). Immutable.
   */
  autoDeleteTtl?: string;
  /**
   * Staging bucket name (not a `gs://` URI). Immutable.
   */
  configBucket?: string;
  /**
   * Temp bucket name (not a `gs://` URI). Immutable.
   */
  tempBucket?: string;
  /**
   * Enable Component Gateway HTTP port access.
   * @default false
   */
  enableHttpPortAccess?: boolean;
  /**
   * Customer-managed KMS key for PD and job-argument encryption.
   * Immutable.
   */
  kmsKey?: string;
  /**
   * Scripts to run on each node after config completes. Immutable.
   */
  initializationActions?: InitializationAction[];
};

export type Cluster = Resource<
  "GCP.Dataproc.Cluster",
  ClusterProps,
  {
    /** Synthetic name `projects/{project}/regions/{region}/clusters/{cluster}`. */
    name: string;
    /** Cluster id. */
    clusterName: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    region: string;
    /** Server-assigned cluster UUID. */
    clusterUuid: string | undefined;
    /** Server-reported state (`RUNNING`, `CREATING`, …). */
    state: string | undefined;
    /** Extra status text, if any. */
    statusDetail: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Cluster topology (`SINGLE_NODE`, `STANDARD`, …). */
    clusterType: string;
    /** Resolved image version. */
    imageVersion: string | undefined;
    /** Provisioned zone. */
    zone: string | undefined;
    /** VPC network. */
    network: string | undefined;
    /** Subnetwork. */
    subnetwork: string | undefined;
    /** Master instance count. */
    masterNumInstances: number | undefined;
    /** Master machine type short name. */
    masterMachineType: string | undefined;
    /** Master boot disk size in GB. */
    masterBootDiskSizeGb: number | undefined;
    /** Master boot disk type. */
    masterBootDiskType: string | undefined;
    /** Primary worker count. */
    workerNumInstances: number | undefined;
    /** Primary worker machine type short name. */
    workerMachineType: string | undefined;
    /** Primary worker boot disk size in GB. */
    workerBootDiskSizeGb: number | undefined;
    /** Primary worker boot disk type. */
    workerBootDiskType: string | undefined;
    /** Whether VMs use internal IPs only. */
    internalIpOnly: boolean | undefined;
    /** VM service account email. */
    serviceAccount: string | undefined;
    /** Secondary worker count. */
    secondaryWorkerNumInstances: number | undefined;
    /** Autoscaling policy resource name. */
    autoscalingPolicyUri: string | undefined;
    /** Staging bucket name. */
    configBucket: string | undefined;
    /** Temp bucket name. */
    tempBucket: string | undefined;
    /** Component Gateway HTTP ports, when enabled. */
    httpPorts: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Dataproc cluster of Compute Engine VMs.
 *
 * Defaults to a single-node cluster (`e2-standard-2`, 30 GB boot disk) so
 * a bare `Cluster("Spark", {})` stays cheap. Set `clusterType: "STANDARD"`
 * and `workerNumInstances` for a multi-VM cluster.
 *
 * Changing `clusterName`, `region`, topology, image, machine types, disks,
 * network, zone, or software config replaces the cluster. Labels, primary
 * worker count, secondary worker count, and the autoscaling policy URI
 * update in place.
 *
 * Provisioning typically takes several minutes.
 *
 * ### Creating a Cluster
 * **Example:** Generated name, single-node
 * ```typescript
 * const cluster = yield* GCP.Dataproc.Cluster("Spark", {});
 * ```
 *
 * **Example:** Explicit id, labels, and machine type
 * ```typescript
 * const cluster = yield* GCP.Dataproc.Cluster("Spark", {
 *   clusterName: "app-spark",
 *   region: "us-central1",
 *   clusterType: "SINGLE_NODE",
 *   masterMachineType: "e2-standard-2",
 *   masterBootDiskSizeGb: 30,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Standard topology
 * **Example:** One master and two workers
 * ```typescript
 * const cluster = yield* GCP.Dataproc.Cluster("Spark", {
 *   clusterType: "STANDARD",
 *   workerNumInstances: 2,
 *   workerMachineType: "e2-standard-2",
 *   workerBootDiskSizeGb: 30,
 * });
 * ```
 *
 * @resource
 * @category Dataproc
 */
export const Cluster = Resource<Cluster>("GCP.Dataproc.Cluster");

export class ClusterNotResolved extends Data.TaggedError(
  "GCP.Dataproc.ClusterNotResolved",
)<{
  clusterName: string;
  region: string;
}> {}

export class ClusterFailed extends Data.TaggedError(
  "GCP.Dataproc.ClusterFailed",
)<{
  clusterName: string;
  state: string | undefined;
  detail: string | undefined;
}> {}

export class ClusterNotReady extends Data.TaggedError(
  "GCP.Dataproc.ClusterNotReady",
)<{
  clusterName: string;
  state: string | undefined;
}> {}

export class ClusterStillExists extends Data.TaggedError(
  "GCP.Dataproc.ClusterStillExists",
)<{
  clusterName: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, fallback: string) =>
  lastSegment(region ?? fallback).toLowerCase();

const linkKey = (value: string | undefined) =>
  value === undefined || value === "" ? "" : lastSegment(value).toLowerCase();

const normalizeClusterType = (
  type: string | undefined,
  workerNumInstances: number | undefined,
) => {
  const value = (type ?? "").toUpperCase();
  if (
    value !== "" &&
    value !== "CLUSTER_TYPE_UNSPECIFIED" &&
    value !== "UNSPECIFIED"
  ) {
    return value;
  }
  if (workerNumInstances === 0) return "SINGLE_NODE";
  return DEFAULT_CLUSTER_TYPE;
};

const desiredClusterType = (news: ClusterProps) =>
  normalizeClusterType(news.clusterType, news.workerNumInstances);

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "cluster";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const resourceName = (project: string, region: string, clusterName: string) =>
  `projects/${project}/regions/${region}/clusters/${clusterName}`;

const parseName = (name: string, fallbackRegion: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const clustersAt = parts.lastIndexOf("clusters");
  const regionsAt = parts.lastIndexOf("regions");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    region:
      regionsAt >= 0 && parts[regionsAt + 1]
        ? parts[regionsAt + 1]!
        : fallbackRegion,
    clusterName:
      clustersAt >= 0 && parts[clustersAt + 1]
        ? parts[clustersAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, clusterName: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      clusterName ??
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

const sortedKey = (values: readonly string[] | undefined) =>
  JSON.stringify(
    [...(values ?? [])].map((value) => value.toUpperCase()).sort(),
  );

const propertiesKey = (
  properties: Record<string, string | undefined> | null | undefined,
) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(configsOf(properties)).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  );

const metadataKey = (
  metadata: Record<string, string | undefined> | null | undefined,
) => propertiesKey(metadata);

const initKey = (actions: InitializationAction[] | undefined) =>
  JSON.stringify(
    (actions ?? []).map((action) => ({
      executableFile: action.executableFile,
      executionTimeout: action.executionTimeout ?? "",
    })),
  );

const imageMatches = (
  desired: string | undefined,
  observed: string | undefined,
) => {
  if (desired === undefined || desired === "") return true;
  if (observed === undefined || observed === "") return false;
  const next = desired.toLowerCase();
  const current = observed.toLowerCase();
  return (
    current === next ||
    current.startsWith(`${next}-`) ||
    current.startsWith(`${next}.`)
  );
};

const groupNum = (group: dataproc.InstanceGroupConfig | undefined) =>
  group?.numInstances;

const toAttrs = (
  cluster: dataproc.Cluster,
  project: string,
  region: string,
) => {
  const clusterName = cluster.clusterName ?? "";
  const config = cluster.config;
  const master = config?.masterConfig;
  const worker = config?.workerConfig;
  const secondary = config?.secondaryWorkerConfig;
  return {
    name: resourceName(project, region, clusterName),
    clusterName,
    project: cluster.projectId || project,
    region,
    clusterUuid: cluster.clusterUuid,
    state: cluster.status?.state,
    statusDetail: cluster.status?.detail,
    labels: userLabels(cluster.labels),
    clusterType: normalizeClusterType(
      config?.clusterType,
      worker?.numInstances,
    ),
    imageVersion: config?.softwareConfig?.imageVersion,
    zone: config?.gceClusterConfig?.zoneUri
      ? lastSegment(config.gceClusterConfig.zoneUri)
      : undefined,
    network: config?.gceClusterConfig?.networkUri
      ? lastSegment(config.gceClusterConfig.networkUri)
      : undefined,
    subnetwork: config?.gceClusterConfig?.subnetworkUri
      ? lastSegment(config.gceClusterConfig.subnetworkUri)
      : undefined,
    masterNumInstances: master?.numInstances,
    masterMachineType: master?.machineTypeUri
      ? lastSegment(master.machineTypeUri)
      : undefined,
    masterBootDiskSizeGb: master?.diskConfig?.bootDiskSizeGb,
    masterBootDiskType: master?.diskConfig?.bootDiskType,
    workerNumInstances: worker?.numInstances,
    workerMachineType: worker?.machineTypeUri
      ? lastSegment(worker.machineTypeUri)
      : undefined,
    workerBootDiskSizeGb: worker?.diskConfig?.bootDiskSizeGb,
    workerBootDiskType: worker?.diskConfig?.bootDiskType,
    internalIpOnly: config?.gceClusterConfig?.internalIpOnly,
    serviceAccount: config?.gceClusterConfig?.serviceAccount,
    secondaryWorkerNumInstances: secondary?.numInstances,
    autoscalingPolicyUri: config?.autoscalingConfig?.policyUri,
    configBucket: config?.configBucket,
    tempBucket: config?.tempBucket,
    httpPorts: configsOf(config?.endpointConfig?.httpPorts),
  };
};

const getById = (projectId: string, region: string, clusterName: string) =>
  dataproc
    .getProjectsRegionsClusters({ projectId, region, clusterName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (
  projectId: string,
  region: string,
  clusterName: string,
) =>
  getById(projectId, region, clusterName).pipe(
    Effect.flatMap((cluster) =>
      cluster
        ? Effect.succeed(cluster)
        : Effect.fail(new ClusterNotResolved({ clusterName, region })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataproc.ClusterNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const terminalError = (state: string | undefined) =>
  state === "ERROR" || state === "ERROR_DUE_TO_UPDATE";

const waitUntilRunning = (
  projectId: string,
  region: string,
  clusterName: string,
) =>
  getById(projectId, region, clusterName).pipe(
    Effect.filterOrFail(
      (cluster): cluster is dataproc.Cluster => cluster !== undefined,
      () => new ClusterNotResolved({ clusterName, region }),
    ),
    Effect.filterOrFail(
      (cluster) => !terminalError(cluster.status?.state),
      (cluster) =>
        new ClusterFailed({
          clusterName,
          state: cluster.status?.state,
          detail: cluster.status?.detail,
        }),
    ),
    Effect.filterOrFail(
      (cluster) => (cluster.status?.state ?? "") === "RUNNING",
      (cluster) =>
        new ClusterNotReady({
          clusterName,
          state: cluster.status?.state,
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Dataproc.ClusterNotReady" ||
        error._tag === "GCP.Dataproc.ClusterNotResolved",
      times: MAX_POLLS,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const waitUntilGone = (
  projectId: string,
  region: string,
  clusterName: string,
) =>
  getById(projectId, region, clusterName).pipe(
    Effect.flatMap((cluster) =>
      cluster === undefined
        ? Effect.void
        : Effect.fail(new ClusterStillExists({ clusterName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataproc.ClusterStillExists",
      times: MAX_POLLS,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const deleteCluster = (
  projectId: string,
  region: string,
  clusterName: string,
) =>
  Effect.gen(function* () {
    const operation = yield* dataproc
      .deleteProjectsRegionsClusters({ projectId, region, clusterName })
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
    yield* waitUntilGone(projectId, region, clusterName);
  });

/**
 * A create operation that fails because the VPC subnet is transiently busy
 * (`The resource '.../subnetworks/default' is not ready`, raised while other
 * operations mutate the shared subnet). LRO errors carry only a code and a
 * message, so the message is the only discriminator.
 */
const isSubnetNotReady = (error: { readonly _tag: string }) =>
  error instanceof OperationFailed &&
  error.message.includes("/subnetworks/") &&
  error.message.includes("is not ready");

/**
 * Create the cluster and wait for the create operation. A create that fails
 * on a busy subnet leaves the cluster in `ERROR`; it is deleted and the
 * create retried.
 */
const createCluster = (
  projectId: string,
  region: string,
  clusterName: string,
  body: dataproc.Cluster,
) =>
  Effect.gen(function* () {
    const existing = yield* getById(projectId, region, clusterName);
    if (existing !== undefined && terminalError(existing.status?.state)) {
      yield* deleteCluster(projectId, region, clusterName);
    }
    const created = yield* dataproc
      .createProjectsRegionsClusters({ projectId, region, body })
      .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
    if (created !== undefined) {
      yield* waitForOperation(created);
    }
  }).pipe(
    Effect.retry({
      while: isSubnetNotReady,
      times: 6,
      schedule: Schedule.spaced("30 seconds"),
    }),
  );

const instanceGroup = (options: {
  numInstances?: number;
  machineType?: string;
  bootDiskSizeGb?: number;
  bootDiskType?: string;
  preemptibility?:
    | dataproc.InstanceGroupConfigPreemptibilityEnum
    | (string & {});
}): dataproc.InstanceGroupConfig | undefined => {
  const group: dataproc.InstanceGroupConfig = {};
  if (options.numInstances !== undefined) {
    group.numInstances = options.numInstances;
  }
  if (options.machineType !== undefined) {
    group.machineTypeUri = options.machineType;
  }
  const disk: dataproc.DiskConfig = {};
  if (options.bootDiskSizeGb !== undefined) {
    disk.bootDiskSizeGb = options.bootDiskSizeGb;
  }
  if (options.bootDiskType !== undefined) {
    disk.bootDiskType = options.bootDiskType;
  }
  if (Object.keys(disk).length > 0) {
    group.diskConfig = disk;
  }
  if (options.preemptibility !== undefined) {
    group.preemptibility = options.preemptibility;
  }
  return Object.keys(group).length > 0 ? group : undefined;
};

const toCreateBody = (
  news: ClusterProps,
  projectId: string,
  clusterName: string,
  desiredLabels: Record<string, string>,
): dataproc.Cluster => {
  const clusterType = desiredClusterType(news);
  const singleNode = clusterType === "SINGLE_NODE";
  const workerNum =
    news.workerNumInstances ?? (singleNode ? 0 : DEFAULT_STANDARD_WORKERS);
  const masterNum = news.masterNumInstances ?? DEFAULT_MASTER_INSTANCES;
  const masterMachine = news.masterMachineType ?? DEFAULT_MACHINE_TYPE;
  const workerMachine =
    news.workerMachineType ?? news.masterMachineType ?? DEFAULT_MACHINE_TYPE;
  const masterDiskGb = news.masterBootDiskSizeGb ?? DEFAULT_BOOT_DISK_GB;
  const workerDiskGb =
    news.workerBootDiskSizeGb ??
    news.masterBootDiskSizeGb ??
    DEFAULT_BOOT_DISK_GB;
  const masterDiskType = news.masterBootDiskType ?? DEFAULT_BOOT_DISK_TYPE;
  const workerDiskType =
    news.workerBootDiskType ??
    news.masterBootDiskType ??
    DEFAULT_BOOT_DISK_TYPE;

  const gce: dataproc.GceClusterConfig = {};
  if (news.zone !== undefined) gce.zoneUri = news.zone;
  if (news.network !== undefined) gce.networkUri = news.network;
  if (news.subnetwork !== undefined) gce.subnetworkUri = news.subnetwork;
  gce.internalIpOnly = news.internalIpOnly === true;
  if (news.serviceAccount !== undefined)
    gce.serviceAccount = news.serviceAccount;
  if (news.serviceAccountScopes !== undefined) {
    gce.serviceAccountScopes = news.serviceAccountScopes;
  }
  if (news.tags !== undefined) gce.tags = news.tags;
  if (news.metadata !== undefined) gce.metadata = news.metadata;

  const software: dataproc.SoftwareConfig = {};
  if (news.imageVersion !== undefined)
    software.imageVersion = news.imageVersion;
  if (news.optionalComponents !== undefined) {
    software.optionalComponents = news.optionalComponents;
  }
  if (news.properties !== undefined) software.properties = news.properties;

  const lifecycle: dataproc.LifecycleConfig = {};
  if (news.idleDeleteTtl !== undefined)
    lifecycle.idleDeleteTtl = news.idleDeleteTtl;
  if (news.autoDeleteTtl !== undefined)
    lifecycle.autoDeleteTtl = news.autoDeleteTtl;

  const config: dataproc.ClusterConfig = {
    clusterType,
    masterConfig: instanceGroup({
      numInstances: masterNum,
      machineType: masterMachine,
      bootDiskSizeGb: masterDiskGb,
      bootDiskType: masterDiskType,
    }),
    workerConfig: instanceGroup({
      numInstances: workerNum,
      machineType: singleNode ? undefined : workerMachine,
      bootDiskSizeGb: singleNode ? undefined : workerDiskGb,
      bootDiskType: singleNode ? undefined : workerDiskType,
    }),
  };

  if (Object.keys(gce).length > 0) config.gceClusterConfig = gce;
  if (Object.keys(software).length > 0) config.softwareConfig = software;
  if (Object.keys(lifecycle).length > 0) config.lifecycleConfig = lifecycle;
  if (news.autoscalingPolicyUri !== undefined) {
    config.autoscalingConfig = { policyUri: news.autoscalingPolicyUri };
  }
  if (news.configBucket !== undefined) config.configBucket = news.configBucket;
  if (news.tempBucket !== undefined) config.tempBucket = news.tempBucket;
  if (news.enableHttpPortAccess === true) {
    config.endpointConfig = { enableHttpPortAccess: true };
  }
  if (news.kmsKey !== undefined) {
    config.encryptionConfig = { kmsKey: news.kmsKey };
  }
  if (news.initializationActions !== undefined) {
    config.initializationActions = news.initializationActions;
  }
  if (
    news.secondaryWorkerNumInstances !== undefined ||
    news.secondaryWorkerMachineType !== undefined ||
    news.secondaryWorkerBootDiskSizeGb !== undefined ||
    news.secondaryWorkerPreemptibility !== undefined
  ) {
    config.secondaryWorkerConfig = instanceGroup({
      numInstances: news.secondaryWorkerNumInstances,
      machineType: news.secondaryWorkerMachineType,
      bootDiskSizeGb: news.secondaryWorkerBootDiskSizeGb,
      preemptibility: news.secondaryWorkerPreemptibility,
    });
  }

  return {
    projectId,
    clusterName,
    labels: desiredLabels,
    config,
  };
};

const listRegion = (projectId: string, region: string) =>
  dataproc.listProjectsRegionsClusters
    .pages({
      projectId,
      region,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.clusters ?? [])),
      Stream.filter((cluster) =>
        Object.keys(cluster.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((cluster) => toAttrs(cluster, projectId, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["name", "clusterName", "project", "region", "clusterUuid"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousName = olds?.clusterName ?? output?.clusterName;
      const nextName = news.clusterName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const previousType = normalizeClusterType(
        olds?.clusterType ?? output?.clusterType,
        olds?.workerNumInstances ?? output?.workerNumInstances,
      );
      const nextType = desiredClusterType({
        clusterType: news.clusterType ?? previousType,
        workerNumInstances:
          news.workerNumInstances ?? output?.workerNumInstances,
      });

      const replace =
        (previousName !== undefined &&
          nextName !== undefined &&
          nextName !== previousName) ||
        previousRegion !== nextRegion ||
        previousType !== nextType ||
        (news.imageVersion !== undefined &&
          !imageMatches(
            news.imageVersion,
            olds?.imageVersion ?? output?.imageVersion,
          )) ||
        (news.masterNumInstances !== undefined &&
          news.masterNumInstances !==
            (olds?.masterNumInstances ?? output?.masterNumInstances)) ||
        (news.masterMachineType !== undefined &&
          linkKey(news.masterMachineType) !==
            linkKey(olds?.masterMachineType ?? output?.masterMachineType)) ||
        (news.workerMachineType !== undefined &&
          linkKey(news.workerMachineType) !==
            linkKey(olds?.workerMachineType ?? output?.workerMachineType)) ||
        (news.masterBootDiskSizeGb !== undefined &&
          news.masterBootDiskSizeGb !==
            (olds?.masterBootDiskSizeGb ?? output?.masterBootDiskSizeGb)) ||
        (news.workerBootDiskSizeGb !== undefined &&
          news.workerBootDiskSizeGb !==
            (olds?.workerBootDiskSizeGb ?? output?.workerBootDiskSizeGb)) ||
        (news.masterBootDiskType !== undefined &&
          news.masterBootDiskType.toLowerCase() !==
            (
              olds?.masterBootDiskType ??
              output?.masterBootDiskType ??
              ""
            ).toLowerCase()) ||
        (news.workerBootDiskType !== undefined &&
          news.workerBootDiskType.toLowerCase() !==
            (
              olds?.workerBootDiskType ??
              output?.workerBootDiskType ??
              ""
            ).toLowerCase()) ||
        (news.zone !== undefined &&
          linkKey(news.zone) !== linkKey(olds?.zone ?? output?.zone)) ||
        (news.network !== undefined &&
          linkKey(news.network) !==
            linkKey(olds?.network ?? output?.network)) ||
        (news.subnetwork !== undefined &&
          linkKey(news.subnetwork) !==
            linkKey(olds?.subnetwork ?? output?.subnetwork)) ||
        (news.internalIpOnly !== undefined &&
          news.internalIpOnly !==
            (olds?.internalIpOnly ?? output?.internalIpOnly)) ||
        (news.serviceAccount !== undefined &&
          news.serviceAccount !==
            (olds?.serviceAccount ?? output?.serviceAccount)) ||
        (news.serviceAccountScopes !== undefined &&
          sortedKey(news.serviceAccountScopes) !==
            sortedKey(olds?.serviceAccountScopes)) ||
        (news.tags !== undefined &&
          sortedKey(news.tags) !== sortedKey(olds?.tags)) ||
        (news.metadata !== undefined &&
          metadataKey(news.metadata) !== metadataKey(olds?.metadata)) ||
        (news.optionalComponents !== undefined &&
          sortedKey(news.optionalComponents) !==
            sortedKey(olds?.optionalComponents)) ||
        (news.properties !== undefined &&
          propertiesKey(news.properties) !== propertiesKey(olds?.properties)) ||
        (news.secondaryWorkerMachineType !== undefined &&
          linkKey(news.secondaryWorkerMachineType) !==
            linkKey(olds?.secondaryWorkerMachineType)) ||
        (news.secondaryWorkerBootDiskSizeGb !== undefined &&
          news.secondaryWorkerBootDiskSizeGb !==
            (olds?.secondaryWorkerBootDiskSizeGb ?? undefined)) ||
        (news.secondaryWorkerPreemptibility !== undefined &&
          (news.secondaryWorkerPreemptibility ?? "").toUpperCase() !==
            (olds?.secondaryWorkerPreemptibility ?? "").toUpperCase()) ||
        (news.idleDeleteTtl !== undefined &&
          news.idleDeleteTtl !== (olds?.idleDeleteTtl ?? undefined)) ||
        (news.autoDeleteTtl !== undefined &&
          news.autoDeleteTtl !== (olds?.autoDeleteTtl ?? undefined)) ||
        (news.configBucket !== undefined &&
          news.configBucket !== (olds?.configBucket ?? output?.configBucket)) ||
        (news.tempBucket !== undefined &&
          news.tempBucket !== (olds?.tempBucket ?? output?.tempBucket)) ||
        (news.enableHttpPortAccess !== undefined &&
          news.enableHttpPortAccess !==
            (olds?.enableHttpPortAccess ?? undefined)) ||
        (news.kmsKey !== undefined && news.kmsKey !== (olds?.kmsKey ?? "")) ||
        (news.initializationActions !== undefined &&
          initKey(news.initializationActions) !==
            initKey(olds?.initializationActions));

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousRegion === nextRegion &&
          previousName !== undefined &&
          nextName === previousName,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const clusterName = yield* toId(
        id,
        olds?.clusterName,
        output?.clusterName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const parsed = output?.name ? parseName(output.name, region) : undefined;
      const project = parsed?.project || env.project;
      const existing = yield* getById(project, region, clusterName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, project, region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          [...new Set([env.region, ...LIST_REGIONS])],
          (region) => listRegion(env.project, region),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const clusterName = yield* toId(
        id,
        news.clusterName,
        output?.clusterName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const parsed = output?.name ? parseName(output.name, region) : undefined;
      const projectId = parsed?.project || env.project;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getById(
        projectId,
        region,
        output?.clusterName ?? clusterName,
      );

      if (current?.status?.state === "DELETING") {
        yield* waitUntilGone(projectId, region, clusterName);
        current = undefined;
      }

      if (current === undefined) {
        yield* createCluster(
          projectId,
          region,
          clusterName,
          toCreateBody(news, projectId, clusterName, desiredLabels),
        );
        current = yield* waitUntilExists(projectId, region, clusterName);
      }

      if (current === undefined) {
        return yield* new ClusterNotResolved({ clusterName, region });
      }

      const state = current.status?.state ?? "";
      if (terminalError(state)) {
        return yield* new ClusterFailed({
          clusterName,
          state,
          detail: current.status?.detail,
        });
      }

      if (state === "STOPPED" || state === "STOPPING") {
        const started = yield* dataproc.startProjectsRegionsClusters({
          projectId,
          region,
          clusterName,
        });
        yield* waitForOperation(started);
      }

      if ((current.status?.state ?? "") !== "RUNNING") {
        current = yield* waitUntilRunning(projectId, region, clusterName);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      const observedWorkers = groupNum(current.config?.workerConfig);
      const desiredWorkers = news.workerNumInstances;
      const workersChanged =
        desiredWorkers !== undefined && observedWorkers !== desiredWorkers;

      const observedSecondary = groupNum(current.config?.secondaryWorkerConfig);
      const desiredSecondary = news.secondaryWorkerNumInstances;
      const secondaryChanged =
        desiredSecondary !== undefined &&
        observedSecondary !== desiredSecondary;

      const observedPolicy = current.config?.autoscalingConfig?.policyUri ?? "";
      const desiredPolicy = news.autoscalingPolicyUri;
      const policyChanged =
        desiredPolicy !== undefined && observedPolicy !== desiredPolicy;

      if (
        labelsChanged ||
        workersChanged ||
        secondaryChanged ||
        policyChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          workersChanged ? "config.worker_config.num_instances" : undefined,
          secondaryChanged
            ? "config.secondary_worker_config.num_instances"
            : undefined,
          policyChanged ? "config.autoscaling_config.policy_uri" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* dataproc
          .patchProjectsRegionsClusters({
            projectId,
            region,
            clusterName,
            updateMask: updateMask.join(","),
            body: {
              projectId,
              clusterName,
              labels: desiredLabels,
              config: {
                workerConfig:
                  desiredWorkers !== undefined
                    ? { numInstances: desiredWorkers }
                    : undefined,
                secondaryWorkerConfig:
                  desiredSecondary !== undefined
                    ? { numInstances: desiredSecondary }
                    : undefined,
                autoscalingConfig:
                  desiredPolicy !== undefined
                    ? { policyUri: desiredPolicy }
                    : undefined,
              },
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* waitUntilRunning(projectId, region, clusterName);
      }

      return toAttrs(current, projectId, region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteCluster(output.project, output.region, output.clusterName);
    }),
  });
