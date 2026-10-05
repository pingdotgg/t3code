import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
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
import { waitForOperation } from "./internal.ts";

const DEFAULT_LOCATION = "global";
const MAX_NAME_LENGTH = 63;

export type SpokeState = networkconnectivity.SpokeStateEnum | (string & {});
export type SpokeType = networkconnectivity.SpokeSpokeTypeEnum | (string & {});
export type SpokeGatewayCapacity =
  | networkconnectivity.GatewayCapacityEnum
  | (string & {});

export type SpokeStateReason = {
  /** Reason code (`PENDING_REVIEW`, `REJECTED`, `FAILED`, …). */
  code: string | undefined;
  /** Human-readable details. */
  message: string | undefined;
  /** Extra text supplied when a hub admin rejected the spoke. */
  userDetails: string | undefined;
};

export type LinkedVpcNetwork = {
  /**
   * URI of the VPC network
   * (`projects/{project}/global/networks/{network}` or a Compute
   * selfLink). Immutable — changing it replaces the spoke.
   */
  uri: string;
  /**
   * Subnet CIDRs excluded from export to the hub.
   */
  excludeExportRanges?: ReadonlyArray<string>;
  /**
   * Subnet CIDRs included when exporting to the hub.
   */
  includeExportRanges?: ReadonlyArray<string>;
};

export type LinkedVpnTunnels = {
  /**
   * URIs of HA VPN tunnels. Immutable — changing them replaces the
   * spoke.
   */
  uris: ReadonlyArray<string>;
  /**
   * Enable site-to-site data transfer. Immutable — changing it replaces
   * the spoke.
   */
  siteToSiteDataTransfer?: boolean;
  /** Hub routes included when importing from the hub. */
  includeImportRanges?: ReadonlyArray<string>;
  /** Hub routes excluded when importing from the hub. */
  excludeImportRanges?: ReadonlyArray<string>;
  /** Dynamic routes included when exporting to the hub. */
  includeExportRanges?: ReadonlyArray<string>;
  /** Dynamic routes excluded when exporting to the hub. */
  excludeExportRanges?: ReadonlyArray<string>;
};

export type LinkedInterconnectAttachments = {
  /**
   * URIs of VLAN attachments. Immutable — changing them replaces the
   * spoke.
   */
  uris: ReadonlyArray<string>;
  /**
   * Enable site-to-site data transfer. Immutable — changing it replaces
   * the spoke.
   */
  siteToSiteDataTransfer?: boolean;
  /** Hub routes included when importing from the hub. */
  includeImportRanges?: ReadonlyArray<string>;
  /** Hub routes excluded when importing from the hub. */
  excludeImportRanges?: ReadonlyArray<string>;
  /** Dynamic routes included when exporting to the hub. */
  includeExportRanges?: ReadonlyArray<string>;
  /** Dynamic routes excluded when exporting to the hub. */
  excludeExportRanges?: ReadonlyArray<string>;
};

export type RouterApplianceInstance = {
  /** URI of the VM that speaks BGP. */
  virtualMachine: string;
  /** Internal IP on the VM used for peering. */
  ipAddress: string;
};

export type LinkedRouterApplianceInstances = {
  /**
   * Router appliance VMs. Replacing the set of VMs updates in place;
   * changing `siteToSiteDataTransfer` replaces the spoke.
   */
  instances: ReadonlyArray<RouterApplianceInstance>;
  /**
   * Enable site-to-site data transfer. Immutable — changing it replaces
   * the spoke.
   */
  siteToSiteDataTransfer?: boolean;
  /** Hub routes included when importing from the hub. */
  includeImportRanges?: ReadonlyArray<string>;
  /** Hub routes excluded when importing from the hub. */
  excludeImportRanges?: ReadonlyArray<string>;
  /** Dynamic routes included when exporting to the hub. */
  includeExportRanges?: ReadonlyArray<string>;
  /** Dynamic routes excluded when exporting to the hub. */
  excludeExportRanges?: ReadonlyArray<string>;
};

export type LinkedProducerVpcNetwork = {
  /**
   * Service-consumer VPC the producer VPC is peered with. Immutable —
   * changing it replaces the spoke.
   */
  network: string;
  /**
   * Name of the ACTIVE VPC peering to the producer (tenant) VPC.
   * Immutable — changing it replaces the spoke.
   */
  peering: string;
  /** Subnet CIDRs excluded from export to the hub. */
  excludeExportRanges?: ReadonlyArray<string>;
  /** Subnet CIDRs included when exporting to the hub. */
  includeExportRanges?: ReadonlyArray<string>;
};

export type SpokeGatewayIpRangeReservation = {
  /**
   * `/23` CIDR reserved for gateway infrastructure (e.g. `10.1.2.0/23`).
   * Immutable — changing it replaces the spoke.
   */
  ipRange: string;
};

export type SpokeGateway = {
  /**
   * Aggregate processing capacity. Immutable — changing it replaces the
   * spoke.
   */
  capacity?: SpokeGatewayCapacity;
  /**
   * CIDRs reserved for gateway infrastructure. Immutable — changing
   * them replaces the spoke.
   */
  ipRangeReservations?: ReadonlyArray<SpokeGatewayIpRangeReservation>;
};

export type SpokeProps = {
  /**
   * Spoke id (the `{spoke}` segment of
   * `projects/{project}/locations/{location}/spokes/{spoke}`). If
   * omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-63 characters and match
   * `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable — changing it replaces the
   * spoke.
   */
  spokeId?: string;
  /**
   * Location of the spoke. VPC and producer-VPC spokes must use
   * `global`; VPN, VLAN-attachment, router-appliance, and gateway
   * spokes use a region (`us-central1`, …). `US-CENTRAL1` is accepted
   * and normalized to `us-central1`. Immutable — changing it replaces
   * the spoke.
   * @default "global"
   */
  location?: string;
  /**
   * Hub this spoke attaches to — a full resource name
   * `projects/{project}/locations/global/hubs/{hub}` or a hub id.
   * Immutable — changing it replaces the spoke.
   */
  hub: string;
  /**
   * Group this spoke belongs to (star / hybrid-inspection topologies).
   * Immutable — changing it replaces the spoke.
   */
  group?: string;
  /**
   * Human-readable description of the spoke.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * VPC network associated with the spoke. Exactly one of the `linked*`
   * / `gateway` fields must be set.
   */
  linkedVpcNetwork?: LinkedVpcNetwork;
  /**
   * HA VPN tunnels associated with the spoke.
   */
  linkedVpnTunnels?: LinkedVpnTunnels;
  /**
   * VLAN attachments associated with the spoke.
   */
  linkedInterconnectAttachments?: LinkedInterconnectAttachments;
  /**
   * Router appliance VMs associated with the spoke.
   */
  linkedRouterApplianceInstances?: LinkedRouterApplianceInstances;
  /**
   * Producer VPC peered to a service-consumer VPC spoke.
   */
  linkedProducerVpcNetwork?: LinkedProducerVpcNetwork;
  /**
   * NCC gateway that inspects traffic.
   */
  gateway?: SpokeGateway;
};

export type Spoke = Resource<
  "GCP.NetworkConnectivity.Spoke",
  SpokeProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/spokes/{spoke}`. */
    name: string;
    /** Spoke id (last path segment). */
    spokeId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** Hub resource name this spoke is attached to. */
    hub: string | undefined;
    /** Group resource name, if any. */
    group: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Linked VPC network, if this is a VPC spoke. */
    linkedVpcNetwork: LinkedVpcNetwork | undefined;
    /** Linked VPN tunnels, if this is a VPN spoke. */
    linkedVpnTunnels: LinkedVpnTunnels | undefined;
    /** Linked VLAN attachments, if this is an interconnect spoke. */
    linkedInterconnectAttachments: LinkedInterconnectAttachments | undefined;
    /** Linked router appliances, if this is a router-appliance spoke. */
    linkedRouterApplianceInstances: LinkedRouterApplianceInstances | undefined;
    /** Linked producer VPC, if this is a producer-VPC spoke. */
    linkedProducerVpcNetwork: LinkedProducerVpcNetwork | undefined;
    /** Gateway config, if this is a gateway spoke. */
    gateway: SpokeGateway | undefined;
    /** Server-reported spoke type (`VPC_NETWORK`, `VPN_TUNNEL`, …). */
    spokeType: string | undefined;
    /** Server-generated UUID, unique across spokes. */
    uniqueId: string | undefined;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Reasons the spoke is not `ACTIVE`, if any. */
    reasons: ReadonlyArray<SpokeStateReason>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Connectivity Center spoke — one VPC, VPN tunnel set, VLAN
 * attachment set, router-appliance set, producer VPC, or gateway
 * attached to a hub.
 *
 * Set exactly one of `linkedVpcNetwork`, `linkedVpnTunnels`,
 * `linkedInterconnectAttachments`, `linkedRouterApplianceInstances`,
 * `linkedProducerVpcNetwork`, or `gateway`. VPC spokes live at
 * `location: "global"`; hybrid spokes are regional.
 *
 * Changing `spokeId`, `location`, `hub`, `group`, or the linked
 * resource identity replaces the spoke. Description, labels, and
 * include/exclude CIDR ranges update in place.
 *
 * ### Creating a Spoke
 * **Example:** VPC spoke on a generated name
 * ```typescript
 * const network = yield* GCP.Compute.Network("AppVpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {});
 * const spoke = yield* GCP.NetworkConnectivity.Spoke("AppVpcSpoke", {
 *   hub: hub.name,
 *   linkedVpcNetwork: { uri: network.selfLink! },
 * });
 * ```
 *
 * **Example:** Named VPC spoke with labels and export filters
 * ```typescript
 * const spoke = yield* GCP.NetworkConnectivity.Spoke("AppVpcSpoke", {
 *   spokeId: "app-vpc",
 *   location: "global",
 *   hub: hub.name,
 *   description: "app vpc",
 *   labels: { env: "prod" },
 *   linkedVpcNetwork: {
 *     uri: network.selfLink!,
 *     includeExportRanges: ["10.0.0.0/8"],
 *   },
 * });
 * ```
 *
 * ### Updating a Spoke
 * **Example:** Description, labels, and export filters
 * ```typescript
 * const spoke = yield* GCP.NetworkConnectivity.Spoke("AppVpcSpoke", {
 *   spokeId: "app-vpc",
 *   location: "global",
 *   hub: hub.name,
 *   description: "app vpc v2",
 *   labels: { env: "prod", role: "spoke" },
 *   linkedVpcNetwork: {
 *     uri: network.selfLink!,
 *     includeExportRanges: ["10.0.0.0/8", "192.168.0.0/16"],
 *   },
 * });
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const Spoke = Resource<Spoke>("GCP.NetworkConnectivity.Spoke");

export class SpokeNotResolved extends Data.TaggedError(
  "GCP.NetworkConnectivity.SpokeNotResolved",
)<{
  name: string;
}> {}

export class SpokeFailed extends Data.TaggedError(
  "GCP.NetworkConnectivity.SpokeFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class SpokeStillExists extends Data.TaggedError(
  "GCP.NetworkConnectivity.SpokeStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `s${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "spoke";
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const resourceName = (project: string, location: string, spokeId: string) =>
  `projects/${project}/locations/${location}/spokes/${spokeId}`;

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const spokesAt = parts.lastIndexOf("spokes");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    spokeId:
      spokesAt >= 0 && parts[spokesAt + 1]
        ? parts[spokesAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, spokeId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (spokeId !== undefined) return spokeId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const resolveHub = (hub: string, project: string) =>
  hub.includes("/")
    ? hub
    : `projects/${project}/locations/${DEFAULT_LOCATION}/hubs/${hub}`;

const rangesKey = (ranges: ReadonlyArray<string> | undefined) =>
  JSON.stringify([...(ranges ?? [])].slice().sort());

const resourceKey = (uri: string | undefined) => {
  if (uri === undefined || uri.length === 0) return "";
  return lastSegment(uri);
};

const resourceKeys = (uris: ReadonlyArray<string> | undefined) =>
  JSON.stringify([...(uris ?? [])].map(resourceKey).sort());

const instancesKey = (
  instances: ReadonlyArray<RouterApplianceInstance> | undefined,
) =>
  JSON.stringify(
    [...(instances ?? [])]
      .map((instance) => ({
        vm: resourceKey(instance.virtualMachine),
        ip: instance.ipAddress,
      }))
      .sort((left, right) =>
        left.vm === right.vm
          ? left.ip.localeCompare(right.ip)
          : left.vm.localeCompare(right.vm),
      ),
  );

const gatewayKey = (gateway: SpokeGateway | undefined) =>
  JSON.stringify({
    capacity: gateway?.capacity ?? "",
    reservations: [...(gateway?.ipRangeReservations ?? [])]
      .map((reservation) => reservation.ipRange)
      .sort(),
  });

const linkedIdentity = (props: {
  linkedVpcNetwork?: LinkedVpcNetwork;
  linkedVpnTunnels?: LinkedVpnTunnels;
  linkedInterconnectAttachments?: LinkedInterconnectAttachments;
  linkedRouterApplianceInstances?: LinkedRouterApplianceInstances;
  linkedProducerVpcNetwork?: LinkedProducerVpcNetwork;
  gateway?: SpokeGateway;
}) => {
  if (props.linkedVpcNetwork) {
    return `vpc:${resourceKey(props.linkedVpcNetwork.uri)}`;
  }
  if (props.linkedVpnTunnels) {
    return `vpn:${resourceKeys(props.linkedVpnTunnels.uris)}:${
      props.linkedVpnTunnels.siteToSiteDataTransfer === true
    }`;
  }
  if (props.linkedInterconnectAttachments) {
    return `interconnect:${resourceKeys(props.linkedInterconnectAttachments.uris)}:${
      props.linkedInterconnectAttachments.siteToSiteDataTransfer === true
    }`;
  }
  if (props.linkedRouterApplianceInstances) {
    return `appliance:${
      props.linkedRouterApplianceInstances.siteToSiteDataTransfer === true
    }`;
  }
  if (props.linkedProducerVpcNetwork) {
    return `producer:${resourceKey(props.linkedProducerVpcNetwork.network)}:${
      props.linkedProducerVpcNetwork.peering
    }`;
  }
  if (props.gateway) {
    return `gateway:${gatewayKey(props.gateway)}`;
  }
  return "";
};

const toReasons = (
  reasons: networkconnectivity.StateReasonList | undefined,
): SpokeStateReason[] =>
  (reasons ?? []).map((reason) => ({
    code: reason.code,
    message: reason.message,
    userDetails: reason.userDetails,
  }));

const toLinkedVpc = (
  value: networkconnectivity.LinkedVpcNetwork | undefined,
): LinkedVpcNetwork | undefined => {
  if (value?.uri === undefined || value.uri.length === 0) return undefined;
  return {
    uri: value.uri,
    excludeExportRanges: value.excludeExportRanges,
    includeExportRanges: value.includeExportRanges,
  };
};

const toLinkedVpn = (
  value: networkconnectivity.LinkedVpnTunnels | undefined,
): LinkedVpnTunnels | undefined => {
  if (value === undefined) return undefined;
  const uris = value.uris ?? [];
  if (uris.length === 0 && value.vpcNetwork === undefined) return undefined;
  return {
    uris,
    siteToSiteDataTransfer: value.siteToSiteDataTransfer,
    includeImportRanges: value.includeImportRanges,
    excludeImportRanges: value.excludeImportRanges,
    includeExportRanges: value.includeExportRanges,
    excludeExportRanges: value.excludeExportRanges,
  };
};

const toLinkedInterconnect = (
  value: networkconnectivity.LinkedInterconnectAttachments | undefined,
): LinkedInterconnectAttachments | undefined => {
  if (value === undefined) return undefined;
  const uris = value.uris ?? [];
  if (uris.length === 0 && value.vpcNetwork === undefined) return undefined;
  return {
    uris,
    siteToSiteDataTransfer: value.siteToSiteDataTransfer,
    includeImportRanges: value.includeImportRanges,
    excludeImportRanges: value.excludeImportRanges,
    includeExportRanges: value.includeExportRanges,
    excludeExportRanges: value.excludeExportRanges,
  };
};

const toLinkedAppliances = (
  value: networkconnectivity.LinkedRouterApplianceInstances | undefined,
): LinkedRouterApplianceInstances | undefined => {
  if (value === undefined) return undefined;
  const instances = (value.instances ?? [])
    .filter(
      (
        instance,
      ): instance is networkconnectivity.RouterApplianceInstance & {
        virtualMachine: string;
        ipAddress: string;
      } =>
        typeof instance.virtualMachine === "string" &&
        typeof instance.ipAddress === "string",
    )
    .map((instance) => ({
      virtualMachine: instance.virtualMachine,
      ipAddress: instance.ipAddress,
    }));
  if (instances.length === 0 && value.vpcNetwork === undefined) {
    return undefined;
  }
  return {
    instances,
    siteToSiteDataTransfer: value.siteToSiteDataTransfer,
    includeImportRanges: value.includeImportRanges,
    excludeImportRanges: value.excludeImportRanges,
    includeExportRanges: value.includeExportRanges,
    excludeExportRanges: value.excludeExportRanges,
  };
};

const toLinkedProducer = (
  value: networkconnectivity.LinkedProducerVpcNetwork | undefined,
): LinkedProducerVpcNetwork | undefined => {
  if (value?.network === undefined || value.peering === undefined) {
    return undefined;
  }
  return {
    network: value.network,
    peering: value.peering,
    excludeExportRanges: value.excludeExportRanges,
    includeExportRanges: value.includeExportRanges,
  };
};

const toGateway = (
  value: networkconnectivity.Gateway | undefined,
): SpokeGateway | undefined => {
  if (value === undefined) return undefined;
  const ipRangeReservations = (value.ipRangeReservations ?? [])
    .filter(
      (
        reservation,
      ): reservation is networkconnectivity.IpRangeReservation & {
        ipRange: string;
      } => typeof reservation.ipRange === "string",
    )
    .map((reservation) => ({ ipRange: reservation.ipRange }));
  if (
    value.capacity === undefined &&
    ipRangeReservations.length === 0 &&
    (value.cloudRouters ?? []).length === 0
  ) {
    return undefined;
  }
  return {
    capacity: value.capacity,
    ipRangeReservations:
      ipRangeReservations.length > 0 ? ipRangeReservations : undefined,
  };
};

const toAttrs = (spoke: networkconnectivity.Spoke, project: string) => {
  const name = spoke.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    spokeId: parsed.spokeId,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    hub: spoke.hub,
    group: spoke.group,
    description: spoke.description,
    labels: userLabels(spoke.labels),
    linkedVpcNetwork: toLinkedVpc(spoke.linkedVpcNetwork),
    linkedVpnTunnels: toLinkedVpn(spoke.linkedVpnTunnels),
    linkedInterconnectAttachments: toLinkedInterconnect(
      spoke.linkedInterconnectAttachments,
    ),
    linkedRouterApplianceInstances: toLinkedAppliances(
      spoke.linkedRouterApplianceInstances,
    ),
    linkedProducerVpcNetwork: toLinkedProducer(spoke.linkedProducerVpcNetwork),
    gateway: toGateway(spoke.gateway),
    spokeType: spoke.spokeType,
    uniqueId: spoke.uniqueId,
    state: spoke.state,
    reasons: toReasons(spoke.reasons),
    createTime: spoke.createTime,
    updateTime: spoke.updateTime,
  };
};

const fromLinkedVpc = (
  value: LinkedVpcNetwork,
): networkconnectivity.LinkedVpcNetwork => ({
  uri: value.uri,
  excludeExportRanges: value.excludeExportRanges
    ? [...value.excludeExportRanges]
    : undefined,
  includeExportRanges: value.includeExportRanges
    ? [...value.includeExportRanges]
    : undefined,
});

const fromLinkedVpn = (
  value: LinkedVpnTunnels,
): networkconnectivity.LinkedVpnTunnels => ({
  uris: [...value.uris],
  siteToSiteDataTransfer: value.siteToSiteDataTransfer,
  includeImportRanges: value.includeImportRanges
    ? [...value.includeImportRanges]
    : undefined,
  excludeImportRanges: value.excludeImportRanges
    ? [...value.excludeImportRanges]
    : undefined,
  includeExportRanges: value.includeExportRanges
    ? [...value.includeExportRanges]
    : undefined,
  excludeExportRanges: value.excludeExportRanges
    ? [...value.excludeExportRanges]
    : undefined,
});

const fromLinkedInterconnect = (
  value: LinkedInterconnectAttachments,
): networkconnectivity.LinkedInterconnectAttachments => ({
  uris: [...value.uris],
  siteToSiteDataTransfer: value.siteToSiteDataTransfer,
  includeImportRanges: value.includeImportRanges
    ? [...value.includeImportRanges]
    : undefined,
  excludeImportRanges: value.excludeImportRanges
    ? [...value.excludeImportRanges]
    : undefined,
  includeExportRanges: value.includeExportRanges
    ? [...value.includeExportRanges]
    : undefined,
  excludeExportRanges: value.excludeExportRanges
    ? [...value.excludeExportRanges]
    : undefined,
});

const fromLinkedAppliances = (
  value: LinkedRouterApplianceInstances,
): networkconnectivity.LinkedRouterApplianceInstances => ({
  instances: value.instances.map((instance) => ({
    virtualMachine: instance.virtualMachine,
    ipAddress: instance.ipAddress,
  })),
  siteToSiteDataTransfer: value.siteToSiteDataTransfer,
  includeImportRanges: value.includeImportRanges
    ? [...value.includeImportRanges]
    : undefined,
  excludeImportRanges: value.excludeImportRanges
    ? [...value.excludeImportRanges]
    : undefined,
  includeExportRanges: value.includeExportRanges
    ? [...value.includeExportRanges]
    : undefined,
  excludeExportRanges: value.excludeExportRanges
    ? [...value.excludeExportRanges]
    : undefined,
});

const fromLinkedProducer = (
  value: LinkedProducerVpcNetwork,
): networkconnectivity.LinkedProducerVpcNetwork => ({
  network: value.network,
  peering: value.peering,
  excludeExportRanges: value.excludeExportRanges
    ? [...value.excludeExportRanges]
    : undefined,
  includeExportRanges: value.includeExportRanges
    ? [...value.includeExportRanges]
    : undefined,
});

const fromGateway = (value: SpokeGateway): networkconnectivity.Gateway => ({
  capacity: value.capacity,
  ipRangeReservations: value.ipRangeReservations?.map((reservation) => ({
    ipRange: reservation.ipRange,
  })),
});

const desiredSpokeBody = (
  news: SpokeProps,
  project: string,
  labels: Record<string, string>,
): networkconnectivity.Spoke => ({
  hub: resolveHub(news.hub, project),
  group: news.group,
  description: news.description,
  labels,
  linkedVpcNetwork: news.linkedVpcNetwork
    ? fromLinkedVpc(news.linkedVpcNetwork)
    : undefined,
  linkedVpnTunnels: news.linkedVpnTunnels
    ? fromLinkedVpn(news.linkedVpnTunnels)
    : undefined,
  linkedInterconnectAttachments: news.linkedInterconnectAttachments
    ? fromLinkedInterconnect(news.linkedInterconnectAttachments)
    : undefined,
  linkedRouterApplianceInstances: news.linkedRouterApplianceInstances
    ? fromLinkedAppliances(news.linkedRouterApplianceInstances)
    : undefined,
  linkedProducerVpcNetwork: news.linkedProducerVpcNetwork
    ? fromLinkedProducer(news.linkedProducerVpcNetwork)
    : undefined,
  gateway: news.gateway ? fromGateway(news.gateway) : undefined,
});

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsSpokes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isPendingState = (state: string | undefined) =>
  state === "CREATING" ||
  state === "UPDATING" ||
  state === "DELETING" ||
  state === "ACCEPTING" ||
  state === "REJECTING" ||
  state === "INACTIVE" ||
  state === "STATE_UNSPECIFIED";

const isFailedState = (spoke: networkconnectivity.Spoke) =>
  spoke.state === "FAILED" ||
  spoke.state === "OBSOLETE" ||
  (spoke.reasons ?? []).some((reason) => reason.code === "REJECTED");

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (spoke): spoke is networkconnectivity.Spoke => spoke !== undefined,
      () => new SpokeNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (spoke) => !isFailedState(spoke),
      (spoke) => new SpokeFailed({ name, state: spoke.state }),
    ),
    Effect.filterOrFail(
      (spoke) => !isPendingState(spoke.state),
      () => new SpokeNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkConnectivity.SpokeNotResolved",
      times: 120,
      schedule: Schedule.spaced("10 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((spoke) =>
      spoke === undefined
        ? Effect.void
        : Effect.fail(new SpokeStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkConnectivity.SpokeStillExists",
      times: 60,
      schedule: Schedule.spaced("10 seconds"),
    }),
  );

const waitUntilHubDropsSpoke = (hub: string, spokeName: string) =>
  networkconnectivity
    .listSpokesProjectsLocationsGlobalHubs({
      name: hub,
      pageSize: 100,
    })
    .pipe(
      Effect.flatMap((page) => {
        const still = (page.spokes ?? []).some(
          (spoke) =>
            spoke.name === spokeName ||
            resourceKey(spoke.name) === resourceKey(spokeName),
        );
        return still
          ? Effect.fail(new SpokeStillExists({ name: spokeName }))
          : Effect.void;
      }),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.NetworkConnectivity.SpokeStillExists",
        times: 8,
        schedule: Schedule.spaced("3 seconds"),
      }),
      Effect.catchTag(
        "GCP.NetworkConnectivity.SpokeStillExists",
        () => Effect.void,
      ),
      Effect.catchTag("NotFound", () => Effect.void),
    );

const waitUntilHubDropsVpc = (hub: string, networkKey: string) => {
  if (networkKey.length === 0) return Effect.void;
  return networkconnectivity.getProjectsLocationsGlobalHubs({ name: hub }).pipe(
    Effect.flatMap((hubResource) => {
      const still = (hubResource.routingVpcs ?? []).some(
        (vpc) => resourceKey(vpc.uri) === networkKey,
      );
      return still
        ? Effect.fail(new SpokeStillExists({ name: hub }))
        : Effect.void;
    }),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkConnectivity.SpokeStillExists",
      times: 8,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.catchTag(
      "GCP.NetworkConnectivity.SpokeStillExists",
      () => Effect.void,
    ),
    Effect.catchTag("NotFound", () => Effect.void),
  );
};

const listOwnedSpokes = (project: string, location: string) =>
  networkconnectivity.listProjectsLocationsSpokes
    .pages({
      parent: parentOf(project, location),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.spokes ?? [])),
      Stream.filter((spoke) =>
        Object.keys(spoke.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((spoke) => toAttrs(spoke, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const rangeFieldsChanged = (
  current: ReturnType<typeof toAttrs>,
  news: SpokeProps,
) => {
  const masks: string[] = [];
  if (news.linkedVpcNetwork) {
    const observed = current.linkedVpcNetwork;
    if (
      rangesKey(observed?.includeExportRanges) !==
      rangesKey(news.linkedVpcNetwork.includeExportRanges)
    ) {
      masks.push("linkedVpcNetwork.includeExportRanges");
    }
    if (
      rangesKey(observed?.excludeExportRanges) !==
      rangesKey(news.linkedVpcNetwork.excludeExportRanges)
    ) {
      masks.push("linkedVpcNetwork.excludeExportRanges");
    }
  }
  if (news.linkedVpnTunnels) {
    const observed = current.linkedVpnTunnels;
    if (
      rangesKey(observed?.includeImportRanges) !==
      rangesKey(news.linkedVpnTunnels.includeImportRanges)
    ) {
      masks.push("linkedVpnTunnels.includeImportRanges");
    }
    if (
      rangesKey(observed?.excludeImportRanges) !==
      rangesKey(news.linkedVpnTunnels.excludeImportRanges)
    ) {
      masks.push("linkedVpnTunnels.excludeImportRanges");
    }
    if (
      rangesKey(observed?.includeExportRanges) !==
      rangesKey(news.linkedVpnTunnels.includeExportRanges)
    ) {
      masks.push("linkedVpnTunnels.includeExportRanges");
    }
    if (
      rangesKey(observed?.excludeExportRanges) !==
      rangesKey(news.linkedVpnTunnels.excludeExportRanges)
    ) {
      masks.push("linkedVpnTunnels.excludeExportRanges");
    }
  }
  if (news.linkedInterconnectAttachments) {
    const observed = current.linkedInterconnectAttachments;
    if (
      rangesKey(observed?.includeImportRanges) !==
      rangesKey(news.linkedInterconnectAttachments.includeImportRanges)
    ) {
      masks.push("linkedInterconnectAttachments.includeImportRanges");
    }
    if (
      rangesKey(observed?.excludeImportRanges) !==
      rangesKey(news.linkedInterconnectAttachments.excludeImportRanges)
    ) {
      masks.push("linkedInterconnectAttachments.excludeImportRanges");
    }
    if (
      rangesKey(observed?.includeExportRanges) !==
      rangesKey(news.linkedInterconnectAttachments.includeExportRanges)
    ) {
      masks.push("linkedInterconnectAttachments.includeExportRanges");
    }
    if (
      rangesKey(observed?.excludeExportRanges) !==
      rangesKey(news.linkedInterconnectAttachments.excludeExportRanges)
    ) {
      masks.push("linkedInterconnectAttachments.excludeExportRanges");
    }
  }
  if (news.linkedRouterApplianceInstances) {
    const observed = current.linkedRouterApplianceInstances;
    if (
      instancesKey(observed?.instances) !==
      instancesKey(news.linkedRouterApplianceInstances.instances)
    ) {
      masks.push("linkedRouterApplianceInstances.instances");
    }
    if (
      rangesKey(observed?.includeImportRanges) !==
      rangesKey(news.linkedRouterApplianceInstances.includeImportRanges)
    ) {
      masks.push("linkedRouterApplianceInstances.includeImportRanges");
    }
    if (
      rangesKey(observed?.excludeImportRanges) !==
      rangesKey(news.linkedRouterApplianceInstances.excludeImportRanges)
    ) {
      masks.push("linkedRouterApplianceInstances.excludeImportRanges");
    }
    if (
      rangesKey(observed?.includeExportRanges) !==
      rangesKey(news.linkedRouterApplianceInstances.includeExportRanges)
    ) {
      masks.push("linkedRouterApplianceInstances.includeExportRanges");
    }
    if (
      rangesKey(observed?.excludeExportRanges) !==
      rangesKey(news.linkedRouterApplianceInstances.excludeExportRanges)
    ) {
      masks.push("linkedRouterApplianceInstances.excludeExportRanges");
    }
  }
  if (news.linkedProducerVpcNetwork) {
    const observed = current.linkedProducerVpcNetwork;
    if (
      rangesKey(observed?.includeExportRanges) !==
      rangesKey(news.linkedProducerVpcNetwork.includeExportRanges)
    ) {
      masks.push("linkedProducerVpcNetwork.includeExportRanges");
    }
    if (
      rangesKey(observed?.excludeExportRanges) !==
      rangesKey(news.linkedProducerVpcNetwork.excludeExportRanges)
    ) {
      masks.push("linkedProducerVpcNetwork.excludeExportRanges");
    }
  }
  return masks;
};

export const SpokeProvider = () =>
  Provider.succeed(Spoke, {
    stables: [
      "name",
      "spokeId",
      "project",
      "location",
      "hub",
      "uniqueId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.spokeId ?? output?.spokeId;
      const nextId = news.spokeId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const locationChanged = previousLocation !== nextLocation;

      const previousHub = resourceKey(olds?.hub ?? output?.hub);
      const nextHub = resourceKey(news.hub);
      const hubChanged =
        previousHub.length > 0 && nextHub.length > 0 && previousHub !== nextHub;

      const previousGroup = resourceKey(olds?.group ?? output?.group);
      const nextGroup = resourceKey(news.group);
      const groupChanged =
        news.group !== undefined &&
        previousGroup.length > 0 &&
        nextGroup.length > 0 &&
        previousGroup !== nextGroup;

      const previousLinked = linkedIdentity({
        linkedVpcNetwork: olds?.linkedVpcNetwork ?? output?.linkedVpcNetwork,
        linkedVpnTunnels: olds?.linkedVpnTunnels ?? output?.linkedVpnTunnels,
        linkedInterconnectAttachments:
          olds?.linkedInterconnectAttachments ??
          output?.linkedInterconnectAttachments,
        linkedRouterApplianceInstances:
          olds?.linkedRouterApplianceInstances ??
          output?.linkedRouterApplianceInstances,
        linkedProducerVpcNetwork:
          olds?.linkedProducerVpcNetwork ?? output?.linkedProducerVpcNetwork,
        gateway: olds?.gateway ?? output?.gateway,
      });
      const nextLinked = linkedIdentity(news);
      const linkedChanged =
        nextLinked.length > 0 &&
        previousLinked.length > 0 &&
        nextLinked !== previousLinked;

      if (
        !idChanged &&
        !locationChanged &&
        !hubChanged &&
        !groupChanged &&
        !linkedChanged
      ) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst:
          !idChanged &&
          !locationChanged &&
          (hubChanged || groupChanged || linkedChanged),
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const spokeId = yield* toId(id, olds?.spokeId, output?.spokeId);
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name = output?.name ?? resourceName(env.project, location, spokeId);
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
        const aggregated = yield* listOwnedSpokes(env.project, "-");
        if (aggregated.length > 0) return aggregated;
        return yield* listOwnedSpokes(env.project, DEFAULT_LOCATION);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const spokeId = yield* toId(id, news.spokeId, output?.spokeId);
      const location = normalizeLocation(news.location ?? output?.location);
      const name = output?.name ?? resourceName(env.project, location, spokeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const body = desiredSpokeBody(news, env.project, desiredLabels);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsSpokes({
            parent: parentOf(env.project, location),
            spokeId,
            body,
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
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new SpokeNotResolved({ name });
      }

      const attrs = toAttrs(current, env.project);
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const rangeMasks = rangeFieldsChanged(attrs, news);

      if (labelsChanged || descriptionChanged || rangeMasks.length > 0) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          ...rangeMasks,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networkconnectivity.patchProjectsLocationsSpokes({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              ...body,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsSpokes({ name: output.name })
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
      yield* waitUntilGone(output.name);
      if (output.hub) {
        yield* waitUntilHubDropsSpoke(output.hub, output.name);
        yield* waitUntilHubDropsVpc(
          output.hub,
          resourceKey(output.linkedVpcNetwork?.uri),
        );
      }
    }),
  });
