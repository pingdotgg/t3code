import { Services } from "@distilled.cloud/hetzner";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { waitForAction } from "./actions.ts";
import {
  alchemyStackSelector,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  labelSelector,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

export class NetworkNotCreated extends Data.TaggedError(
  "Hetzner.NetworkNotCreated",
)<{
  name: string;
}> {}

export type NetworkSubnetType = "cloud" | "server" | "vswitch";

export interface NetworkSubnet {
  /**
   * Subnet type. `cloud` is the usual choice for Cloud Servers and Load
   * Balancers. `vswitch` attaches a Robot vSwitch and requires `vswitchId`.
   */
  type: NetworkSubnetType;
  /**
   * IPv4 range of the subnet in CIDR notation. Must be a subnet of the
   * parent network `ipRange` and must not overlap other subnets or route
   * destinations. Minimum size is `/30`. If omitted on create, Hetzner
   * allocates the first free `/24`.
   */
  ipRange?: string;
  /**
   * Network zone this subnet lives in (`eu-central`, `us-east`, `us-west`,
   * `ap-southeast`). `nbg1` / `fsn1` / `hel1` are in `eu-central`.
   */
  networkZone: string;
  /**
   * Robot vSwitch id. Required when `type` is `vswitch`.
   */
  vswitchId?: number;
}

export interface NetworkRoute {
  /**
   * Destination prefix. Must be an RFC1918 IPv4 range or `0.0.0.0/0`, and
   * must not overlap any subnet or other route destination.
   */
  destination: string;
  /**
   * Next-hop IP inside the network. Cannot be the first IP of the
   * network's `ipRange` or `172.31.1.1`.
   */
  gateway: string;
}

export interface NetworkProps {
  /**
   * Name of the Network. Must be unique per project. If omitted, a unique
   * name is generated from the app, stage, and logical ID.
   */
  name?: string;
  /**
   * IPv4 range of the whole Network in CIDR notation. Must be RFC1918 and
   * at least `/24`. Can only be **extended** later (`change_ip_range`);
   * shrinking or moving to a non-superset range replaces the Network.
   */
  ipRange: string;
  /**
   * Subnets allocated in this Network. Synced via `add_subnet` /
   * `delete_subnet` — they are not their own resources.
   */
  subnets?: NetworkSubnet[];
  /**
   * Static routes in this Network. Synced via `add_route` / `delete_route`.
   */
  routes?: NetworkRoute[];
  /**
   * Expose this Network's routes to a connected Robot vSwitch.
   * @default false
   */
  exposeRoutesToVswitch?: boolean;
  /**
   * Prevent the Network from being deleted in the Cloud Console / API
   * until this is cleared. The provider disables protection before delete.
   * @default false
   */
  deleteProtection?: boolean;
  /**
   * User-defined labels. Alchemy ownership labels (`alchemy.stack` /
   * `alchemy.stage` / `alchemy.id`) are merged in automatically.
   */
  labels?: Record<string, string>;
}

export interface NetworkSubnetAttr extends NetworkSubnet {
  /** Gateway Hetzner assigned to this subnet. */
  gateway: string;
}

export type Network = Resource<
  "Hetzner.Network",
  NetworkProps,
  {
    /** Numeric Hetzner Network id. */
    networkId: number;
    /** Observed Network name. */
    name: string;
    /** Observed IPv4 range (CIDR). */
    ipRange: string;
    /** Observed subnets, including the assigned gateway. */
    subnets: NetworkSubnetAttr[];
    /** Observed static routes. */
    routes: NetworkRoute[];
    /** Server ids currently attached to this Network. */
    servers: number[];
    /** Load Balancer ids currently attached to this Network. */
    loadBalancers: number[];
    /** Whether delete protection is enabled. */
    deleteProtection: boolean;
    /** Whether routes are exposed to a connected vSwitch. */
    exposeRoutesToVswitch: boolean;
    /** User-facing labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    created: string;
  },
  never,
  Providers
>;

/**
 * A Hetzner Cloud private Network — an isolated IPv4 range that Cloud
 * Servers and Load Balancers attach to. Subnets, routes, delete protection,
 * and labels are synced on the Network itself; `network_actions` are not
 * modeled as their own resources.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#networks
 *
 * ### Creating a Network
 * **Example:** Basic Network
 * ```typescript
 * const network = yield* Hetzner.Network("vpc", {
 *   ipRange: "10.0.0.0/16",
 * });
 * ```
 *
 * **Example:** Network with a cloud subnet
 * ```typescript
 * const network = yield* Hetzner.Network("vpc", {
 *   ipRange: "10.0.0.0/16",
 *   subnets: [
 *     { type: "cloud", ipRange: "10.0.1.0/24", networkZone: "eu-central" },
 *   ],
 * });
 * ```
 *
 * ### Routes and protection
 * **Example:** Static route and delete protection
 * ```typescript
 * const network = yield* Hetzner.Network("vpc", {
 *   ipRange: "10.0.0.0/16",
 *   subnets: [
 *     { type: "cloud", ipRange: "10.0.1.0/24", networkZone: "eu-central" },
 *   ],
 *   routes: [{ destination: "10.10.0.0/24", gateway: "10.0.1.2" }],
 *   deleteProtection: true,
 * });
 * ```
 *
 * ### Labels
 * **Example:** User labels
 * ```typescript
 * const network = yield* Hetzner.Network("vpc", {
 *   ipRange: "10.0.0.0/16",
 *   labels: { env: "prod", role: "vpc" },
 * });
 * ```
 *
 * @resource
 */
export const Network = Resource<Network>("Hetzner.Network");

type ObservedNetwork = {
  id: number;
  name: string;
  ip_range: string;
  subnets: ReadonlyArray<{
    type: string;
    ip_range?: string;
    network_zone: string;
    gateway: string;
    vswitch_id?: number | null;
  }>;
  routes: ReadonlyArray<{ destination: string; gateway: string }>;
  servers: ReadonlyArray<number>;
  load_balancers?: ReadonlyArray<number>;
  protection: { delete: boolean };
  labels: Record<string, string | undefined>;
  created: string;
  expose_routes_to_vswitch: boolean;
};

const busy = (e: { readonly _tag: string }): boolean =>
  e._tag === "Locked" || e._tag === "Conflict";

const busyRetry = {
  while: busy,
  times: 8,
  schedule: Schedule.min([
    Schedule.exponential(Duration.millis(500), 1.5),
    Schedule.spaced(Duration.seconds(5)),
  ]),
} as const;

const alreadyThere = (e: { readonly _tag: string }): boolean =>
  e._tag === "Conflict" || e._tag === "UnprocessableEntity";

const alreadyGone = (e: { readonly _tag: string }): boolean =>
  e._tag === "NotFound" || e._tag === "UnprocessableEntity";

const createNetworkName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }))
    );
  });

const desiredLabelsOf = Effect.fn(function* (
  id: string,
  labels: Record<string, string> | undefined,
) {
  return {
    ...toLabels(labels),
    ...(yield* createInternalLabels(id)),
  };
});

const subnetKey = (subnet: {
  type: string;
  ipRange?: string;
  networkZone: string;
  vswitchId?: number | null;
}): string =>
  `${subnet.type}|${subnet.ipRange ?? ""}|${subnet.networkZone}|${subnet.vswitchId ?? ""}`;

const routeKey = (route: { destination: string; gateway: string }): string =>
  `${route.destination}|${route.gateway}`;

const toSubnetAttr = (
  subnet: ObservedNetwork["subnets"][number],
): NetworkSubnetAttr => ({
  type: subnet.type as NetworkSubnetType,
  ipRange: subnet.ip_range,
  networkZone: subnet.network_zone,
  gateway: subnet.gateway,
  vswitchId: subnet.vswitch_id ?? undefined,
});

const toAttrs = (network: ObservedNetwork): Network["Attributes"] => ({
  networkId: network.id,
  name: network.name,
  ipRange: network.ip_range,
  subnets: network.subnets.map(toSubnetAttr),
  routes: network.routes.map((route) => ({
    destination: route.destination,
    gateway: route.gateway,
  })),
  servers: [...network.servers],
  loadBalancers: [...(network.load_balancers ?? [])],
  deleteProtection: network.protection.delete,
  exposeRoutesToVswitch: network.expose_routes_to_vswitch,
  labels: stripInternalLabels(tagRecord(network.labels)),
  created: network.created,
});

const parseCidr = (
  cidr: string,
): { ip: number; prefix: number } | undefined => {
  const [addr, prefixRaw] = cidr.split("/");
  if (addr === undefined || prefixRaw === undefined) return undefined;
  const parts = addr.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
  const ip =
    ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>>
    0;
  return { ip, prefix };
};

/** True when `outer` is equal to or a supernet of `inner`. */
const cidrContains = (outer: string, inner: string): boolean => {
  const a = parseCidr(outer);
  const b = parseCidr(inner);
  if (a === undefined || b === undefined) return false;
  if (a.prefix > b.prefix) return false;
  const mask = a.prefix === 0 ? 0 : (0xffffffff << (32 - a.prefix)) >>> 0;
  return (a.ip & mask) === (b.ip & mask);
};

const getById = (id: number) =>
  Services.networks.getNetwork({ id }).pipe(
    Effect.map(({ network }) => network),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const findByName = (name: string) =>
  Services.networks
    .listNetworks({ name, per_page: 50 })
    .pipe(
      Effect.map(({ networks }) => networks.find((item) => item.name === name)),
    );

const findByLabels = (labels: Record<string, string>) =>
  Services.networks
    .listNetworks({
      label_selector: labelSelector(labels),
      per_page: 50,
    })
    .pipe(Effect.map(({ networks }) => networks[0]));

const observe = (networkId: number | undefined, name: string, id: string) =>
  Effect.gen(function* () {
    if (networkId !== undefined) {
      const byId = yield* getById(networkId);
      if (byId) return byId;
    }
    const byLabels = yield* findByLabels(yield* createInternalLabels(id));
    if (byLabels) return byLabels;
    return yield* findByName(name);
  });

const runAction = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<{ action: { id: number } }, E, R>,
) =>
  effect.pipe(
    Effect.retry(busyRetry),
    Effect.flatMap(({ action }) => waitForAction(action)),
  );

const syncIpRange = (networkId: number, observed: string, desired: string) =>
  Effect.gen(function* () {
    if (observed === desired) return;
    yield* runAction(
      Services.networkActions.changeNetworkIpRange({
        id: networkId,
        ip_range: desired,
      }),
    );
  });

const syncMetadata = (args: {
  networkId: number;
  observed: ObservedNetwork;
  name: string;
  exposeRoutesToVswitch: boolean;
  labels: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const observedLabels = tagRecord(args.observed.labels);
    const { removed, upsert } = diffLabels(observedLabels, args.labels);
    const labelsChanged = removed.length > 0 || upsert.length > 0;
    const nameChanged = args.observed.name !== args.name;
    const exposeChanged =
      args.observed.expose_routes_to_vswitch !== args.exposeRoutesToVswitch;
    if (!labelsChanged && !nameChanged && !exposeChanged) return;
    yield* Services.networks
      .updateNetwork({
        id: args.networkId,
        name: nameChanged ? args.name : undefined,
        expose_routes_to_vswitch: exposeChanged
          ? args.exposeRoutesToVswitch
          : undefined,
        labels: labelsChanged ? args.labels : undefined,
      })
      .pipe(Effect.retry(busyRetry));
  });

const syncSubnets = (
  networkId: number,
  observed: ObservedNetwork["subnets"],
  desired: readonly NetworkSubnet[],
) =>
  Effect.gen(function* () {
    const observedMapped = observed.map((subnet) => ({
      type: subnet.type,
      ipRange: subnet.ip_range,
      networkZone: subnet.network_zone,
      vswitchId: subnet.vswitch_id ?? undefined,
    }));
    const observedKeys = new Set(observedMapped.map(subnetKey));
    const desiredKeys = new Set(desired.map(subnetKey));

    for (const subnet of observedMapped) {
      if (desiredKeys.has(subnetKey(subnet))) continue;
      if (subnet.ipRange === undefined) continue;
      yield* runAction(
        Services.networkActions.deleteNetworkSubnet({
          id: networkId,
          ip_range: subnet.ipRange,
        }),
      ).pipe(Effect.catchIf(alreadyGone, () => Effect.void));
    }

    for (const subnet of desired) {
      if (observedKeys.has(subnetKey(subnet))) continue;
      yield* runAction(
        Services.networkActions.addNetworkSubnet({
          id: networkId,
          type: subnet.type,
          ip_range: subnet.ipRange,
          network_zone: subnet.networkZone,
          vswitch_id: subnet.vswitchId,
        }),
      ).pipe(Effect.catchIf(alreadyThere, () => Effect.void));
    }
  });

const syncRoutes = (
  networkId: number,
  observed: ObservedNetwork["routes"],
  desired: readonly NetworkRoute[],
) =>
  Effect.gen(function* () {
    const observedKeys = new Set(observed.map(routeKey));
    const desiredKeys = new Set(desired.map(routeKey));

    for (const route of observed) {
      if (desiredKeys.has(routeKey(route))) continue;
      yield* runAction(
        Services.networkActions.deleteNetworkRoute({
          id: networkId,
          destination: route.destination,
          gateway: route.gateway,
        }),
      ).pipe(Effect.catchIf(alreadyGone, () => Effect.void));
    }

    for (const route of desired) {
      if (observedKeys.has(routeKey(route))) continue;
      yield* runAction(
        Services.networkActions.addNetworkRoute({
          id: networkId,
          destination: route.destination,
          gateway: route.gateway,
        }),
      ).pipe(Effect.catchIf(alreadyThere, () => Effect.void));
    }
  });

const syncProtection = (
  networkId: number,
  observed: boolean,
  desired: boolean,
) =>
  Effect.gen(function* () {
    if (observed === desired) return;
    yield* runAction(
      Services.networkActions.changeNetworkProtection({
        id: networkId,
        delete: desired,
      }),
    );
  });

export const NetworkProvider = () =>
  Provider.succeed(Network, {
    stables: ["networkId", "created"],

    list: Effect.fn(function* () {
      return yield* Services.networks.listNetworks
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk, toAttrs)),
        );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (
        output !== undefined &&
        news.ipRange !== output.ipRange &&
        !cidrContains(news.ipRange, output.ipRange)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* createNetworkName(id, olds?.name ?? output?.name);
      const observed = yield* observe(output?.networkId, name, id);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed);
      return (yield* hasAlchemyLabels(id, tagRecord(observed.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* createNetworkName(
        id,
        news.name ?? (output === undefined ? undefined : output.name),
      );
      const desiredLabels = yield* desiredLabelsOf(id, news.labels);
      const desiredSubnets = news.subnets ?? [];
      const desiredRoutes = news.routes ?? [];
      const exposeRoutesToVswitch = news.exposeRoutesToVswitch ?? false;
      const deleteProtection = news.deleteProtection ?? false;

      // Observe — cached `output.networkId` is a hint. Fall back to
      // ownership labels, then the deterministic name.
      let current = yield* observe(output?.networkId, name, id);

      // A replacement create shares the logical id (and thus ownership
      // labels) with the outgoing generation. If the observed row cannot
      // accept the desired `ipRange` (Hetzner can only extend a range),
      // do not reuse it — create a new Network and let the engine delete
      // the old generation.
      if (
        current !== undefined &&
        current.ip_range !== news.ipRange &&
        !cidrContains(news.ipRange, current.ip_range)
      ) {
        current = undefined;
      }

      // Ensure — create when missing. A name-collision race is treated as
      // the peer winning; we pick that row up and continue into sync.
      if (current === undefined) {
        const created = yield* Services.networks
          .createNetwork({
            name,
            ip_range: news.ipRange,
            labels: desiredLabels,
            subnets: desiredSubnets.map((subnet) => ({
              type: subnet.type,
              ip_range: subnet.ipRange,
              network_zone: subnet.networkZone,
              vswitch_id: subnet.vswitchId,
            })),
            routes: desiredRoutes.map((route) => ({
              destination: route.destination,
              gateway: route.gateway,
            })),
            expose_routes_to_vswitch: exposeRoutesToVswitch,
          })
          .pipe(
            Effect.retry(busyRetry),
            Effect.map((response) => response.network),
            Effect.catchIf(alreadyThere, () => findByName(name)),
          );
        current = created;
      }

      if (current === undefined) {
        return yield* new NetworkNotCreated({ name });
      }

      // Sync each mutable aspect from observed cloud state, not `olds`.
      yield* syncIpRange(current.id, current.ip_range, news.ipRange);
      yield* syncMetadata({
        networkId: current.id,
        observed: current,
        name,
        exposeRoutesToVswitch,
        labels: desiredLabels,
      });
      const afterMeta = (yield* getById(current.id)) ?? current;
      yield* syncSubnets(current.id, afterMeta.subnets, desiredSubnets);
      const afterSubnets = (yield* getById(current.id)) ?? afterMeta;
      yield* syncRoutes(current.id, afterSubnets.routes, desiredRoutes);
      const afterRoutes = (yield* getById(current.id)) ?? afterSubnets;
      yield* syncProtection(
        current.id,
        afterRoutes.protection.delete,
        deleteProtection,
      );

      const fresh = yield* getById(current.id);
      return toAttrs(fresh ?? afterRoutes);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.deleteProtection) {
        yield* runAction(
          Services.networkActions.changeNetworkProtection({
            id: output.networkId,
            delete: false,
          }),
        ).pipe(Effect.catchIf(alreadyGone, () => Effect.void));
      }
      yield* Services.networks.deleteNetwork({ id: output.networkId }).pipe(
        Effect.retry(busyRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
