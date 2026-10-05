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
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_ENABLE: compute.PacketMirroringEnableEnum = "TRUE";
const DEFAULT_PRIORITY = 1000;
const DEFAULT_DIRECTION: compute.PacketMirroringFilterDirectionEnum = "BOTH";
const MAX_NAME_LENGTH = 63;

export type PacketMirroringEnable = compute.PacketMirroringEnableEnum;

export type PacketMirroringFilterDirection =
  compute.PacketMirroringFilterDirectionEnum;

export type PacketMirroringFilter = {
  /**
   * Traffic direction to copy (`INGRESS`, `EGRESS`, or `BOTH`).
   * @default "BOTH"
   */
  direction?: PacketMirroringFilterDirection | (string & {});
  /**
   * IP protocols to copy (`tcp`, `udp`, `icmp`, `esp`, …). Empty (the
   * default) copies every protocol that matches `cidrRanges`.
   */
  ipProtocols?: string[];
  /**
   * IPv4 or IPv6 CIDR ranges matched against the source (ingress) or
   * destination (egress) address. Empty (the default) copies every IPv4
   * packet that matches `ipProtocols`. Use `0.0.0.0/0,::/0` to copy both
   * IPv4 and IPv6.
   */
  cidrRanges?: string[];
};

export type PacketMirroringMirroredResources = {
  /**
   * Subnetwork names or URLs whose VMs are mirrored (max 5). Subnets must
   * live in the same region and VPC as this policy.
   */
  subnetworks?: string[];
  /**
   * Instance names or URLs to mirror (max 50). Instances must live in a
   * zone of this policy's region and have a NIC on `network`.
   */
  instances?: string[];
  /**
   * Network tags. Traffic from/to every VM that has at least one of these
   * tags is mirrored.
   */
  tags?: string[];
};

export type PacketMirroringProps = {
  /**
   * PacketMirroring name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the policy.
   */
  packetMirroringName?: string;
  /**
   * Region the policy lives in. Immutable — changing it replaces the
   * policy. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute PacketMirroring has
   * no labels field). Immutable — changing it replaces the policy.
   */
  description?: string;
  /**
   * Mirrored VPC network name (`default`), partial URL
   * (`global/networks/default`), or self-link. Only packets on this
   * network are copied. Immutable — changing it replaces the policy.
   */
  network: string;
  /**
   * Collector internal passthrough Network Load Balancer: a regional
   * forwarding-rule name, path, or URL whose `loadBalancingScheme` is
   * `INTERNAL` and `isMirroringCollector` is `true`. Updated in place.
   */
  collectorIlb: string;
  /**
   * Mirrored sources — at least one of `tags`, `instances`, or
   * `subnetworks`. Updated in place.
   */
  mirroredResources: PacketMirroringMirroredResources;
  /**
   * Whether the policy is enforced. `false` / `"FALSE"` leaves the
   * resource in place but stops copying packets.
   * @default true
   */
  enable?: boolean | PacketMirroringEnable | (string & {});
  /**
   * Tie-breaker when two policies match the same VM. Lower wins.
   * Valid range is `0`–`65535`.
   * @default 1000
   */
  priority?: number;
  /**
   * Optional traffic filter. When omitted, every IPv4 packet is copied.
   * Updated in place.
   */
  filter?: PacketMirroringFilter;
};

export type PacketMirroring = Resource<
  "GCP.Compute.PacketMirroring",
  PacketMirroringProps,
  {
    /** PacketMirroring name. */
    packetMirroringName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Mirrored VPC network URL. */
    network: string;
    /** Server-canonical network URL, if reported. */
    networkCanonicalUrl: string | undefined;
    /** Collector forwarding-rule URL. */
    collectorIlb: string;
    /** Server-canonical collector URL, if reported. */
    collectorIlbCanonicalUrl: string | undefined;
    /** Mirrored sources currently configured. */
    mirroredResources: {
      subnetworks: ReadonlyArray<string>;
      instances: ReadonlyArray<string>;
      tags: ReadonlyArray<string>;
    };
    /** Whether the policy is enforced. */
    enable: boolean;
    /** Tie-breaker priority. */
    priority: number;
    /** Traffic filter, if set. */
    filter:
      | {
          direction: string | undefined;
          ipProtocols: ReadonlyArray<string>;
          cidrRanges: ReadonlyArray<string>;
        }
      | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    packetMirroringId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine packet mirroring policy.
 *
 * Packet Mirroring copies traffic from selected VMs, subnets, or network
 * tags in a VPC and sends it to a collector internal passthrough Network
 * Load Balancer (`ForwardingRule` with `isMirroringCollector: true`).
 * Compute PacketMirroring has no labels field — Alchemy ownership is
 * stored in the description so nuke can find leaked resources.
 *
 * Name, region, network, and description are immutable; collector ILB,
 * mirrored sources, filter, enable, and priority update in place.
 *
 * ### Creating a Packet Mirroring Policy
 * **Example:** Mirror VMs by network tag
 * ```typescript
 * const policy = yield* GCP.Compute.PacketMirroring("Capture", {
 *   network: vpc.selfLink,
 *   collectorIlb: collector.selfLink,
 *   mirroredResources: { tags: ["mirror-me"] },
 * });
 * ```
 *
 * **Example:** Named policy with a traffic filter
 * ```typescript
 * const policy = yield* GCP.Compute.PacketMirroring("Capture", {
 *   packetMirroringName: "app-capture",
 *   region: "us-central1",
 *   description: "tcp to the collector",
 *   network: "default",
 *   collectorIlb: collector.selfLink,
 *   mirroredResources: {
 *     subnetworks: [subnet.selfLink],
 *     tags: ["web"],
 *   },
 *   filter: {
 *     direction: "BOTH",
 *     ipProtocols: ["tcp"],
 *     cidrRanges: ["0.0.0.0/0"],
 *   },
 *   priority: 800,
 * });
 * ```
 *
 * ### Updating a Policy
 * **Example:** Disable mirroring without deleting the policy
 * ```typescript
 * const policy = yield* GCP.Compute.PacketMirroring("Capture", {
 *   packetMirroringName: "app-capture",
 *   network: vpc.selfLink,
 *   collectorIlb: collector.selfLink,
 *   mirroredResources: { tags: ["mirror-me"] },
 *   enable: false,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const PacketMirroring = Resource<PacketMirroring>(
  "GCP.Compute.PacketMirroring",
);

export class PacketMirroringNotResolved extends Data.TaggedError(
  "GCP.Compute.PacketMirroringNotResolved",
)<{
  packetMirroringName: string;
  region: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `p${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  return next.length > 0 ? next : "packet";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const toNetworkUrl = (project: string, network: string) => {
  if (network.includes("/")) {
    return network.startsWith("projects/") || network.startsWith("http")
      ? network
      : `projects/${project}/${network.replace(/^\//, "")}`;
  }
  return `projects/${project}/global/networks/${network}`;
};

const toForwardingRuleUrl = (
  project: string,
  region: string,
  collectorIlb: string,
) => {
  if (collectorIlb.includes("/")) {
    return collectorIlb.startsWith("projects/") ||
      collectorIlb.startsWith("http")
      ? collectorIlb
      : `projects/${project}/${collectorIlb.replace(/^\//, "")}`;
  }
  return `projects/${project}/regions/${region}/forwardingRules/${collectorIlb}`;
};

const toSubnetworkUrl = (project: string, region: string, subnet: string) => {
  if (subnet.includes("/")) {
    return subnet.startsWith("projects/") || subnet.startsWith("http")
      ? subnet
      : `projects/${project}/${subnet.replace(/^\//, "")}`;
  }
  return `projects/${project}/regions/${region}/subnetworks/${subnet}`;
};

const toInstanceUrl = (project: string, instance: string) => {
  if (instance.includes("/")) {
    return instance.startsWith("projects/") || instance.startsWith("http")
      ? instance
      : `projects/${project}/${instance.replace(/^\//, "")}`;
  }
  return instance;
};

const enableOf = (
  value: boolean | string | undefined,
): compute.PacketMirroringEnableEnum =>
  value === false || value === "FALSE" ? "FALSE" : DEFAULT_ENABLE;

const enableFlag = (value: string | undefined) => enableOf(value) === "TRUE";

const sorted = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])].map(String).sort();

const urlsKey = (values: ReadonlyArray<string> | undefined) =>
  sorted((values ?? []).map(lastSegment)).join(",");

const listsKey = (values: ReadonlyArray<string> | undefined) =>
  sorted(values).join(",");

const toApiMirrored = (
  project: string,
  region: string,
  resources: PacketMirroringMirroredResources,
): compute.PacketMirroringMirroredResourceInfo => ({
  tags: resources.tags,
  subnetworks: resources.subnetworks?.map((url) => ({
    url: toSubnetworkUrl(project, region, url),
  })),
  instances: resources.instances?.map((url) => ({
    url: toInstanceUrl(project, url),
  })),
});

const fromApiMirrored = (
  resources: compute.PacketMirroringMirroredResourceInfo | undefined,
) => ({
  subnetworks: (resources?.subnetworks ?? []).flatMap((item) =>
    item.url ? [item.url] : [],
  ),
  instances: (resources?.instances ?? []).flatMap((item) =>
    item.url ? [item.url] : [],
  ),
  tags: resources?.tags ?? [],
});

const toApiFilter = (
  filter: PacketMirroringFilter | undefined,
): compute.PacketMirroringFilter | undefined => {
  if (filter === undefined) return undefined;
  return {
    direction: filter.direction ?? DEFAULT_DIRECTION,
    IPProtocols: filter.ipProtocols,
    cidrRanges: filter.cidrRanges,
  };
};

const fromApiFilter = (filter: compute.PacketMirroringFilter | undefined) => {
  if (filter === undefined) return undefined;
  const ipProtocols = filter.IPProtocols ?? [];
  const cidrRanges = filter.cidrRanges ?? [];
  const direction = filter.direction;
  if (
    direction === undefined &&
    ipProtocols.length === 0 &&
    cidrRanges.length === 0
  ) {
    return undefined;
  }
  return {
    direction,
    ipProtocols,
    cidrRanges,
  };
};

const filterKey = (filter: PacketMirroringFilter | undefined) => {
  const direction = (filter?.direction ?? DEFAULT_DIRECTION).toUpperCase();
  return `${direction}|${listsKey(filter?.ipProtocols)}|${listsKey(filter?.cidrRanges)}`;
};

const mirroredKey = (resources: PacketMirroringMirroredResources) =>
  [
    `tags=${listsKey(resources.tags)}`,
    `subnets=${urlsKey(resources.subnetworks)}`,
    `instances=${urlsKey(resources.instances)}`,
  ].join("|");

const toAttrs = (policy: compute.PacketMirroring, project: string) => {
  const parsed = parseDescription(policy.description);
  const mirrored = fromApiMirrored(policy.mirroredResources);
  return {
    packetMirroringName: policy.name ?? policy.id ?? "",
    project,
    region: lastSegment(policy.region).toLowerCase(),
    description: parsed.description,
    network: policy.network?.url ?? "",
    networkCanonicalUrl: policy.network?.canonicalUrl,
    collectorIlb: policy.collectorIlb?.url ?? "",
    collectorIlbCanonicalUrl: policy.collectorIlb?.canonicalUrl,
    mirroredResources: mirrored,
    enable: enableFlag(policy.enable),
    priority: policy.priority ?? DEFAULT_PRIORITY,
    filter: fromApiFilter(policy.filter),
    selfLink: policy.selfLink,
    packetMirroringId: policy.id,
    creationTimestamp: policy.creationTimestamp,
    kind: policy.kind,
  };
};

const getByName = (project: string, region: string, packetMirroring: string) =>
  compute
    .getPacketMirrorings({ project, region, packetMirroring })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requirePolicy = (
  project: string,
  region: string,
  packetMirroringName: string,
) =>
  getByName(project, region, packetMirroringName).pipe(
    Effect.flatMap((existing) =>
      existing !== undefined
        ? Effect.succeed(existing)
        : Effect.fail(
            new PacketMirroringNotResolved({ packetMirroringName, region }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.PacketMirroringNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

export const PacketMirroringProvider = () =>
  Provider.succeed(PacketMirroring, {
    stables: [
      "packetMirroringName",
      "project",
      "region",
      "network",
      "packetMirroringId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName =
        olds?.packetMirroringName ?? output?.packetMirroringName;
      const nextName = news.packetMirroringName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? previousRegion,
        env.region,
      );
      const previousNetwork = lastSegment(olds?.network ?? output?.network);
      const nextNetwork = lastSegment(news.network);
      const previousDescription =
        olds?.description ?? output?.description ?? "";
      const nextDescription = news.description ?? "";

      const replace =
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName) ||
        previousRegion !== nextRegion ||
        (previousNetwork.length > 0 &&
          nextNetwork.length > 0 &&
          previousNetwork !== nextNetwork) ||
        previousDescription !== nextDescription;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousName !== undefined &&
          nextName !== undefined &&
          previousName === nextName &&
          previousRegion === nextRegion,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const packetMirroringName = yield* toName(
        id,
        olds?.packetMirroringName,
        output?.packetMirroringName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        packetMirroringName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListPacketMirrorings
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.packetMirrorings ?? [])
              .filter((item) => {
                const { labels } = parseDescription(item.description);
                return Object.keys(labels).some((key) =>
                  key.startsWith("alchemy-"),
                );
              })
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const packetMirroringName = yield* toName(
        id,
        news.packetMirroringName,
        output?.packetMirroringName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredNetwork = toNetworkUrl(env.project, news.network);
      const desiredCollector = toForwardingRuleUrl(
        env.project,
        region,
        news.collectorIlb,
      );
      const desiredEnable = enableOf(news.enable);
      const desiredPriority = news.priority ?? DEFAULT_PRIORITY;
      const desiredMirrored = toApiMirrored(
        env.project,
        region,
        news.mirroredResources,
      );
      const desiredFilter = toApiFilter(news.filter);

      let current = yield* getByName(env.project, region, packetMirroringName);

      if (current === undefined) {
        const inserted = yield* compute
          .insertPacketMirrorings({
            project: env.project,
            region,
            body: {
              name: packetMirroringName,
              description: desiredDescription,
              enable: desiredEnable,
              priority: desiredPriority,
              network: { url: desiredNetwork },
              collectorIlb: { url: desiredCollector },
              mirroredResources: desiredMirrored,
              filter: desiredFilter,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            // A just-created collector forwarding rule is briefly not ready.
            Effect.retry({
              while: (error) => error._tag === "CollectorIlbNotReady",
              times: 8,
              schedule: Schedule.spaced("3 seconds"),
            }),
          );
        if (inserted !== undefined) {
          yield* waitRegionOperation(env.project, region, inserted);
        }
        current = yield* requirePolicy(
          env.project,
          region,
          packetMirroringName,
        );
      }

      if (current === undefined) {
        return yield* new PacketMirroringNotResolved({
          packetMirroringName,
          region,
        });
      }

      const observed = toAttrs(current, env.project);
      const patch: compute.PacketMirroring = {};

      if ((current.description ?? "") !== desiredDescription) {
        patch.description = desiredDescription;
      }
      if (enableOf(current.enable) !== desiredEnable) {
        patch.enable = desiredEnable;
      }
      if (observed.priority !== desiredPriority) {
        patch.priority = desiredPriority;
      }
      if (
        lastSegment(observed.collectorIlb) !== lastSegment(desiredCollector)
      ) {
        patch.collectorIlb = { url: desiredCollector };
      }
      if (
        mirroredKey(observed.mirroredResources) !==
        mirroredKey(news.mirroredResources)
      ) {
        patch.mirroredResources = desiredMirrored;
      }
      if (filterKey(observed.filter) !== filterKey(news.filter)) {
        patch.filter = desiredFilter ?? {
          direction: DEFAULT_DIRECTION,
          IPProtocols: [],
          cidrRanges: [],
        };
      }

      if (Object.keys(patch).length > 0) {
        yield* compute
          .patchPacketMirrorings({
            project: env.project,
            region,
            packetMirroring: packetMirroringName,
            body: patch,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        current = yield* requirePolicy(
          env.project,
          region,
          packetMirroringName,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      const operation = yield* compute
        .deletePacketMirrorings({
          project: env.project,
          region,
          packetMirroring: output.packetMirroringName,
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
        yield* waitRegionOperation(env.project, region, operation, {
          ignore: ["RESOURCE_NOT_FOUND"],
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
    }),
  });
