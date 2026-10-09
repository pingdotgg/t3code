import * as tpu from "@distilled.cloud/gcp/tpu_v2";
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
  DEFAULT_ACCELERATOR,
  DEFAULT_NETWORK,
  DEFAULT_RUNTIME,
  fieldMask,
  lastSegment,
  listLabeledPages,
  mapKey,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  stringMapOf,
  stringsKey,
  stringsOf,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type NetworkConfig = {
  /**
   * Associate external IPs with TPU workers. When false, the network or
   * subnetwork must have Private Google Access.
   * @default true
   */
  enableExternalIps?: boolean;
  /**
   * Subnetwork name or path. Defaults to `default`.
   */
  subnetwork?: string;
  /**
   * VPC network name or path. Defaults to `default`.
   * @default "default"
   */
  network?: string;
  /**
   * Allow the TPU to send/receive packets with non-matching IPs (required
   * to forward routes).
   */
  canIpForward?: boolean;
  /**
   * Networking queue count for the TPU VM NIC.
   */
  queueCount?: number;
};

export type AcceleratorConfig = {
  /**
   * TPU generation (`V2`, `V3`, `V4`, `V5LITE_POD`, `V5P`, `V6E`).
   */
  type?: tpu.AcceleratorConfigTypeEnum | (string & {});
  /**
   * Chip topology (e.g. `2x2` for v2-8).
   */
  topology?: string;
};

export type ServiceAccount = {
  /**
   * Service account email. Omit to use the default Compute service
   * account.
   */
  email?: string;
  /**
   * OAuth scopes. Omit to allow all Cloud APIs.
   */
  scope?: string[];
};

export type SchedulingConfig = {
  /** Provision under a reservation. */
  reserved?: boolean;
  /** Provision as a Spot VM. Immutable. */
  spot?: boolean;
  /** Provision as preemptible. Immutable. */
  preemptible?: boolean;
};

export type AttachedDisk = {
  /**
   * Existing disk path
   * (`projects/{project}/zones/{zone}/disks/{disk}`).
   */
  sourceDisk?: string;
  /**
   * Attach mode. Defaults to `READ_WRITE`.
   */
  mode?: tpu.AttachedDiskModeEnum | (string & {});
};

export type BootDiskConfig = {
  /** Customer-managed KMS key for the boot disk. */
  customerEncryptionKey?: {
    /** Cloud KMS crypto key resource name. */
    kmsKeyName?: string;
  };
};

export type ShieldedInstanceConfig = {
  /** Enable Secure Boot. */
  enableSecureBoot?: boolean;
};

export type NodeProps = {
  /**
   * Node id (the `{node}` segment of
   * `projects/{project}/locations/{location}/nodes/{node}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-63 characters, start with a letter, and end
   * with a letter or digit. Immutable — changing it replaces the node.
   */
  nodeId?: string;
  /**
   * Zone (`us-central1-c`, `us-central1-b`, …). TPU nodes are zonal.
   * Immutable — changing it replaces the node. `US-CENTRAL1-C` is
   * accepted and normalized to `us-central1-c`.
   * @default "us-central1-c"
   */
  location?: string;
  /**
   * Runtime version running on the node (e.g. `tpu-ubuntu2204-base`).
   * Immutable — changing it replaces the node.
   * @default "tpu-ubuntu2204-base"
   */
  runtimeVersion?: string;
  /**
   * Accelerator type (`v2-8`, `v3-8`, `v5litepod-8`, …). Mutually
   * exclusive with `acceleratorConfig`. Immutable. If neither is set,
   * defaults to `v2-8`.
   */
  acceleratorType?: string;
  /**
   * Accelerator generation and chip topology. Mutually exclusive with
   * `acceleratorType`. Immutable.
   */
  acceleratorConfig?: AcceleratorConfig;
  /**
   * Human-readable description (512 characters or less).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Custom VM metadata (`startup-script`, `shutdown-script`, …).
   */
  metadata?: Record<string, string>;
  /**
   * Network tags applied to the TPU VM (firewall source/target tags).
   */
  networkTags?: string[];
  /**
   * CIDR `/29` the node uses when picking an IP. Immutable.
   */
  cidrBlock?: string;
  /**
   * Service account the TPU VMs run as. Immutable.
   */
  serviceAccount?: ServiceAccount;
  /**
   * Single-NIC network configuration. Mutually exclusive with
   * `networkConfigs`. `enableExternalIps` updates in place; the rest is
   * immutable.
   */
  networkConfig?: NetworkConfig;
  /**
   * Multi-NIC network configurations. Mutually exclusive with
   * `networkConfig`. Immutable.
   */
  networkConfigs?: NetworkConfig[];
  /**
   * Boot disk encryption. Immutable.
   */
  bootDiskConfig?: BootDiskConfig;
  /**
   * Additional data disks. Immutable.
   */
  dataDisks?: AttachedDisk[];
  /**
   * Scheduling (reservation, Spot, preemptible). Immutable.
   */
  schedulingConfig?: SchedulingConfig;
  /**
   * Shielded VM options. Immutable.
   */
  shieldedInstanceConfig?: ShieldedInstanceConfig;
};

export type Node = Resource<
  "GCP.TPU.Node",
  NodeProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/nodes/{node}`. */
    name: string;
    /** Node id (last path segment). */
    nodeId: string;
    /** Project id. */
    project: string;
    /** Zone id (`us-central1-c`, …). */
    location: string;
    /** Server-assigned numeric id. */
    tpuId: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Custom VM metadata. */
    metadata: Record<string, string>;
    /** Network tags. */
    networkTags: string[];
    /** Accelerator type (`v2-8`, …). */
    acceleratorType: string | undefined;
    /** Accelerator config currently applied. */
    acceleratorConfig: AcceleratorConfig | undefined;
    /** Runtime version. */
    runtimeVersion: string | undefined;
    /** Server-reported state (`READY`, `CREATING`, …). */
    state: string | undefined;
    /** Health (`HEALTHY`, `TIMEOUT`, …). */
    health: string | undefined;
    /** Why the node is unhealthy, if populated. */
    healthDescription: string | undefined;
    /** CIDR `/29` in use. */
    cidrBlock: string | undefined;
    /** Service account. */
    serviceAccount: ServiceAccount | undefined;
    /** Single-NIC network configuration. */
    networkConfig: NetworkConfig | undefined;
    /** Multi-NIC network configurations. */
    networkConfigs: NetworkConfig[];
    /** Worker network endpoints. */
    networkEndpoints: tpu.NetworkEndpoint[];
    /** Boot disk configuration. */
    bootDiskConfig: BootDiskConfig | undefined;
    /** Attached data disks. */
    dataDisks: AttachedDisk[];
    /** Scheduling options. */
    schedulingConfig: SchedulingConfig | undefined;
    /** Shielded VM options. */
    shieldedInstanceConfig: ShieldedInstanceConfig | undefined;
    /** Whether this node is part of a Multislice group. */
    multisliceNode: boolean | undefined;
    /** QueuedResource that requested this node, if any. */
    queuedResource: string | undefined;
    /** API version that created the node. */
    apiVersion: string | undefined;
    /** Symptoms reported on the node. */
    symptoms: tpu.Symptom[];
    /** Upcoming maintenance, if any. */
    upcomingMaintenance: tpu.UpcomingMaintenance | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud TPU node (TPU VM).
 *
 * Changing `nodeId`, `location`, `runtimeVersion`, `acceleratorType`,
 * `acceleratorConfig`, `cidrBlock`, `serviceAccount`, scheduling,
 * boot/data disks, shielded config, or network identity (other than
 * `enableExternalIps`) replaces the node. Description, labels, metadata,
 * network tags, and `networkConfig.enableExternalIps` update in place.
 *
 * Provisioning typically takes several minutes and requires Cloud TPU
 * quota in the zone.
 *
 * ### Creating a Node
 * **Example:** Generated name, v2-8
 * ```typescript
 * const tpu = yield* GCP.TPU.Node("Trainer", {});
 * ```
 *
 * **Example:** Explicit id, labels, and description
 * ```typescript
 * const tpu = yield* GCP.TPU.Node("Trainer", {
 *   nodeId: "app-tpu",
 *   location: "us-central1-c",
 *   acceleratorType: "v2-8",
 *   runtimeVersion: "tpu-ubuntu2204-base",
 *   description: "training node",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Spot scheduling
 * **Example:** Preemptible Spot TPU
 * ```typescript
 * const tpu = yield* GCP.TPU.Node("Trainer", {
 *   acceleratorType: "v2-8",
 *   schedulingConfig: { spot: true, preemptible: true },
 * });
 * ```
 *
 * @resource
 * @category TPU
 */
export const Node = Resource<Node>("GCP.TPU.Node");

const resourceName = (project: string, location: string, nodeId: string) =>
  `projects/${project}/locations/${location}/nodes/${nodeId}`;

const networkOf = (
  config: tpu.NetworkConfig | NetworkConfig | undefined,
): NetworkConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    enableExternalIps: config.enableExternalIps,
    subnetwork: config.subnetwork,
    network: config.network,
    canIpForward: config.canIpForward,
    queueCount: config.queueCount,
  };
};

const networksOf = (
  configs: ReadonlyArray<tpu.NetworkConfig | NetworkConfig> | undefined,
): NetworkConfig[] => (configs ?? []).map((config) => networkOf(config)!);

const networkIdentityKey = (config: NetworkConfig | undefined) =>
  JSON.stringify({
    network: lastSegment(config?.network ?? DEFAULT_NETWORK),
    subnetwork: lastSegment(config?.subnetwork ?? ""),
    canIpForward: config?.canIpForward === true,
    queueCount: config?.queueCount ?? "",
  });

const networksIdentityKey = (configs: readonly NetworkConfig[] | undefined) =>
  JSON.stringify((configs ?? []).map(networkIdentityKey));

const acceleratorOf = (
  config: tpu.AcceleratorConfig | AcceleratorConfig | undefined,
): AcceleratorConfig | undefined => {
  if (config === undefined) return undefined;
  if (config.type === undefined && config.topology === undefined) {
    return undefined;
  }
  return { type: config.type, topology: config.topology };
};

const acceleratorKey = (
  type: string | undefined,
  config: AcceleratorConfig | undefined,
) =>
  JSON.stringify({
    type: (type ?? "").toLowerCase(),
    configType: (config?.type ?? "").toUpperCase(),
    topology: config?.topology ?? "",
  });

const serviceAccountOf = (
  account: tpu.ServiceAccount | ServiceAccount | undefined,
): ServiceAccount | undefined => {
  if (account === undefined) return undefined;
  return {
    email: account.email,
    scope: account.scope ? [...account.scope] : undefined,
  };
};

const serviceAccountKey = (
  account: tpu.ServiceAccount | ServiceAccount | undefined,
) =>
  JSON.stringify({
    email: serviceAccountOf(account)?.email ?? "",
    scope: [...(serviceAccountOf(account)?.scope ?? [])].sort(),
  });

const schedulingOf = (
  config: tpu.SchedulingConfig | SchedulingConfig | undefined,
): SchedulingConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    reserved: config.reserved,
    spot: config.spot,
    preemptible: config.preemptible,
  };
};

const schedulingKey = (
  config: tpu.SchedulingConfig | SchedulingConfig | undefined,
) =>
  JSON.stringify({
    reserved: schedulingOf(config)?.reserved === true,
    spot: schedulingOf(config)?.spot === true,
    preemptible: schedulingOf(config)?.preemptible === true,
  });

const diskOf = (disk: tpu.AttachedDisk | AttachedDisk): AttachedDisk => ({
  sourceDisk: disk.sourceDisk,
  mode: disk.mode,
});

const disksKey = (
  disks: ReadonlyArray<tpu.AttachedDisk | AttachedDisk> | undefined,
) =>
  JSON.stringify(
    (disks ?? []).map((disk) => ({
      sourceDisk: disk.sourceDisk ?? "",
      mode: (disk.mode ?? "READ_WRITE").toUpperCase(),
    })),
  );

const bootOf = (
  config: tpu.BootDiskConfig | BootDiskConfig | undefined,
): BootDiskConfig | undefined => {
  if (config === undefined) return undefined;
  const key = config.customerEncryptionKey?.kmsKeyName;
  if (key === undefined) return undefined;
  return { customerEncryptionKey: { kmsKeyName: key } };
};

const bootKey = (config: tpu.BootDiskConfig | BootDiskConfig | undefined) =>
  bootOf(config)?.customerEncryptionKey?.kmsKeyName ?? "";

const shieldedOf = (
  config: tpu.ShieldedInstanceConfig | ShieldedInstanceConfig | undefined,
): ShieldedInstanceConfig | undefined => {
  if (config === undefined) return undefined;
  return { enableSecureBoot: config.enableSecureBoot };
};

const shieldedKey = (
  config: tpu.ShieldedInstanceConfig | ShieldedInstanceConfig | undefined,
) => JSON.stringify(shieldedOf(config)?.enableSecureBoot === true);

const runtimeOf = (version: string | undefined) => version ?? DEFAULT_RUNTIME;

const desiredAcceleratorType = (news: NodeProps) =>
  news.acceleratorConfig === undefined
    ? (news.acceleratorType ?? DEFAULT_ACCELERATOR)
    : news.acceleratorType;

export const toNodeBody = (
  news: NodeProps,
  desiredLabels: Record<string, string>,
  options?: { description?: string },
): tpu.Node => {
  const runtimeVersion = runtimeOf(news.runtimeVersion);
  const acceleratorType = desiredAcceleratorType(news);
  const networkConfigs = news.networkConfigs;
  const networkConfig =
    networkConfigs === undefined
      ? (news.networkConfig ?? {
          enableExternalIps: true,
          network: DEFAULT_NETWORK,
        })
      : undefined;
  return {
    description: options?.description ?? news.description,
    labels: desiredLabels,
    metadata: news.metadata,
    tags: news.networkTags,
    runtimeVersion,
    acceleratorType,
    acceleratorConfig: news.acceleratorConfig,
    cidrBlock: news.cidrBlock,
    serviceAccount: news.serviceAccount,
    networkConfig,
    networkConfigs,
    bootDiskConfig: news.bootDiskConfig,
    dataDisks: news.dataDisks,
    schedulingConfig: news.schedulingConfig,
    shieldedInstanceConfig: news.shieldedInstanceConfig,
  };
};

const toAttrs = (node: tpu.Node, project: string) => {
  const name = node.name ?? "";
  const parsed = parseName(name, "nodes");
  return {
    name,
    nodeId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    tpuId: node.id,
    description: node.description,
    labels: userLabels(node.labels),
    metadata: stringMapOf(node.metadata),
    networkTags: stringsOf(node.tags),
    acceleratorType: node.acceleratorType,
    acceleratorConfig: acceleratorOf(node.acceleratorConfig),
    runtimeVersion: node.runtimeVersion,
    state: node.state,
    health: node.health,
    healthDescription: node.healthDescription,
    cidrBlock: node.cidrBlock,
    serviceAccount: serviceAccountOf(node.serviceAccount),
    networkConfig: networkOf(node.networkConfig),
    networkConfigs: networksOf(node.networkConfigs),
    networkEndpoints: node.networkEndpoints ?? [],
    bootDiskConfig: bootOf(node.bootDiskConfig),
    dataDisks: (node.dataDisks ?? []).map(diskOf),
    schedulingConfig: schedulingOf(node.schedulingConfig),
    shieldedInstanceConfig: shieldedOf(node.shieldedInstanceConfig),
    multisliceNode: node.multisliceNode,
    queuedResource: node.queuedResource,
    apiVersion: node.apiVersion,
    symptoms: node.symptoms ?? [],
    upcomingMaintenance: node.upcomingMaintenance,
    createTime: node.createTime,
  };
};

const isPlaceholder = (node: tpu.Node) => {
  const name = node.name ?? "";
  return (
    name.length === 0 || name.endsWith("/nodes/-") || name.endsWith("/nodes/")
  );
};

const getByName = (name: string) =>
  tpu
    .getProjectsLocationsNodes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const NodeProvider = () =>
  Provider.succeed(Node, {
    stables: ["name", "nodeId", "project", "location", "tpuId", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.nodeId ?? output?.nodeId;
      const nextId = news.nodeId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const previousRuntime = runtimeOf(
        olds?.runtimeVersion ?? output?.runtimeVersion,
      );
      const nextRuntime = runtimeOf(
        news.runtimeVersion ?? olds?.runtimeVersion ?? output?.runtimeVersion,
      );
      const previousAccelerator = acceleratorKey(
        olds?.acceleratorType ?? output?.acceleratorType,
        acceleratorOf(olds?.acceleratorConfig ?? output?.acceleratorConfig),
      );
      const nextAccelerator = acceleratorKey(
        news.acceleratorType ??
          olds?.acceleratorType ??
          output?.acceleratorType,
        acceleratorOf(
          news.acceleratorConfig ??
            olds?.acceleratorConfig ??
            output?.acceleratorConfig,
        ),
      );
      const previousCidr = olds?.cidrBlock ?? output?.cidrBlock ?? "";
      const nextCidr = news.cidrBlock ?? previousCidr;
      const previousAccount = serviceAccountKey(
        olds?.serviceAccount ?? output?.serviceAccount,
      );
      const nextAccount = serviceAccountKey(
        news.serviceAccount ?? olds?.serviceAccount ?? output?.serviceAccount,
      );
      const previousScheduling = schedulingKey(
        olds?.schedulingConfig ?? output?.schedulingConfig,
      );
      const nextScheduling = schedulingKey(
        news.schedulingConfig ??
          olds?.schedulingConfig ??
          output?.schedulingConfig,
      );
      const previousBoot = bootKey(
        olds?.bootDiskConfig ?? output?.bootDiskConfig,
      );
      const nextBoot = bootKey(
        news.bootDiskConfig ?? olds?.bootDiskConfig ?? output?.bootDiskConfig,
      );
      const previousDisks = disksKey(olds?.dataDisks ?? output?.dataDisks);
      const nextDisks = disksKey(
        news.dataDisks ?? olds?.dataDisks ?? output?.dataDisks,
      );
      const previousShielded = shieldedKey(
        olds?.shieldedInstanceConfig ?? output?.shieldedInstanceConfig,
      );
      const nextShielded = shieldedKey(
        news.shieldedInstanceConfig ??
          olds?.shieldedInstanceConfig ??
          output?.shieldedInstanceConfig,
      );
      const previousMulti = networksIdentityKey(
        olds?.networkConfigs ?? output?.networkConfigs,
      );
      const nextMulti = networksIdentityKey(
        news.networkConfigs ?? olds?.networkConfigs ?? output?.networkConfigs,
      );
      const previousNet = networkIdentityKey(
        olds?.networkConfig ?? output?.networkConfig,
      );
      const nextNet = networkIdentityKey(
        news.networkConfig ?? olds?.networkConfig ?? output?.networkConfig,
      );
      const usedMulti =
        (news.networkConfigs ?? olds?.networkConfigs ?? output?.networkConfigs)
          ?.length ?? 0;

      return replaceOnIdentity({
        previousId,
        nextId,
        previousLocation,
        nextLocation,
        extra:
          previousRuntime !== nextRuntime ||
          previousAccelerator !== nextAccelerator ||
          previousCidr !== nextCidr ||
          previousAccount !== nextAccount ||
          previousScheduling !== nextScheduling ||
          previousBoot !== nextBoot ||
          previousDisks !== nextDisks ||
          previousShielded !== nextShielded ||
          previousMulti !== nextMulti ||
          (usedMulti === 0 && previousNet !== nextNet),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const nodeId = yield* toPhysicalId(id, olds?.nodeId, output?.nodeId);
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name = output?.name ?? resourceName(env.project, location, nodeId);
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
        const nodes = yield* listLabeledPages(
          tpu.listProjectsLocationsNodes.pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          }),
          (page) => page.nodes,
          (node) => node.labels,
        );
        return nodes
          .filter((node) => !isPlaceholder(node))
          .map((node) => toAttrs(node, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const nodeId = yield* toPhysicalId(id, news.nodeId, output?.nodeId);
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, nodeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* tpu
          .createProjectsLocationsNodes({
            parent: `projects/${env.project}/locations/${location}`,
            nodeId,
            body: toNodeBody(news, desiredLabels),
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

      const state = (current.state ?? "").toUpperCase();
      if (state !== "READY" && state !== "STOPPED" && state.length > 0) {
        current = yield* waitUntilReady(
          getByName(name),
          name,
          (node) => node.state,
          (node) => node.healthDescription,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const metadataChanged =
        news.metadata !== undefined &&
        mapKey(current.metadata) !== mapKey(news.metadata);
      const tagsChanged =
        news.networkTags !== undefined &&
        stringsKey(current.tags) !== stringsKey(news.networkTags);
      const desiredExternal = news.networkConfig?.enableExternalIps !== false;
      const observedExternal =
        current.networkConfig?.enableExternalIps !== false;
      const usingMulti =
        (news.networkConfigs ?? current.networkConfigs ?? []).length > 0;
      const externalChanged =
        !usingMulti &&
        news.networkConfig !== undefined &&
        desiredExternal !== observedExternal;

      if (
        labelsChanged ||
        descriptionChanged ||
        metadataChanged ||
        tagsChanged ||
        externalChanged
      ) {
        const updateMask = fieldMask([
          labelsChanged && "labels",
          descriptionChanged && "description",
          metadataChanged && "metadata",
          tagsChanged && "tags",
          externalChanged && "network_config.enable_external_ips",
        ]);
        const patched = yield* tpu.patchProjectsLocationsNodes({
          name,
          updateMask,
          body: {
            name,
            labels: desiredLabels,
            description: news.description,
            metadata: news.metadata ?? stringMapOf(current.metadata),
            tags: news.networkTags ?? stringsOf(current.tags),
            networkConfig: externalChanged
              ? {
                  ...networkOf(current.networkConfig),
                  enableExternalIps: desiredExternal,
                }
              : undefined,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* tpu
        .deleteProjectsLocationsNodes({ name: output.name })
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
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
