import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_GLOBAL,
  DEFAULT_ZONE,
  VmwareengineNotResolved,
  canonicalizeLink,
  changedFields,
  collectPages,
  createInternalLabels,
  encodeOwnership,
  expandName,
  hasAlchemyLabels,
  hasOwnershipMarker,
  listAcrossLocations,
  normalizeLocation,
  parentOf,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  rfc1035,
  sameJson,
  toPhysicalId,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "privateClouds";
const VEN_COLLECTION = "vmwareEngineNetworks";
const DEFAULT_TYPE = "STANDARD";
const DEFAULT_MGMT_CLUSTER_ID = "mgmt";
const DEFAULT_NODE_TYPE = "standard-72";
const DEFAULT_NODE_COUNT = 3;
const DEFAULT_MANAGEMENT_CIDR = "192.168.1.0/24";

export type StretchedClusterConfig = {
  /** Preferred zone that stays up if the inter-zone link is lost. */
  preferredLocation?: string;
  /** Additional zone for availability. */
  secondaryLocation?: string;
};

export type NodeTypeConfig = {
  /** Custom core count per node. `0` uses the node type maximum. */
  customCoreCount?: number;
  /** Number of nodes of this type. */
  nodeCount?: number;
};

export type ManagementCluster = {
  /** Stretched-cluster zones. Required for `STRETCHED` private clouds. */
  stretchedClusterConfig?: StretchedClusterConfig;
  /**
   * Map of node type id to config. Keys are canonical node type ids
   * (`standard-72`, …).
   */
  nodeTypeConfigs?: Record<string, NodeTypeConfig | undefined>;
  /** User-provided cluster id for the management cluster. Immutable. */
  clusterId?: string;
};

export type NetworkConfig = {
  /** Management CIDR used by VMware appliances. Immutable. */
  managementCidr?: string;
  /** VMware Engine network to attach. Immutable. */
  vmwareEngineNetwork?: string;
  /** Output-only IP layout version. */
  managementIpAddressLayoutVersion?: number;
  /** Output-only DNS server IP. */
  dnsServerIp?: string;
  /** Output-only canonical VMware Engine network name. */
  vmwareEngineNetworkCanonical?: string;
};

export type EncryptionConfig = {
  /** KMS key for CMEK. */
  cryptoKeyName?: string;
  /** Encryption type (`CMEK`, `LEGACY_CMEK`, `OTHER`). */
  type?: vmwareengine.EncryptionConfigTypeEnum | (string & {});
};

export type Appliance = {
  /** Fully qualified domain name. */
  fqdn?: string;
  /** Internal IP address. */
  internalIp?: string;
  /** Appliance state. */
  state?: string;
  /** Appliance version. */
  version?: string;
};

export type PrivateCloudProps = {
  /**
   * Private cloud id (the `{privateCloud}` segment of
   * `projects/{project}/locations/{location}/privateClouds/{privateCloud}`).
   * If omitted, a unique RFC1035 name is generated. Immutable.
   */
  privateCloudId?: string;
  /**
   * Location. `STANDARD` and `TIME_LIMITED` clouds are zonal
   * (`us-central1-a`); `STRETCHED` clouds are regional. Immutable.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Private cloud type.
   * @default "STANDARD"
   */
  type?: vmwareengine.PrivateCloudTypeEnum | (string & {});
  /**
   * Management cluster. Required on create. `clusterId` and node type
   * identity are immutable.
   */
  managementCluster?: ManagementCluster;
  /**
   * Consumer-project network configuration. `managementCidr` is
   * required on create. Immutable.
   */
  networkConfig?: NetworkConfig;
  /**
   * Customer-managed encryption. Immutable.
   */
  encryptionConfig?: EncryptionConfig;
  /**
   * Human-readable description. Private clouds have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes. Description is the only in-place update.
   */
  description?: string;
};

export type PrivateCloud = Resource<
  "GCP.VMwareEngine.PrivateCloud",
  PrivateCloudProps,
  {
    /** Full resource name. */
    name: string;
    /** Private cloud id (last path segment). */
    privateCloudId: string;
    /** Project id. */
    project: string;
    /** Location id (zone or region). */
    location: string;
    /** Private cloud type. */
    type: string | undefined;
    /** Management cluster configuration. */
    managementCluster: ManagementCluster | undefined;
    /** Network configuration, including output-only DNS and layout. */
    networkConfig: NetworkConfig | undefined;
    /** Encryption configuration. */
    encryptionConfig: EncryptionConfig | undefined;
    /** HCX appliance. */
    hcx: Appliance | undefined;
    /** vCenter appliance. */
    vcenter: Appliance | undefined;
    /** NSX appliance. */
    nsx: Appliance | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** System-generated unique identifier. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Time the cloud was scheduled for deletion. */
    deleteTime: string | undefined;
    /** Time the cloud will be irreversibly deleted. */
    expireTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud VMware Engine private cloud. `STANDARD` and
 * `TIME_LIMITED` clouds are zonal; `STRETCHED` clouds are regional.
 * Creating a private cloud also creates its management cluster.
 *
 * Private clouds have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Type, location, management cluster
 * identity, and network config are immutable. Description updates in
 * place. Delete uses `delayHours=0` so billing stops immediately.
 *
 * Provisioning typically takes 30-120 minutes.
 *
 * ### Creating a PrivateCloud
 * **Example:** Standard three-node cloud
 * ```typescript
 * const cloud = yield* GCP.VMwareEngine.PrivateCloud("Sddc", {
 *   location: "us-central1-a",
 *   type: "STANDARD",
 *   networkConfig: {
 *     managementCidr: "192.168.1.0/24",
 *     vmwareEngineNetwork: ven.name,
 *   },
 *   managementCluster: {
 *     clusterId: "mgmt",
 *     nodeTypeConfigs: {
 *       "standard-72": { nodeCount: 3 },
 *     },
 *   },
 *   description: "app sddc",
 * });
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const PrivateCloud = Resource<PrivateCloud>(
  "GCP.VMwareEngine.PrivateCloud",
);

const resourceName = (
  project: string,
  location: string,
  privateCloudId: string,
) => `${parentOf(project, location)}/${COLLECTION}/${privateCloudId}`;

const nodeTypeConfigsOf = (
  value: vmwareengine.NodeTypeConfigMap | undefined,
): Record<string, NodeTypeConfig | undefined> | undefined => {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, config]) => [
      key,
      config === undefined
        ? undefined
        : {
            customCoreCount: config.customCoreCount,
            nodeCount: config.nodeCount,
          },
    ]),
  );
};

const stretchedOf = (
  value: vmwareengine.StretchedClusterConfig | undefined,
): StretchedClusterConfig | undefined => {
  if (value === undefined) return undefined;
  return {
    preferredLocation: value.preferredLocation,
    secondaryLocation: value.secondaryLocation,
  };
};

const managementClusterOf = (
  value: vmwareengine.ManagementCluster | ManagementCluster | undefined,
): ManagementCluster | undefined => {
  if (value === undefined) return undefined;
  return {
    clusterId: value.clusterId,
    nodeTypeConfigs: nodeTypeConfigsOf(value.nodeTypeConfigs),
    stretchedClusterConfig: stretchedOf(value.stretchedClusterConfig),
  };
};

const networkConfigOf = (
  value: vmwareengine.NetworkConfig | NetworkConfig | undefined,
): NetworkConfig | undefined => {
  if (value === undefined) return undefined;
  return {
    managementCidr: value.managementCidr,
    vmwareEngineNetwork: value.vmwareEngineNetwork,
    managementIpAddressLayoutVersion: value.managementIpAddressLayoutVersion,
    dnsServerIp: value.dnsServerIp,
    vmwareEngineNetworkCanonical: value.vmwareEngineNetworkCanonical,
  };
};

const encryptionOf = (
  value: vmwareengine.EncryptionConfig | EncryptionConfig | undefined,
): EncryptionConfig | undefined => {
  if (value === undefined) return undefined;
  return {
    cryptoKeyName: value.cryptoKeyName,
    type: value.type,
  };
};

const applianceOf = (
  value: vmwareengine.Hcx | vmwareengine.Vcenter | vmwareengine.Nsx | undefined,
): Appliance | undefined => {
  if (value === undefined) return undefined;
  return {
    fqdn: value.fqdn,
    internalIp: value.internalIp,
    state: value.state,
    version: value.version,
  };
};

const defaultManagementCluster = (
  value: ManagementCluster | undefined,
): ManagementCluster => ({
  clusterId: value?.clusterId ?? DEFAULT_MGMT_CLUSTER_ID,
  stretchedClusterConfig: value?.stretchedClusterConfig,
  nodeTypeConfigs: value?.nodeTypeConfigs ?? {
    [DEFAULT_NODE_TYPE]: { nodeCount: DEFAULT_NODE_COUNT },
  },
});

const defaultNetworkConfig = (
  project: string,
  value: NetworkConfig | undefined,
): NetworkConfig => ({
  managementCidr: value?.managementCidr ?? DEFAULT_MANAGEMENT_CIDR,
  vmwareEngineNetwork: value?.vmwareEngineNetwork
    ? expandName(
        value.vmwareEngineNetwork,
        project,
        DEFAULT_GLOBAL,
        VEN_COLLECTION,
      )
    : undefined,
});

const toAttrs = (item: vmwareengine.PrivateCloud, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_ZONE);
  const ownership = parseOwnership(item.description);
  return {
    name,
    privateCloudId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    type: item.type,
    managementCluster: managementClusterOf(item.managementCluster),
    networkConfig: networkConfigOf(item.networkConfig),
    encryptionConfig: encryptionOf(item.encryptionConfig),
    hcx: applianceOf(item.hcx),
    vcenter: applianceOf(item.vcenter),
    nsx: applianceOf(item.nsx),
    description: ownership.text,
    state: item.state,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    deleteTime: item.deleteTime,
    expireTime: item.expireTime,
  };
};

const getByName = (name: string) =>
  vmwareengine
    .getProjectsLocationsPrivateClouds({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const PrivateCloudProvider = () =>
  Provider.succeed(PrivateCloud, {
    stables: [
      "name",
      "privateCloudId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousType = olds?.type ?? output?.type ?? DEFAULT_TYPE;
      const nextType = news.type ?? previousType;
      const previousCidr =
        olds?.networkConfig?.managementCidr ??
        output?.networkConfig?.managementCidr ??
        "";
      const nextCidr = news.networkConfig?.managementCidr ?? previousCidr;
      const previousVen = canonicalizeLink(
        olds?.networkConfig?.vmwareEngineNetwork ??
          output?.networkConfig?.vmwareEngineNetwork,
      );
      const nextVen = canonicalizeLink(news.networkConfig?.vmwareEngineNetwork);
      const previousClusterId =
        olds?.managementCluster?.clusterId ??
        output?.managementCluster?.clusterId ??
        "";
      const nextClusterId =
        news.managementCluster?.clusterId ?? previousClusterId;
      return replaceOnIdentity({
        previousId: olds?.privateCloudId ?? output?.privateCloudId,
        nextId: news.privateCloudId
          ? rfc1035(news.privateCloudId, "privatecloud")
          : (olds?.privateCloudId ?? output?.privateCloudId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          DEFAULT_ZONE,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          DEFAULT_ZONE,
        ),
        extra:
          previousType !== nextType ||
          (previousCidr.length > 0 && previousCidr !== nextCidr) ||
          (previousVen.length > 0 &&
            nextVen.length > 0 &&
            previousVen !== nextVen) ||
          (previousClusterId.length > 0 &&
            nextClusterId.length > 0 &&
            previousClusterId !== nextClusterId) ||
          !sameJson(
            news.encryptionConfig,
            olds?.encryptionConfig ?? output?.encryptionConfig,
          ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const privateCloudId = yield* toPhysicalId(
        id,
        olds?.privateCloudId,
        output?.privateCloudId,
        "privatecloud",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name =
        output?.name ?? resourceName(env.project, location, privateCloudId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listAcrossLocations(
          env.project,
          env.region,
          (parent) =>
            collectPages(
              vmwareengine.listProjectsLocationsPrivateClouds.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.privateClouds,
            ),
        );
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const privateCloudId = yield* toPhysicalId(
        id,
        news.privateCloudId,
        output?.privateCloudId,
        "privatecloud",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name = resourceName(env.project, location, privateCloudId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const type = news.type ?? DEFAULT_TYPE;
      const managementCluster = defaultManagementCluster(
        news.managementCluster,
      );
      const networkConfig = defaultNetworkConfig(
        env.project,
        news.networkConfig,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsPrivateClouds({
            parent: parentOf(env.project, location),
            privateCloudId,
            body: {
              type,
              description: desiredDescription,
              managementCluster,
              networkConfig,
              encryptionConfig: news.encryptionConfig,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new VmwareengineNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const updateMask = changedFields([["description", descriptionChanged]]);

      if (updateMask.length > 0) {
        const operation =
          yield* vmwareengine.patchProjectsLocationsPrivateClouds({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              description: desiredDescription,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vmwareengine
        .deleteProjectsLocationsPrivateClouds({
          name: output.name,
          delayHours: 0,
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
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
