import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
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

const DEFAULT_SCHEME = "EXTERNAL";
const DEFAULT_NETWORK_TIER = "PREMIUM";
const MAX_NAME_LENGTH = 63;

export type ForwardingRuleServiceDirectoryRegistration =
  compute.ForwardingRuleServiceDirectoryRegistration;

export type ForwardingRuleProps = {
  /**
   * Name of the forwarding rule. If omitted, a unique RFC1035 name is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the rule.
   */
  forwardingRuleName?: string;
  /**
   * Region the rule lives in. Immutable — changing it replaces the rule.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Immutable — changing it replaces the rule.
   */
  description?: string;
  /**
   * IP address or Address URL this rule accepts traffic on. When omitted,
   * GCP assigns an ephemeral address. Immutable — changing a literal IP
   * replaces the rule.
   */
  ipAddress?: string;
  /**
   * IP protocol (`TCP`, `UDP`, `ESP`, `AH`, `SCTP`, `ICMP`, `L3_DEFAULT`).
   * Immutable — changing it replaces the rule.
   */
  ipProtocol?: compute.ForwardingRuleIPProtocolEnum | (string & {});
  /**
   * Single port or `start-end` range. Mutually exclusive with `ports` and
   * `allPorts`. Immutable — changing it replaces the rule.
   */
  portRange?: string;
  /**
   * Up to five discrete ports. Mutually exclusive with `portRange` and
   * `allPorts`. Immutable — changing it replaces the rule.
   */
  ports?: string[];
  /**
   * Forward every port (and packets with no port). Mutually exclusive with
   * `portRange` and `ports`. Immutable — changing it replaces the rule.
   */
  allPorts?: boolean;
  /**
   * Target resource URL (target pool, target instance, target HTTP(S)/TCP
   * proxy, target VPN gateway, or a PSC service attachment / Google API
   * bundle). Updated in place via `setTarget`.
   */
  target?: string;
  /**
   * Backend service URL. Required for internal and external passthrough
   * Network Load Balancers; omitted for other products. Immutable —
   * changing it replaces the rule.
   */
  backendService?: string;
  /**
   * Forwarding rule type (`EXTERNAL`, `EXTERNAL_MANAGED`, `INTERNAL`,
   * `INTERNAL_MANAGED`). Use `""` for some PSC endpoints. Immutable —
   * changing it replaces the rule.
   * @default "EXTERNAL"
   */
  loadBalancingScheme?:
    | compute.ForwardingRuleLoadBalancingSchemeEnum
    | ""
    | (string & {});
  /**
   * VPC network URL or name. Used for internal load balancing and PSC.
   * Immutable — changing it replaces the rule.
   */
  network?: string;
  /**
   * Subnetwork URL or name. Required for custom-mode VPCs and IPv6
   * external rules. Immutable — changing it replaces the rule.
   */
  subnetwork?: string;
  /**
   * Networking tier (`PREMIUM` or `STANDARD`). Immutable — changing it
   * replaces the rule.
   * @default "PREMIUM"
   */
  networkTier?: compute.ForwardingRuleNetworkTierEnum | (string & {});
  /**
   * `IPV4` or `IPV6`. Immutable — changing it replaces the rule.
   */
  ipVersion?: compute.ForwardingRuleIpVersionEnum | (string & {});
  /**
   * Allow clients in other regions to reach this internal load balancer.
   * Updated in place via `patch`, except `INTERNAL_MANAGED` where a change
   * replaces the rule.
   */
  allowGlobalAccess?: boolean;
  /**
   * Allow a PSC consumer endpoint to be reached from another region.
   * Updated in place via `patch`.
   */
  allowPscGlobalAccess?: boolean;
  /**
   * Skip auto-creating a DNS zone for a PSC consumer endpoint. Immutable
   * — changing it replaces the rule.
   */
  noAutomateDnsZone?: boolean;
  /**
   * Use this INTERNAL load balancer as a packet-mirroring collector.
   * Immutable — changing it replaces the rule.
   */
  isMirroringCollector?: boolean;
  /**
   * Optional prefix of the fully-qualified INTERNAL service name.
   * Immutable — changing it replaces the rule.
   */
  serviceLabel?: string;
  /**
   * Restrict EXTERNAL regional rules to these source IPs or CIDRs (max
   * 64). Immutable — changing it replaces the rule.
   */
  sourceIpRanges?: string[];
  /**
   * Public delegated prefix used to draw a BYOIP IPv6 address. Immutable
   * — changing it replaces the rule.
   */
  ipCollection?: string;
  /**
   * Service Directory registrations. Currently a single entry. Immutable
   * — changing it replaces the rule.
   */
  serviceDirectoryRegistrations?: ForwardingRuleServiceDirectoryRegistration[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
};

export type ForwardingRule = Resource<
  "GCP.Compute.ForwardingRule",
  ForwardingRuleProps,
  {
    /** Forwarding rule name. */
    forwardingRuleName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Server-assigned numeric id. */
    forwardingRuleId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** Assigned IP address number. */
    ipAddress: string | undefined;
    /** IP protocol. */
    ipProtocol: string | undefined;
    /** Port range, if set. */
    portRange: string | undefined;
    /** Discrete ports, if set. */
    ports: ReadonlyArray<string>;
    /** Whether every port is forwarded. */
    allPorts: boolean;
    /** Target resource URL, if set. */
    target: string | undefined;
    /** Backend service URL, if set. */
    backendService: string | undefined;
    /** Load balancing scheme. */
    loadBalancingScheme: string | undefined;
    /** Network URL, if set. */
    network: string | undefined;
    /** Subnetwork URL, if set. */
    subnetwork: string | undefined;
    /** Networking tier. */
    networkTier: string | undefined;
    /** IP version. */
    ipVersion: string | undefined;
    /** Cross-region ILB access. */
    allowGlobalAccess: boolean;
    /** Cross-region PSC access. */
    allowPscGlobalAccess: boolean;
    /** PSC DNS-zone automation disabled. */
    noAutomateDnsZone: boolean;
    /** Packet-mirroring collector. */
    isMirroringCollector: boolean;
    /** INTERNAL service-name prefix, if set. */
    serviceLabel: string | undefined;
    /** Fully-qualified INTERNAL service name, if any. */
    serviceName: string | undefined;
    /** Source IP filters. */
    sourceIpRanges: ReadonlyArray<string>;
    /** BYOIP public delegated prefix, if any. */
    ipCollection: string | undefined;
    /** PSC connection id, if any. */
    pscConnectionId: string | undefined;
    /** PSC connection status, if any. */
    pscConnectionStatus: string | undefined;
    /** Corresponding base forwarding rule, if any. */
    baseForwardingRule: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine forwarding rule.
 *
 * Forwarding rules are the frontend of a Google Cloud load balancer: an
 * IP address, protocol, and port that send traffic to a target (pool,
 * instance, HTTP(S)/TCP proxy, VPN gateway) or a backend service. This
 * resource maps to the regional `forwardingRules` collection
 * (`globalForwardingRules` is a separate resource).
 *
 * Labels cannot be set on insert — Alchemy applies them with `setLabels`
 * after the rule exists. `target`, `allowGlobalAccess`, and
 * `allowPscGlobalAccess` update in place; name, region, IP, protocol,
 * ports, scheme, network, subnetwork, backend service, and description
 * replace the rule.
 *
 * ### Creating a Forwarding Rule
 * **Example:** Classic Network Load Balancer frontend
 * ```typescript
 * const rule = yield* GCP.Compute.ForwardingRule("Frontend", {
 *   region: "us-central1",
 *   target: targetPool.selfLink,
 *   portRange: "80",
 * });
 * ```
 *
 * **Example:** Named rule with labels
 * ```typescript
 * const rule = yield* GCP.Compute.ForwardingRule("Frontend", {
 *   forwardingRuleName: "app-frontend",
 *   region: "us-central1",
 *   ipProtocol: "TCP",
 *   portRange: "80-80",
 *   target: targetPool.selfLink,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Internal Load Balancing
 * **Example:** Regional internal passthrough NLB
 * ```typescript
 * const rule = yield* GCP.Compute.ForwardingRule("Ilb", {
 *   region: "us-central1",
 *   loadBalancingScheme: "INTERNAL",
 *   backendService: backend.selfLink,
 *   network: vpc.selfLink,
 *   subnetwork: subnet.selfLink,
 *   ipProtocol: "TCP",
 *   ports: ["80"],
 *   allowGlobalAccess: true,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const ForwardingRule = Resource<ForwardingRule>(
  "GCP.Compute.ForwardingRule",
);

export class ForwardingRuleNotResolved extends Data.TaggedError(
  "GCP.Compute.ForwardingRuleNotResolved",
)<{
  forwardingRuleName: string;
  region: string;
}> {}

export class ForwardingRulePending extends Data.TaggedError(
  "GCP.Compute.ForwardingRulePending",
)<{
  forwardingRuleName: string;
  status: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const resourceRefOf = (value: string | undefined) => {
  if (!value) return "";
  return lastSegment(value);
};

const schemeOf = (value: string | undefined) =>
  value === undefined ? DEFAULT_SCHEME : value;

const networkTierOf = (value: string | undefined) =>
  value ?? DEFAULT_NETWORK_TIER;

const ipVersionOf = (value: string | undefined) =>
  value && value !== "UNSPECIFIED_VERSION" ? value : "";

const normalizePortRange = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? `${trimmed}-${trimmed}` : trimmed;
};

const portsKey = (ports: ReadonlyArray<string> | undefined) =>
  [...(ports ?? [])].map(String).sort().join(",");

const rangesKey = (ranges: ReadonlyArray<string> | undefined) =>
  [...(ranges ?? [])].map(String).sort().join(",");

const registrationsKey = (
  registrations:
    | ReadonlyArray<ForwardingRuleServiceDirectoryRegistration>
    | undefined,
) =>
  JSON.stringify(
    (registrations ?? []).map((item) => ({
      namespace: item.namespace ?? "",
      service: item.service ?? "",
      serviceDirectoryRegion: item.serviceDirectoryRegion ?? "",
    })),
  );

const isLiteralIp = (value: string) => {
  if (value.includes("/")) return false;
  if (/^[0-9.]+$/.test(value)) return true;
  return value.includes(":");
};

const toName = (id: string, name: string | undefined, existing?: string) =>
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
      : `f${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const toAttrs = (rule: compute.ForwardingRule, project: string) => ({
  forwardingRuleName: rule.name ?? "",
  project,
  region: lastSegment(rule.region ?? "").toLowerCase(),
  forwardingRuleId: rule.id,
  selfLink: rule.selfLink,
  ipAddress: rule.IPAddress,
  ipProtocol: rule.IPProtocol,
  portRange: rule.portRange,
  ports: rule.ports ?? [],
  allPorts: rule.allPorts === true,
  target: rule.target,
  backendService: rule.backendService,
  loadBalancingScheme: rule.loadBalancingScheme,
  network: rule.network,
  subnetwork: rule.subnetwork,
  networkTier: rule.networkTier,
  ipVersion: rule.ipVersion,
  allowGlobalAccess: rule.allowGlobalAccess === true,
  allowPscGlobalAccess: rule.allowPscGlobalAccess === true,
  noAutomateDnsZone: rule.noAutomateDnsZone === true,
  isMirroringCollector: rule.isMirroringCollector === true,
  serviceLabel: rule.serviceLabel,
  serviceName: rule.serviceName,
  sourceIpRanges: rule.sourceIpRanges ?? [],
  ipCollection: rule.ipCollection,
  pscConnectionId: rule.pscConnectionId,
  pscConnectionStatus: rule.pscConnectionStatus,
  baseForwardingRule: rule.baseForwardingRule,
  description: rule.description,
  labels: userLabels(rule.labels),
  creationTimestamp: rule.creationTimestamp,
  kind: rule.kind,
});

const toInsertBody = (
  forwardingRuleName: string,
  news: ForwardingRuleProps,
): compute.ForwardingRule => ({
  name: forwardingRuleName,
  description: news.description,
  IPAddress: news.ipAddress,
  IPProtocol: news.ipProtocol,
  portRange:
    news.allPorts === true || news.ports !== undefined
      ? undefined
      : news.portRange,
  ports:
    news.allPorts === true || news.portRange !== undefined
      ? undefined
      : news.ports,
  allPorts: news.allPorts,
  target: news.target,
  backendService: news.backendService,
  loadBalancingScheme: news.loadBalancingScheme,
  network: news.network,
  subnetwork: news.subnetwork,
  networkTier: news.networkTier,
  ipVersion: news.ipVersion,
  allowGlobalAccess: news.allowGlobalAccess,
  allowPscGlobalAccess: news.allowPscGlobalAccess,
  noAutomateDnsZone: news.noAutomateDnsZone,
  isMirroringCollector: news.isMirroringCollector,
  serviceLabel: news.serviceLabel,
  sourceIpRanges: news.sourceIpRanges,
  ipCollection: news.ipCollection,
  serviceDirectoryRegistrations: news.serviceDirectoryRegistrations,
});

const getByName = (project: string, region: string, forwardingRule: string) =>
  compute
    .getForwardingRules({ project, region, forwardingRule })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requireForwardingRule = (
  project: string,
  region: string,
  forwardingRuleName: string,
) =>
  getByName(project, region, forwardingRuleName).pipe(
    Effect.flatMap((rule) =>
      rule
        ? Effect.succeed(rule)
        : Effect.fail(
            new ForwardingRuleNotResolved({ forwardingRuleName, region }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.ForwardingRuleNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  forwardingRuleName: string,
) =>
  getByName(project, region, forwardingRuleName).pipe(
    Effect.flatMap((rule) =>
      rule === undefined
        ? Effect.void
        : Effect.fail(
            new ForwardingRulePending({
              forwardingRuleName,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.ForwardingRulePending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const immutableChanged = (
  news: ForwardingRuleProps,
  previous: {
    description: string;
    ipAddress: string;
    ipProtocol: string;
    portRange: string;
    ports: string;
    allPorts: boolean;
    backendService: string;
    loadBalancingScheme: string;
    network: string;
    subnetwork: string;
    networkTier: string;
    ipVersion: string;
    noAutomateDnsZone: boolean;
    isMirroringCollector: boolean;
    serviceLabel: string;
    sourceIpRanges: string;
    ipCollection: string;
    serviceDirectoryRegistrations: string;
    allowGlobalAccess: boolean;
  },
) => {
  if (
    news.description !== undefined &&
    (news.description ?? "") !== previous.description
  ) {
    return true;
  }
  if (
    news.ipAddress !== undefined &&
    isLiteralIp(news.ipAddress) &&
    previous.ipAddress.length > 0 &&
    news.ipAddress !== previous.ipAddress
  ) {
    return true;
  }
  if (
    news.ipProtocol !== undefined &&
    news.ipProtocol.toUpperCase() !==
      (previous.ipProtocol || "TCP").toUpperCase()
  ) {
    return true;
  }
  if (
    news.portRange !== undefined &&
    normalizePortRange(news.portRange) !== previous.portRange
  ) {
    return true;
  }
  if (news.ports !== undefined && portsKey(news.ports) !== previous.ports) {
    return true;
  }
  if (news.allPorts !== undefined && news.allPorts !== previous.allPorts) {
    return true;
  }
  if (
    news.backendService !== undefined &&
    resourceRefOf(news.backendService) !== previous.backendService
  ) {
    return true;
  }
  if (
    news.loadBalancingScheme !== undefined &&
    schemeOf(news.loadBalancingScheme) !== previous.loadBalancingScheme
  ) {
    return true;
  }
  if (
    news.network !== undefined &&
    resourceRefOf(news.network) !== previous.network
  ) {
    return true;
  }
  if (
    news.subnetwork !== undefined &&
    resourceRefOf(news.subnetwork) !== previous.subnetwork
  ) {
    return true;
  }
  if (
    news.networkTier !== undefined &&
    networkTierOf(news.networkTier) !== previous.networkTier
  ) {
    return true;
  }
  if (
    news.ipVersion !== undefined &&
    ipVersionOf(news.ipVersion) !== previous.ipVersion
  ) {
    return true;
  }
  if (
    news.noAutomateDnsZone !== undefined &&
    news.noAutomateDnsZone !== previous.noAutomateDnsZone
  ) {
    return true;
  }
  if (
    news.isMirroringCollector !== undefined &&
    news.isMirroringCollector !== previous.isMirroringCollector
  ) {
    return true;
  }
  if (
    news.serviceLabel !== undefined &&
    (news.serviceLabel ?? "") !== previous.serviceLabel
  ) {
    return true;
  }
  if (
    news.sourceIpRanges !== undefined &&
    rangesKey(news.sourceIpRanges) !== previous.sourceIpRanges
  ) {
    return true;
  }
  if (
    news.ipCollection !== undefined &&
    resourceRefOf(news.ipCollection) !== previous.ipCollection
  ) {
    return true;
  }
  if (
    news.serviceDirectoryRegistrations !== undefined &&
    registrationsKey(news.serviceDirectoryRegistrations) !==
      previous.serviceDirectoryRegistrations
  ) {
    return true;
  }
  if (
    schemeOf(news.loadBalancingScheme ?? previous.loadBalancingScheme) ===
      "INTERNAL_MANAGED" &&
    news.allowGlobalAccess !== undefined &&
    news.allowGlobalAccess !== previous.allowGlobalAccess
  ) {
    return true;
  }
  return false;
};

export const ForwardingRuleProvider = () =>
  Provider.succeed(ForwardingRule, {
    stables: [
      "forwardingRuleName",
      "project",
      "region",
      "forwardingRuleId",
      "selfLink",
      "ipAddress",
      "ipProtocol",
      "portRange",
      "loadBalancingScheme",
      "network",
      "subnetwork",
      "networkTier",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName =
        olds.forwardingRuleName ?? output?.forwardingRuleName;
      const nextName = news.forwardingRuleName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;

      const previousRegion = normalizeRegion(
        olds.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;

      const previous = {
        description: olds.description ?? output?.description ?? "",
        ipAddress: olds.ipAddress ?? output?.ipAddress ?? "",
        ipProtocol: olds.ipProtocol ?? output?.ipProtocol ?? "",
        portRange: normalizePortRange(olds.portRange ?? output?.portRange),
        ports: portsKey(olds.ports ?? output?.ports),
        allPorts: olds.allPorts ?? output?.allPorts ?? false,
        backendService: resourceRefOf(
          olds.backendService ?? output?.backendService,
        ),
        loadBalancingScheme: schemeOf(
          olds.loadBalancingScheme ?? output?.loadBalancingScheme,
        ),
        network: resourceRefOf(olds.network ?? output?.network),
        subnetwork: resourceRefOf(olds.subnetwork ?? output?.subnetwork),
        networkTier: networkTierOf(olds.networkTier ?? output?.networkTier),
        ipVersion: ipVersionOf(olds.ipVersion ?? output?.ipVersion),
        noAutomateDnsZone:
          olds.noAutomateDnsZone ?? output?.noAutomateDnsZone ?? false,
        isMirroringCollector:
          olds.isMirroringCollector ?? output?.isMirroringCollector ?? false,
        serviceLabel: olds.serviceLabel ?? output?.serviceLabel ?? "",
        sourceIpRanges: rangesKey(
          olds.sourceIpRanges ?? output?.sourceIpRanges,
        ),
        ipCollection: resourceRefOf(olds.ipCollection ?? output?.ipCollection),
        serviceDirectoryRegistrations: registrationsKey(
          olds.serviceDirectoryRegistrations,
        ),
        allowGlobalAccess:
          olds.allowGlobalAccess ?? output?.allowGlobalAccess ?? false,
      };

      if (nameChanged || regionChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutableChanged(news, previous)) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const forwardingRuleName = yield* toName(
        id,
        olds?.forwardingRuleName,
        output?.forwardingRuleName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        forwardingRuleName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListForwardingRules
          .pages({
            project: env.project,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.forwardingRules ?? [])
              .filter((item) => item.region !== undefined)
              .filter((item) =>
                Object.keys(item.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const forwardingRuleName = yield* toName(
        id,
        news.forwardingRuleName,
        output?.forwardingRuleName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, region, forwardingRuleName);

      if (current === undefined) {
        const created = yield* compute
          .insertForwardingRules({
            project: env.project,
            region,
            body: toInsertBody(forwardingRuleName, news),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }).pipe(
                Effect.flatMap(() =>
                  requireForwardingRule(
                    env.project,
                    region,
                    forwardingRuleName,
                  ),
                ),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              requireForwardingRule(env.project, region, forwardingRuleName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ForwardingRuleNotResolved({
          forwardingRuleName,
          region,
        });
      }
      const resolved = current;

      if (
        news.target !== undefined &&
        resourceRefOf(news.target) !== resourceRefOf(current.target)
      ) {
        yield* compute
          .setTargetForwardingRules({
            project: env.project,
            region,
            forwardingRule: forwardingRuleName,
            body: { target: news.target },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
          );
        current =
          (yield* getByName(env.project, region, forwardingRuleName)) ??
          current;
      }

      const scheme = schemeOf(current.loadBalancingScheme);
      if (
        news.allowGlobalAccess !== undefined &&
        scheme !== "INTERNAL_MANAGED" &&
        news.allowGlobalAccess !== (current.allowGlobalAccess === true)
      ) {
        yield* compute
          .patchForwardingRules({
            project: env.project,
            region,
            forwardingRule: forwardingRuleName,
            body: { allowGlobalAccess: news.allowGlobalAccess },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
          );
        current =
          (yield* getByName(env.project, region, forwardingRuleName)) ??
          current;
      }

      if (
        news.allowPscGlobalAccess !== undefined &&
        news.allowPscGlobalAccess !== (current.allowPscGlobalAccess === true)
      ) {
        yield* compute
          .patchForwardingRules({
            project: env.project,
            region,
            forwardingRule: forwardingRuleName,
            body: {
              fingerprint: current.fingerprint,
              allowPscGlobalAccess: news.allowPscGlobalAccess,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
          );
        current =
          (yield* getByName(env.project, region, forwardingRuleName)) ??
          current;
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* Effect.gen(function* () {
          const latest =
            (yield* getByName(env.project, region, forwardingRuleName)) ??
            resolved;
          yield* compute
            .setLabelsForwardingRules({
              project: env.project,
              region,
              resource: forwardingRuleName,
              body: {
                labels: desiredLabels,
                labelFingerprint: latest.labelFingerprint,
              },
            })
            .pipe(
              Effect.flatMap((operation) =>
                waitRegionOperation(env.project, region, operation),
              ),
            );
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 5,
            schedule: Schedule.spaced("1 second"),
          }),
        );
        current =
          (yield* getByName(env.project, region, forwardingRuleName)) ??
          resolved;
      }

      return toAttrs(current ?? resolved, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      yield* compute
        .deleteForwardingRules({
          project,
          region,
          forwardingRule: output.forwardingRuleName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitRegionOperation(project, region, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(project, region, output.forwardingRuleName);
    }),
  });
