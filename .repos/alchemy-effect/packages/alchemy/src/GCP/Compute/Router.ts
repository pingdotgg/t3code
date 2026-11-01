import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_ADVERTISE_MODE = "DEFAULT";
const DEFAULT_KEEPALIVE = 20;
const MAX_NAME_LENGTH = 63;

const OWNERSHIP_KEYS = [
  "alchemy-stack",
  "alchemy-stage",
  "alchemy-id",
] as const;

export type RouterAdvertisedIpRange = {
  /** CIDR to advertise (for example `10.0.0.0/8`). */
  range: string;
  /** Optional description of this advertised range. */
  description?: string;
};

export type RouterBgp = {
  /**
   * Local BGP ASN. Must be an RFC6996 private ASN (16-bit or 32-bit).
   * Shared by every VPN tunnel attached to this router.
   */
  asn: number;
  /**
   * Advertisement mode. `CUSTOM` requires `advertisedGroups` and/or
   * `advertisedIpRanges`.
   * @default "DEFAULT"
   */
  advertiseMode?: compute.RouterBgpAdvertiseModeEnum;
  /**
   * Prefix groups to advertise when `advertiseMode` is `CUSTOM`. The only
   * valid value today is `ALL_SUBNETS`.
   */
  advertisedGroups?: string[];
  /**
   * Individual CIDRs to advertise when `advertiseMode` is `CUSTOM`.
   */
  advertisedIpRanges?: RouterAdvertisedIpRange[];
  /**
   * Seconds between BGP keepalives (20–60). Hold time is 3× this value.
   * @default 20
   */
  keepaliveInterval?: number;
  /**
   * Link-local IPv4 `/30` or larger from `169.254.0.0/16` used as the BGP
   * identifier (router ID).
   */
  identifierRange?: string;
};

export type RouterNatSubnetwork = {
  /** Subnetwork name, partial URL, or full resource URL. */
  name: string;
  /**
   * Ranges of this subnetwork to translate (`ALL_IP_RANGES`,
   * `PRIMARY_IP_RANGE`, `LIST_OF_SECONDARY_IP_RANGES`).
   * @default ["ALL_IP_RANGES"]
   */
  sourceIpRangesToNat?: compute.RouterNatSubnetworkToNatSourceIpRangesToNatItemEnum[];
  /**
   * Secondary range names to translate. Requires
   * `LIST_OF_SECONDARY_IP_RANGES` in `sourceIpRangesToNat`.
   */
  secondaryIpRangeNames?: string[];
};

export type RouterNatLogConfig = {
  /** Export NAT logs. */
  enable: boolean;
  /**
   * Which connections to log (`ERRORS_ONLY`, `TRANSLATIONS_ONLY`, `ALL`).
   * @default "ALL"
   */
  filter?: compute.RouterNatLogConfigFilterEnum;
};

export type RouterNat = {
  /** NAT name, unique within the router (RFC1035, 1-63 chars). */
  name: string;
  /**
   * Which subnetwork ranges are translated: `ALL_SUBNETWORKS_ALL_IP_RANGES`,
   * `ALL_SUBNETWORKS_ALL_PRIMARY_IP_RANGES`, or `LIST_OF_SUBNETWORKS`
   * (with `subnetworks`).
   */
  sourceSubnetworkIpRangesToNat: compute.RouterNatSourceSubnetworkIpRangesToNatEnum;
  /** Subnetworks to translate when `LIST_OF_SUBNETWORKS` is selected. */
  subnetworks?: RouterNatSubnetwork[];
  /**
   * `AUTO_ONLY` lets Google allocate external IPs; `MANUAL_ONLY` uses
   * `natIps`.
   * @default "AUTO_ONLY"
   */
  natIpAllocateOption?: compute.RouterNatNatIpAllocateOptionEnum;
  /**
   * Static external addresses (`GCP.Compute.Address` self links or names)
   * used with `MANUAL_ONLY`.
   */
  natIps?: string[];
  /** Minimum ports allocated to each VM. */
  minPortsPerVm?: number;
  /** Maximum ports per VM when dynamic port allocation is enabled. */
  maxPortsPerVm?: number;
  /** Enable dynamic port allocation. */
  enableDynamicPortAllocation?: boolean;
  /** Enable endpoint-independent mapping. */
  enableEndpointIndependentMapping?: boolean;
  /** UDP idle timeout in seconds. */
  udpIdleTimeoutSec?: number;
  /** ICMP idle timeout in seconds. */
  icmpIdleTimeoutSec?: number;
  /** TCP established-connection idle timeout in seconds. */
  tcpEstablishedIdleTimeoutSec?: number;
  /** TCP transitory-connection idle timeout in seconds. */
  tcpTransitoryIdleTimeoutSec?: number;
  /** NAT logging. */
  logConfig?: RouterNatLogConfig;
};

export type RouterProps = {
  /**
   * Router name (RFC1035, 1-63 chars). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the router.
   */
  routerName?: string;
  /**
   * Region the router lives in. Immutable — changing it replaces the
   * router. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * VPC network this router belongs to. Accepts a name (`default`), a
   * partial URL (`global/networks/default`), or a full resource URL.
   * Immutable — changing it replaces the router.
   */
  network: string;
  /**
   * Optional description. Compute Router has no `labels` field, so Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored
   * in the description for `list` / nuke.
   */
  description?: string;
  /**
   * BGP configuration. Omit when the router is NAT-only.
   */
  bgp?: RouterBgp;
  /**
   * Cloud NAT gateways hosted on this router. Updated in place. Omit to
   * leave the router's NATs unmanaged; `[]` removes all of them.
   */
  nats?: RouterNat[];
  /**
   * Dedicated for encrypted VLAN attachments. Immutable — changing it
   * replaces the router.
   * @default false
   */
  encryptedInterconnectRouter?: boolean;
  /**
   * NCC Gateway spoke URI. Immutable — changing it replaces the router.
   * Mutually exclusive with `network` at the API.
   */
  nccGateway?: string;
};

export type Router = Resource<
  "GCP.Compute.Router",
  RouterProps,
  {
    /** RFC1035 router name. */
    routerName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Parent VPC network URL. */
    network: string;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** BGP configuration, if set. */
    bgp: RouterBgp | undefined;
    /** Cloud NAT gateways on this router. */
    nats: RouterNat[];
    /** Whether this router is dedicated to encrypted interconnect. */
    encryptedInterconnectRouter: boolean;
    /** NCC Gateway spoke URI, if any. */
    nccGateway: string | undefined;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    routerId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Cloud Router.
 *
 * Cloud Routers advertise VPC routes over BGP to VPN tunnels and
 * interconnects, and they host Cloud NAT. Compute Router has no `labels`
 * field — Alchemy stamps `alchemy-stack` / `alchemy-stage` / `alchemy-id`
 * into the description so `list` and `pnpm nuke:gcp` can find owned
 * routers.
 *
 * Name, region, network, `encryptedInterconnectRouter`, and `nccGateway`
 * are immutable. Description and BGP (ASN, advertise mode, advertised
 * ranges, keepalive) and Cloud NAT gateways (`nats`) update in place via
 * `routers.patch`.
 *
 * ### Creating a Router
 * **Example:** Generated name on a custom-mode VPC
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const router = yield* GCP.Compute.Router("Edge", {
 *   network: network.networkName,
 * });
 * ```
 *
 * **Example:** Named router with BGP
 * ```typescript
 * const router = yield* GCP.Compute.Router("Edge", {
 *   routerName: "app-router",
 *   region: "us-central1",
 *   network: "app-vpc",
 *   description: "edge bgp",
 *   bgp: { asn: 65001, advertiseMode: "DEFAULT" },
 * });
 * ```
 *
 * ### Cloud NAT
 * **Example:** NAT a subnet through a static egress IP
 * ```typescript
 * const egressIp = yield* GCP.Compute.Address("EgressIp", {
 *   addressType: "EXTERNAL",
 * });
 * const router = yield* GCP.Compute.Router("Nat", {
 *   network: network.networkName,
 *   nats: [
 *     {
 *       name: "egress",
 *       sourceSubnetworkIpRangesToNat: "LIST_OF_SUBNETWORKS",
 *       subnetworks: [{ name: subnet.subnetworkName }],
 *       natIpAllocateOption: "MANUAL_ONLY",
 *       natIps: [egressIp.selfLink.as<string>()],
 *       logConfig: { enable: true, filter: "ERRORS_ONLY" },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Custom advertisements
 * **Example:** Advertise all subnets plus a CIDR
 * ```typescript
 * const router = yield* GCP.Compute.Router("Edge", {
 *   network: network.networkName,
 *   bgp: {
 *     asn: 65001,
 *     advertiseMode: "CUSTOM",
 *     advertisedGroups: ["ALL_SUBNETS"],
 *     advertisedIpRanges: [
 *       { range: "10.0.0.0/8", description: "rfc1918" },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Router = Resource<Router>("GCP.Compute.Router");

export class RouterNotResolved extends Data.TaggedError(
  "GCP.Compute.RouterNotResolved",
)<{
  routerName: string;
  region: string;
}> {}

export class RouterOperationPending extends Data.TaggedError(
  "GCP.Compute.RouterOperationPending",
)<{
  operation: string;
  status: string | undefined;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const linkKey = (value: string | undefined) =>
  value === undefined || value === "" ? "" : lastSegment(value).toLowerCase();

const networkRef = (project: string, network: string) => {
  if (network.includes("/")) {
    return network.startsWith("projects/") || network.startsWith("http")
      ? network
      : `projects/${project}/${network.replace(/^\//, "")}`;
  }
  return `projects/${project}/global/networks/${network}`;
};

const encodeDescription = (
  internal: Record<string, string>,
  user?: string,
): string => {
  const marker = OWNERSHIP_KEYS.map(
    (key) => `${key}=${internal[key] ?? ""}`,
  ).join(" ");
  return user && user.length > 0 ? `${marker}\n${user}` : marker;
};

const parseDescription = (description: string | undefined) => {
  if (!description) {
    return { labels: {} as Record<string, string>, description: undefined };
  }
  const newline = description.indexOf("\n");
  const first = newline === -1 ? description : description.slice(0, newline);
  const rest = newline === -1 ? undefined : description.slice(newline + 1);
  if (!first.includes("alchemy-id=") || !first.includes("alchemy-stack=")) {
    return { labels: {} as Record<string, string>, description };
  }
  const labels: Record<string, string> = {};
  for (const part of first.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return {
    labels,
    description: rest && rest.length > 0 ? rest : undefined,
  };
};

const hasAlchemyMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toRouterName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `r${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const groupsKey = (groups: ReadonlyArray<string> | undefined) =>
  [...(groups ?? [])]
    .map((group) => group.toUpperCase())
    .sort()
    .join("\0");

const rangesKey = (
  ranges: ReadonlyArray<RouterAdvertisedIpRange> | undefined,
) =>
  JSON.stringify(
    [...(ranges ?? [])]
      .map((range) => ({
        range: range.range,
        description: range.description ?? "",
      }))
      .sort((a, b) => a.range.localeCompare(b.range)),
  );

const toAdvertiseMode = (
  value: string | undefined,
): compute.RouterBgpAdvertiseModeEnum | undefined => {
  switch (value) {
    case "CUSTOM":
    case "DEFAULT":
      return value;
    default:
      return undefined;
  }
};

const toBgp = (bgp: compute.RouterBgp | undefined): RouterBgp | undefined => {
  if (bgp === undefined || bgp.asn === undefined) return undefined;
  return {
    asn: bgp.asn,
    advertiseMode: toAdvertiseMode(bgp.advertiseMode),
    advertisedGroups: bgp.advertisedGroups,
    advertisedIpRanges: (bgp.advertisedIpRanges ?? [])
      .filter(
        (range): range is compute.RouterAdvertisedIpRange & { range: string } =>
          typeof range.range === "string" && range.range.length > 0,
      )
      .map((range) => ({
        range: range.range,
        description: range.description,
      })),
    keepaliveInterval: bgp.keepaliveInterval,
    identifierRange: bgp.identifierRange,
  };
};

const desiredBgp = (bgp: RouterBgp): compute.RouterBgp => {
  const advertiseMode = bgp.advertiseMode ?? DEFAULT_ADVERTISE_MODE;
  const body: compute.RouterBgp = {
    asn: bgp.asn,
    advertiseMode,
    keepaliveInterval: bgp.keepaliveInterval ?? DEFAULT_KEEPALIVE,
  };
  if (advertiseMode === "CUSTOM") {
    body.advertisedGroups = bgp.advertisedGroups ?? [];
    body.advertisedIpRanges = (bgp.advertisedIpRanges ?? []).map((range) => ({
      range: range.range,
      description: range.description,
    }));
  }
  if (bgp.identifierRange !== undefined) {
    body.identifierRange = bgp.identifierRange;
  }
  return body;
};

const bgpEqual = (observed: RouterBgp | undefined, desired: RouterBgp) => {
  if (observed === undefined) return false;
  const advertiseMode = desired.advertiseMode ?? DEFAULT_ADVERTISE_MODE;
  if (observed.asn !== desired.asn) return false;
  if ((observed.advertiseMode ?? DEFAULT_ADVERTISE_MODE) !== advertiseMode) {
    return false;
  }
  if (
    (observed.keepaliveInterval ?? DEFAULT_KEEPALIVE) !==
    (desired.keepaliveInterval ?? DEFAULT_KEEPALIVE)
  ) {
    return false;
  }
  if (
    desired.identifierRange !== undefined &&
    observed.identifierRange !== desired.identifierRange
  ) {
    return false;
  }
  if (advertiseMode !== "CUSTOM") return true;
  return (
    groupsKey(observed.advertisedGroups) ===
      groupsKey(desired.advertisedGroups) &&
    rangesKey(observed.advertisedIpRanges) ===
      rangesKey(desired.advertisedIpRanges)
  );
};

const regionalRef = (
  project: string,
  region: string,
  collection: "subnetworks" | "addresses",
  value: string,
) => {
  if (value.startsWith("http") || value.startsWith("projects/")) return value;
  if (value.includes("/")) {
    return `projects/${project}/${value.replace(/^\//, "")}`;
  }
  return `projects/${project}/regions/${region}/${collection}/${value}`;
};

const toNats = (nats: compute.RouterNat[] | undefined): RouterNat[] =>
  (nats ?? []).map((nat) => ({
    name: nat.name ?? "",
    sourceSubnetworkIpRangesToNat:
      nat.sourceSubnetworkIpRangesToNat as compute.RouterNatSourceSubnetworkIpRangesToNatEnum,
    subnetworks: nat.subnetworks?.map((subnetwork) => ({
      name: subnetwork.name ?? "",
      sourceIpRangesToNat:
        subnetwork.sourceIpRangesToNat as RouterNatSubnetwork["sourceIpRangesToNat"],
      secondaryIpRangeNames: subnetwork.secondaryIpRangeNames,
    })),
    natIpAllocateOption:
      nat.natIpAllocateOption as compute.RouterNatNatIpAllocateOptionEnum,
    natIps: nat.natIps,
    minPortsPerVm: nat.minPortsPerVm,
    maxPortsPerVm: nat.maxPortsPerVm,
    enableDynamicPortAllocation: nat.enableDynamicPortAllocation,
    enableEndpointIndependentMapping: nat.enableEndpointIndependentMapping,
    udpIdleTimeoutSec: nat.udpIdleTimeoutSec,
    icmpIdleTimeoutSec: nat.icmpIdleTimeoutSec,
    tcpEstablishedIdleTimeoutSec: nat.tcpEstablishedIdleTimeoutSec,
    tcpTransitoryIdleTimeoutSec: nat.tcpTransitoryIdleTimeoutSec,
    logConfig:
      nat.logConfig === undefined
        ? undefined
        : {
            enable: nat.logConfig.enable === true,
            filter: nat.logConfig
              .filter as compute.RouterNatLogConfigFilterEnum,
          },
  }));

const desiredNats = (
  project: string,
  region: string,
  nats: ReadonlyArray<RouterNat>,
): compute.RouterNat[] =>
  nats.map((nat) => ({
    ...nat,
    natIpAllocateOption:
      nat.natIpAllocateOption ??
      (nat.natIps !== undefined && nat.natIps.length > 0
        ? "MANUAL_ONLY"
        : "AUTO_ONLY"),
    subnetworks: nat.subnetworks?.map((subnetwork) => ({
      ...subnetwork,
      name: regionalRef(project, region, "subnetworks", subnetwork.name),
      sourceIpRangesToNat: subnetwork.sourceIpRangesToNat ?? ["ALL_IP_RANGES"],
    })),
    natIps: nat.natIps?.map((ip) =>
      regionalRef(project, region, "addresses", ip),
    ),
    logConfig:
      nat.logConfig === undefined
        ? undefined
        : {
            enable: nat.logConfig.enable,
            filter: nat.logConfig.filter ?? "ALL",
          },
  }));

const sortedKey = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])].sort().join("\0");

// Compare only fields the desired NAT specifies: the API fills in defaults
// (timeouts, endpoint types, tier) that the user never declared.
const natMatches = (
  desired: compute.RouterNat,
  observed: compute.RouterNat,
) => {
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    const current = observed[key as keyof compute.RouterNat];
    switch (key) {
      case "natIps":
        if (
          sortedKey((value as string[]).map(linkKey)) !==
          sortedKey(((current as string[] | undefined) ?? []).map(linkKey))
        ) {
          return false;
        }
        break;
      case "subnetworks": {
        const subnetKey = (list: compute.RouterNatSubnetworkToNat[]) =>
          JSON.stringify(
            list
              .map((subnetwork) => ({
                name: linkKey(subnetwork.name),
                ranges: sortedKey(subnetwork.sourceIpRangesToNat),
                secondary: sortedKey(subnetwork.secondaryIpRangeNames),
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
        if (
          subnetKey(value as compute.RouterNatSubnetworkToNat[]) !==
          subnetKey((current as compute.RouterNatSubnetworkToNat[]) ?? [])
        ) {
          return false;
        }
        break;
      }
      case "logConfig": {
        const log = current as compute.RouterNatLogConfig | undefined;
        const want = value as compute.RouterNatLogConfig;
        if ((log?.enable === true) !== (want.enable === true)) return false;
        if (want.enable === true && log?.filter !== want.filter) return false;
        break;
      }
      default:
        if (current !== value) return false;
    }
  }
  return true;
};

const natsEqual = (
  observed: compute.RouterNat[] | undefined,
  desired: compute.RouterNat[],
) => {
  const byName = new Map((observed ?? []).map((nat) => [nat.name, nat]));
  if (byName.size !== desired.length) return false;
  return desired.every((nat) => {
    const current = byName.get(nat.name);
    return current !== undefined && natMatches(nat, current);
  });
};

const toAttrs = (
  router: compute.Router,
  project: string,
): Router["Attributes"] => {
  const parsed = parseDescription(router.description);
  return {
    routerName: router.name ?? "",
    project,
    region: lastSegment(router.region ?? "").toLowerCase(),
    network: router.network ?? "",
    description: parsed.description,
    bgp: toBgp(router.bgp),
    nats: toNats(router.nats),
    encryptedInterconnectRouter: router.encryptedInterconnectRouter === true,
    nccGateway: router.nccGateway,
    selfLink: router.selfLink,
    routerId: router.id,
    creationTimestamp: router.creationTimestamp,
  };
};

const getByName = (project: string, region: string, router: string) =>
  compute
    .getRouters({ project, region, router })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requireRouter = (project: string, region: string, routerName: string) =>
  getByName(project, region, routerName).pipe(
    Effect.flatMap((router) =>
      router
        ? Effect.succeed(router)
        : Effect.fail(new RouterNotResolved({ routerName, region })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.RouterNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilRouterGone = (
  project: string,
  region: string,
  routerName: string,
) =>
  getByName(project, region, routerName).pipe(
    Effect.flatMap((router) =>
      router === undefined
        ? Effect.void
        : Effect.fail(
            new RouterOperationPending({
              operation: `delete:${routerName}`,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.RouterOperationPending",
      schedule: Schedule.spaced("2 seconds"),
      times: 20,
    }),
  );

export const RouterProvider = () =>
  Provider.succeed(Router, {
    nuke: {
      dependsOn: ["GCP.Compute.Network"],
    },
    stables: [
      "routerName",
      "project",
      "region",
      "network",
      "encryptedInterconnectRouter",
      "nccGateway",
      "routerId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.routerName ?? output?.routerName;
      const nextName = news.routerName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const identityChanged =
        previousRegion !== nextRegion ||
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName);
      const previousEncrypted =
        olds?.encryptedInterconnectRouter ??
        output?.encryptedInterconnectRouter ??
        false;
      const nextEncrypted = news.encryptedInterconnectRouter ?? false;
      const previousAsn = olds?.bgp?.asn ?? output?.bgp?.asn;
      const nextAsn = news.bgp?.asn;
      const replace =
        identityChanged ||
        linkKey(news.network) !== linkKey(olds?.network ?? output?.network) ||
        previousEncrypted !== nextEncrypted ||
        (previousAsn !== undefined &&
          nextAsn !== undefined &&
          previousAsn !== nextAsn) ||
        (news.nccGateway !== undefined &&
          linkKey(news.nccGateway) !==
            linkKey(olds?.nccGateway ?? output?.nccGateway));
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          !identityChanged &&
          nextName !== undefined &&
          previousName !== undefined &&
          nextName === previousName,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const routerName = yield* toRouterName(
        id,
        olds?.routerName,
        output?.routerName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, routerName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, parsed.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: Router["Attributes"][] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* compute.aggregatedListRouters({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
            pageToken,
          });
          for (const scoped of Object.values(response.items ?? {})) {
            for (const item of scoped?.routers ?? []) {
              if (!hasAlchemyMarker(item.description)) continue;
              found.push(toAttrs(item, env.project));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const routerName = yield* toRouterName(
        id,
        news.routerName,
        output?.routerName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const network = networkRef(env.project, news.network);
      const internal = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(internal, news.description);
      const encrypted = news.encryptedInterconnectRouter === true;
      const nats =
        news.nats === undefined
          ? undefined
          : desiredNats(env.project, region, news.nats);

      let current = yield* getByName(env.project, region, routerName);

      if (current === undefined) {
        const body: compute.Router = {
          name: routerName,
          network,
          description: desiredDescription,
        };
        if (news.bgp !== undefined) {
          body.bgp = desiredBgp(news.bgp);
        }
        if (nats !== undefined && nats.length > 0) {
          body.nats = nats;
        }
        if (encrypted) {
          body.encryptedInterconnectRouter = true;
        }
        if (news.nccGateway !== undefined) {
          body.nccGateway = news.nccGateway;
        }
        yield* compute
          .insertRouters({
            project: env.project,
            region,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* requireRouter(env.project, region, routerName);
      }

      const patchBody: compute.Router = {};
      if ((current.description ?? "") !== desiredDescription) {
        patchBody.description = desiredDescription;
      }
      if (news.bgp !== undefined && !bgpEqual(toBgp(current.bgp), news.bgp)) {
        patchBody.bgp = desiredBgp(news.bgp);
      }
      if (nats !== undefined && !natsEqual(current.nats, nats)) {
        patchBody.nats = nats;
      }
      if (Object.keys(patchBody).length > 0) {
        const patched = yield* compute.patchRouters({
          project: env.project,
          region,
          router: routerName,
          body: patchBody,
        });
        yield* waitRegionOperation(env.project, region, patched);
        current = yield* requireRouter(env.project, region, routerName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      const routerName = output.routerName;
      if (!routerName) return;
      yield* compute
        .deleteRouters({
          project,
          region,
          router: routerName,
        })
        .pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" || error._tag === "BadRequest",
            times: 15,
            schedule: Schedule.spaced("3 seconds"),
          }),
          Effect.flatMap((operation) =>
            waitRegionOperation(project, region, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) =>
              error._tag === "GCP.OperationFailed" &&
              error.reason === "RESOURCE_IN_USE_BY_ANOTHER_RESOURCE",
            times: 10,
            schedule: Schedule.spaced("3 seconds"),
          }),
        );
      yield* waitUntilRouterGone(project, region, routerName);
    }),
  });
