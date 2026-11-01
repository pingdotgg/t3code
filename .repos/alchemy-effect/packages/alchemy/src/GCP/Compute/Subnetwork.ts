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

export type SubnetworkSecondaryRange = {
  /** Name of this secondary range. Must be unique within the subnetwork. */
  rangeName: string;
  /** CIDR of this secondary range. */
  ipCidrRange: string;
};

export type SubnetworkLogConfig = {
  /** Whether VPC flow logs are enabled. */
  enable?: boolean;
  /** Aggregation interval for flow logs. */
  aggregationInterval?: compute.SubnetworkLogConfigAggregationIntervalEnum;
  /** Sampling rate in `[0, 1]`. */
  flowSampling?: number;
  /** Metadata included in flow logs. */
  metadata?: compute.SubnetworkLogConfigMetadataEnum;
  /** Extra metadata fields when `metadata` is `CUSTOM_METADATA`. */
  metadataFields?: string[];
  /** Filter expression for exported flow logs. */
  filterExpr?: string;
};

export type SubnetworkProps = {
  /**
   * Subnetwork name (RFC1035, 1-63 chars). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the subnetwork.
   */
  subnetworkName?: string;
  /**
   * Region of the subnetwork. Immutable — changing it replaces the
   * subnetwork. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Parent VPC network name or URL. Immutable — changing it replaces the
   * subnetwork.
   */
  network: string;
  /**
   * Primary IPv4 CIDR. Changing it replaces the subnetwork (expansion via
   * `expandIpCidrRange` is not applied in-place).
   */
  ipCidrRange: string;
  /**
   * User description. Alchemy ownership is stamped into the description
   * (Compute Subnetwork has no `labels` field) so `list` / nuke can find
   * the resource. The API only accepts description at create time —
   * changing it replaces the subnetwork.
   */
  description?: string;
  /**
   * Whether VMs in this subnet can reach Google APIs without an external
   * IP. Updated in place via `setPrivateIpGoogleAccess`.
   * @default false
   */
  privateIpGoogleAccess?: boolean;
  /**
   * IP stack. `IPV4_ONLY` by default. Updated in place via patch.
   * @default "IPV4_ONLY"
   */
  stackType?: compute.SubnetworkStackTypeEnum;
  /**
   * Subnet purpose (`PRIVATE`, `INTERNAL_HTTPS_LOAD_BALANCER`,
   * `REGIONAL_MANAGED_PROXY`, …). Immutable — changing it replaces the
   * subnetwork.
   */
  purpose?: compute.SubnetworkPurposeEnum;
  /**
   * Secondary ranges for alias IPs. Updated in place via patch.
   */
  secondaryIpRanges?: ReadonlyArray<SubnetworkSecondaryRange>;
  /**
   * VPC flow log options. Updated in place via patch.
   */
  logConfig?: SubnetworkLogConfig;
  /**
   * Deprecated flow-log toggle. Prefer `logConfig.enable`. Updated in
   * place via patch when set.
   */
  enableFlowLogs?: boolean;
  /**
   * IPv6 Google access mode. Updated in place via patch when set.
   */
  privateIpv6GoogleAccess?: compute.SubnetworkPrivateIpv6GoogleAccessEnum;
  /**
   * IPv6 access type (`EXTERNAL` or `INTERNAL`). Immutable after the
   * subnet is dual-stack — changing it replaces the subnetwork.
   */
  ipv6AccessType?: compute.SubnetworkIpv6AccessTypeEnum;
};

export type Subnetwork = Resource<
  "GCP.Compute.Subnetwork",
  SubnetworkProps,
  {
    /** RFC1035 subnetwork name. */
    subnetworkName: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Project id. */
    project: string;
    /** Parent VPC network URL. */
    network: string;
    /** Primary IPv4 CIDR. */
    ipCidrRange: string;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Whether Private Google Access is enabled. */
    privateIpGoogleAccess: boolean;
    /** IP stack type. */
    stackType: string | undefined;
    /** Subnet purpose. */
    purpose: string | undefined;
    /** Secondary alias-IP ranges. */
    secondaryIpRanges: ReadonlyArray<SubnetworkSecondaryRange>;
    /** VPC flow log options. */
    logConfig: SubnetworkLogConfig | undefined;
    /** Deprecated flow-log toggle. */
    enableFlowLogs: boolean | undefined;
    /** IPv6 Google access mode. */
    privateIpv6GoogleAccess: string | undefined;
    /** IPv6 access type. */
    ipv6AccessType: string | undefined;
    /** Gateway address for default routes. */
    gatewayAddress: string | undefined;
    /** Server-reported state (`READY` or `DRAINING`). */
    state: string | undefined;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    subnetworkId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Compute Engine VPC subnetwork (subnet).
 *
 * Subnets are regional partitions of a VPC with one primary IPv4 range and
 * optional secondary ranges. Compute Subnetwork has no `labels` field —
 * Alchemy stamps `alchemy-stack` / `alchemy-stage` / `alchemy-id` into the
 * description so `list` and `pnpm nuke:gcp` can identify owned subnets.
 *
 * The parent VPC must be custom mode (`autoCreateSubnetworks: false`)
 * unless you are attaching to an auto-mode network's existing range.
 *
 * ### Creating a Subnetwork
 * **Example:** Subnet in a custom-mode VPC
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const subnet = yield* GCP.Compute.Subnetwork("Private", {
 *   network: network.networkName,
 *   ipCidrRange: "10.0.0.0/24",
 * });
 * ```
 *
 * **Example:** Explicit name, region, and Private Google Access
 * ```typescript
 * const subnet = yield* GCP.Compute.Subnetwork("Private", {
 *   subnetworkName: "app-private",
 *   region: "us-central1",
 *   network: "app-vpc",
 *   ipCidrRange: "10.10.0.0/24",
 *   privateIpGoogleAccess: true,
 *   description: "application private subnet",
 * });
 * ```
 *
 * ### Secondary ranges
 * **Example:** Alias-IP secondary range
 * ```typescript
 * const subnet = yield* GCP.Compute.Subnetwork("Private", {
 *   network: network.networkName,
 *   ipCidrRange: "10.10.0.0/24",
 *   secondaryIpRanges: [
 *     { rangeName: "pods", ipCidrRange: "10.10.1.0/24" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Subnetwork = Resource<Subnetwork>("GCP.Compute.Subnetwork");

export class SubnetworkNotResolved extends Data.TaggedError(
  "GCP.Compute.SubnetworkNotResolved",
)<{
  project: string;
  region: string;
  subnetworkName: string;
}> {}

const DEFAULT_STACK_TYPE = "IPV4_ONLY";
const DEFAULT_PRIVATE_GOOGLE_ACCESS = false;

const OWNERSHIP_KEYS = [
  "alchemy-stack",
  "alchemy-stage",
  "alchemy-id",
] as const;

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const linkKey = (value: string | undefined) =>
  value === undefined || value === "" ? "" : lastSegment(value).toLowerCase();

const networkRef = (project: string, network: string) =>
  network.includes("/")
    ? network
    : `projects/${project}/global/networks/${network}`;

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

const toSubnetworkName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
    const rfc = generated.replace(/^[^a-z]+/, "n").replace(/-+$/g, "");
    return rfc.slice(0, 63);
  });

const toSecondaryRanges = (
  ranges: compute.SubnetworkSecondaryRangeList | undefined,
): SubnetworkSecondaryRange[] =>
  (ranges ?? [])
    .filter(
      (
        range,
      ): range is compute.SubnetworkSecondaryRange & {
        rangeName: string;
        ipCidrRange: string;
      } => !!range.rangeName && !!range.ipCidrRange,
    )
    .map((range) => ({
      rangeName: range.rangeName,
      ipCidrRange: range.ipCidrRange,
    }));

const rangesKey = (
  ranges: ReadonlyArray<SubnetworkSecondaryRange> | undefined,
) =>
  JSON.stringify(
    [...(ranges ?? [])]
      .map((range) => ({
        rangeName: range.rangeName,
        ipCidrRange: range.ipCidrRange,
      }))
      .sort((a, b) => a.rangeName.localeCompare(b.rangeName)),
  );

const toAggregationInterval = (
  value: string | undefined,
): compute.SubnetworkLogConfigAggregationIntervalEnum | undefined => {
  switch (value) {
    case "INTERVAL_10_MIN":
    case "INTERVAL_15_MIN":
    case "INTERVAL_1_MIN":
    case "INTERVAL_30_SEC":
    case "INTERVAL_5_MIN":
    case "INTERVAL_5_SEC":
      return value;
    default:
      return undefined;
  }
};

const toLogMetadata = (
  value: string | undefined,
): compute.SubnetworkLogConfigMetadataEnum | undefined => {
  switch (value) {
    case "CUSTOM_METADATA":
    case "EXCLUDE_ALL_METADATA":
    case "INCLUDE_ALL_METADATA":
      return value;
    default:
      return undefined;
  }
};

const toLogConfig = (
  logConfig: compute.SubnetworkLogConfig | undefined,
): SubnetworkLogConfig | undefined => {
  if (logConfig === undefined) return undefined;
  return {
    enable: logConfig.enable,
    aggregationInterval: toAggregationInterval(logConfig.aggregationInterval),
    flowSampling: logConfig.flowSampling,
    metadata: toLogMetadata(logConfig.metadata),
    metadataFields: logConfig.metadataFields,
    filterExpr: logConfig.filterExpr,
  };
};

const toAttrs = (
  subnetwork: compute.Subnetwork,
  project: string,
): Subnetwork["Attributes"] => {
  const parsed = parseDescription(subnetwork.description);
  return {
    subnetworkName: subnetwork.name ?? "",
    region: lastSegment(subnetwork.region ?? "").toLowerCase(),
    project,
    network: subnetwork.network ?? "",
    ipCidrRange: subnetwork.ipCidrRange ?? "",
    description: parsed.description,
    privateIpGoogleAccess: subnetwork.privateIpGoogleAccess === true,
    stackType: subnetwork.stackType,
    purpose: subnetwork.purpose,
    secondaryIpRanges: toSecondaryRanges(subnetwork.secondaryIpRanges),
    logConfig: toLogConfig(subnetwork.logConfig),
    enableFlowLogs: subnetwork.enableFlowLogs,
    privateIpv6GoogleAccess: subnetwork.privateIpv6GoogleAccess,
    ipv6AccessType: subnetwork.ipv6AccessType,
    gatewayAddress: subnetwork.gatewayAddress,
    state: subnetwork.state,
    selfLink: subnetwork.selfLink,
    subnetworkId: subnetwork.id,
    creationTimestamp: subnetwork.creationTimestamp,
    fingerprint: subnetwork.fingerprint,
  };
};

const getByName = (project: string, region: string, subnetworkName: string) =>
  compute
    .getSubnetworks({ project, region, subnetwork: subnetworkName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requireSubnetwork = (
  project: string,
  region: string,
  subnetworkName: string,
) =>
  getByName(project, region, subnetworkName).pipe(
    Effect.flatMap((subnetwork) =>
      subnetwork
        ? Effect.succeed(subnetwork)
        : Effect.fail(
            new SubnetworkNotResolved({ project, region, subnetworkName }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.SubnetworkNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

export const SubnetworkProvider = () =>
  Provider.succeed(Subnetwork, {
    nuke: {
      dependsOn: ["GCP.Compute.Network"],
    },
    stables: [
      "subnetworkName",
      "region",
      "project",
      "network",
      "ipCidrRange",
      "subnetworkId",
      "selfLink",
      "creationTimestamp",
      "gatewayAddress",
      "purpose",
      "ipv6AccessType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.subnetworkName ?? output?.subnetworkName;
      const nextName = news.subnetworkName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? previousRegion,
        env.region,
      );
      const identityChanged =
        previousRegion !== nextRegion ||
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName);
      const replace =
        identityChanged ||
        linkKey(news.network) !== linkKey(olds?.network ?? output?.network) ||
        news.ipCidrRange !== (olds?.ipCidrRange ?? output?.ipCidrRange ?? "") ||
        (news.description ?? "") !==
          (olds?.description ?? output?.description ?? "") ||
        (news.purpose !== undefined &&
          news.purpose !== (olds?.purpose ?? output?.purpose)) ||
        (news.ipv6AccessType !== undefined &&
          news.ipv6AccessType !==
            (olds?.ipv6AccessType ?? output?.ipv6AccessType));
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
      const subnetworkName = yield* toSubnetworkName(
        id,
        olds?.subnetworkName,
        output?.subnetworkName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, subnetworkName);
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
        const found: Subnetwork["Attributes"][] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* compute.aggregatedListSubnetworks({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
            pageToken,
          });
          for (const scoped of Object.values(response.items ?? {})) {
            for (const item of scoped?.subnetworks ?? []) {
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
      const subnetworkName = yield* toSubnetworkName(
        id,
        news.subnetworkName,
        output?.subnetworkName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const network = networkRef(env.project, news.network);
      const privateIpGoogleAccess =
        news.privateIpGoogleAccess ?? DEFAULT_PRIVATE_GOOGLE_ACCESS;
      const stackType = news.stackType ?? DEFAULT_STACK_TYPE;
      const internal = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(internal, news.description);

      let current = yield* getByName(env.project, region, subnetworkName);

      if (current === undefined) {
        const body: compute.Subnetwork = {
          name: subnetworkName,
          network,
          ipCidrRange: news.ipCidrRange,
          description: desiredDescription,
          privateIpGoogleAccess,
          stackType,
        };
        if (news.purpose !== undefined) body.purpose = news.purpose;
        if (news.secondaryIpRanges !== undefined) {
          body.secondaryIpRanges = [...news.secondaryIpRanges];
        }
        if (news.logConfig !== undefined) {
          body.logConfig = { ...news.logConfig };
        }
        if (news.enableFlowLogs !== undefined) {
          body.enableFlowLogs = news.enableFlowLogs;
        }
        if (news.privateIpv6GoogleAccess !== undefined) {
          body.privateIpv6GoogleAccess = news.privateIpv6GoogleAccess;
        }
        if (news.ipv6AccessType !== undefined) {
          body.ipv6AccessType = news.ipv6AccessType;
        }
        yield* compute
          .insertSubnetworks({
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
        current = yield* requireSubnetwork(env.project, region, subnetworkName);
      }

      if ((current.privateIpGoogleAccess === true) !== privateIpGoogleAccess) {
        const updated = yield* compute.setPrivateIpGoogleAccessSubnetworks({
          project: env.project,
          region,
          subnetwork: subnetworkName,
          body: { privateIpGoogleAccess },
        });
        yield* waitRegionOperation(env.project, region, updated);
        current = yield* requireSubnetwork(env.project, region, subnetworkName);
      }

      const patchBody: compute.Subnetwork = {};
      if ((current.stackType ?? DEFAULT_STACK_TYPE) !== stackType) {
        patchBody.stackType = stackType;
      }
      if (
        news.secondaryIpRanges !== undefined &&
        rangesKey(news.secondaryIpRanges) !==
          rangesKey(toSecondaryRanges(current.secondaryIpRanges))
      ) {
        patchBody.secondaryIpRanges = [...news.secondaryIpRanges];
      }
      if (news.logConfig !== undefined) {
        const observed = toLogConfig(current.logConfig);
        if (
          (observed?.enable === true) !== (news.logConfig.enable === true) ||
          (news.logConfig.aggregationInterval !== undefined &&
            observed?.aggregationInterval !==
              news.logConfig.aggregationInterval) ||
          (news.logConfig.flowSampling !== undefined &&
            observed?.flowSampling !== news.logConfig.flowSampling) ||
          (news.logConfig.metadata !== undefined &&
            observed?.metadata !== news.logConfig.metadata) ||
          (news.logConfig.filterExpr !== undefined &&
            observed?.filterExpr !== news.logConfig.filterExpr)
        ) {
          patchBody.logConfig = { ...news.logConfig };
        }
      }
      if (
        news.enableFlowLogs !== undefined &&
        (current.enableFlowLogs === true) !== news.enableFlowLogs
      ) {
        patchBody.enableFlowLogs = news.enableFlowLogs;
      }
      if (
        news.privateIpv6GoogleAccess !== undefined &&
        current.privateIpv6GoogleAccess !== news.privateIpv6GoogleAccess
      ) {
        patchBody.privateIpv6GoogleAccess = news.privateIpv6GoogleAccess;
      }

      if (Object.keys(patchBody).length > 0) {
        patchBody.fingerprint = current.fingerprint;
        const patched = yield* compute.patchSubnetworks({
          project: env.project,
          region,
          subnetwork: subnetworkName,
          body: patchBody,
        });
        yield* waitRegionOperation(env.project, region, patched);
        current = yield* requireSubnetwork(env.project, region, subnetworkName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      const subnetworkName = output.subnetworkName;
      if (!subnetworkName) return;
      yield* compute
        .deleteSubnetworks({
          project,
          region,
          subnetwork: subnetworkName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitRegionOperation(project, region, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" ||
              (error._tag === "GCP.OperationFailed" &&
                error.reason === "RESOURCE_IN_USE_BY_ANOTHER_RESOURCE"),
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          // Compute rejects the delete while another operation is still in
          // flight on the subnet (e.g. load balancer or packet-mirroring
          // teardown on resources inside it).
          Effect.retry({
            while: (error) => error._tag === "ResourceNotReady",
            times: 20,
            schedule: Schedule.spaced("10 seconds"),
          }),
        );
    }),
  });
