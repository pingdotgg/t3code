import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
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

const DEFAULT_PRIORITY = 1000;
const DEFAULT_INTERNET_GATEWAY = "default-internet-gateway";

export type RouteProps = {
  /**
   * Route name (RFC1035, 1-63 chars). If omitted, a unique name is generated
   * from the stack, stage, and logical id. Immutable — changing it replaces
   * the route.
   */
  routeName?: string;
  /**
   * Destination range of outgoing packets this route applies to (IPv4 or
   * IPv6 CIDR). Immutable — changing it replaces the route.
   */
  destRange: string;
  /**
   * VPC network this route belongs to. Accepts a name (`default`), a
   * partial URL (`global/networks/default`), or a full resource URL.
   * Immutable — changing it replaces the route.
   */
  network: string;
  /**
   * Optional description. Compute routes have no labels field, so Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored
   * in a `[alchemy …]` prefix for `list` / nuke. Immutable — changing the
   * user-facing description replaces the route.
   */
  description?: string;
  /**
   * Priority used to break ties among equal-prefix matches. Lower wins.
   * Range `0`–`65535`.
   * @default 1000
   */
  priority?: number;
  /**
   * Instance tags this route applies to. Empty means every instance.
   * Immutable — changing it replaces the route.
   */
  tags?: string[];
  /**
   * Next hop gateway URL or `default-internet-gateway`. Exactly one next
   * hop must be set. Immutable.
   */
  nextHopGateway?: string;
  /**
   * Next hop IP address (IPv4 or IPv6). Exactly one next hop must be set.
   * Immutable.
   */
  nextHopIp?: string;
  /**
   * Next hop instance URL. Exactly one next hop must be set. Immutable.
   */
  nextHopInstance?: string;
  /**
   * Next hop VPN tunnel URL. Exactly one next hop must be set. Immutable.
   */
  nextHopVpnTunnel?: string;
  /**
   * Next hop internal load balancer forwarding rule URL or IP. Exactly one
   * next hop must be set. Immutable.
   */
  nextHopIlb?: string;
};

export type Route = Resource<
  "GCP.Compute.Route",
  RouteProps,
  {
    /** Route name. */
    routeName: string;
    /** Project id. */
    project: string;
    /** Destination CIDR. */
    destRange: string;
    /** Network URL. */
    network: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Route priority. */
    priority: number;
    /** Instance tags this route applies to. */
    tags: string[];
    /** Next hop gateway URL, if set. */
    nextHopGateway: string | undefined;
    /** Next hop IP, if set. */
    nextHopIp: string | undefined;
    /** Next hop instance URL, if set. */
    nextHopInstance: string | undefined;
    /** Next hop VPN tunnel URL, if set. */
    nextHopVpnTunnel: string | undefined;
    /** Next hop internal load balancer, if set. */
    nextHopIlb: string | undefined;
    /** Next hop network URL (output-only, typically subnet routes). */
    nextHopNetwork: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    id: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Route type (`STATIC`, `SUBNET`, `BGP`, `TRANSIT`). */
    routeType: string | undefined;
    /** Route status. */
    routeStatus: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VPC static route.
 *
 * Routes tell instances where to send packets whose destination matches
 * `destRange`. Compute Engine has no update API for routes — every
 * user-facing field is immutable and changing it replaces the resource.
 * Ownership is stamped into the description because routes have no labels.
 *
 * ### Creating a Route
 * **Example:** Default internet route on the default network
 * ```typescript
 * const route = yield* GCP.Compute.Route("internet", {
 *   destRange: "0.0.0.0/0",
 *   network: "default",
 *   nextHopGateway: "default-internet-gateway",
 * });
 * ```
 *
 * **Example:** Named route with priority and tags
 * ```typescript
 * const route = yield* GCP.Compute.Route("tagged", {
 *   routeName: "app-egress",
 *   destRange: "192.0.2.0/24",
 *   network: "default",
 *   nextHopGateway: "default-internet-gateway",
 *   priority: 100,
 *   tags: ["egress"],
 *   description: "test-net egress",
 * });
 * ```
 *
 * **Example:** Next hop IP
 * ```typescript
 * const route = yield* GCP.Compute.Route("appliance", {
 *   destRange: "10.200.0.0/16",
 *   network: "default",
 *   nextHopIp: "10.128.0.5",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Route = Resource<Route>("GCP.Compute.Route");

export class RouteNotResolved extends Data.TaggedError(
  "GCP.Compute.RouteNotResolved",
)<{
  routeName: string;
}> {}

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
    const rfc = generated.replace(/^[^a-z]+/, "r").replace(/-+$/g, "");
    return rfc.slice(0, 63);
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

const lastToken = (value: string | undefined) => {
  if (!value) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

const sameRef = (left: string | undefined, right: string | undefined) =>
  lastToken(left) === lastToken(right);

const sameTags = (left: string[] | undefined, right: string[] | undefined) =>
  [...(left ?? [])].sort().join("\0") === [...(right ?? [])].sort().join("\0");

const networkUrl = (project: string, network: string) => {
  if (network.includes("/")) {
    return network.startsWith("projects/") || network.startsWith("http")
      ? network
      : `projects/${project}/${network.replace(/^\//, "")}`;
  }
  return `projects/${project}/global/networks/${network}`;
};

const gatewayUrl = (project: string, gateway: string) => {
  if (gateway.includes("/")) return gateway;
  if (gateway === DEFAULT_INTERNET_GATEWAY) {
    return `projects/${project}/global/gateways/${DEFAULT_INTERNET_GATEWAY}`;
  }
  return gateway;
};

const hopOf = (props: {
  nextHopGateway?: string;
  nextHopIp?: string;
  nextHopInstance?: string;
  nextHopVpnTunnel?: string;
  nextHopIlb?: string;
}) => {
  if (props.nextHopGateway)
    return { kind: "gateway" as const, value: lastToken(props.nextHopGateway) };
  if (props.nextHopIp) return { kind: "ip" as const, value: props.nextHopIp };
  if (props.nextHopInstance)
    return {
      kind: "instance" as const,
      value: lastToken(props.nextHopInstance),
    };
  if (props.nextHopVpnTunnel)
    return {
      kind: "vpn" as const,
      value: lastToken(props.nextHopVpnTunnel),
    };
  if (props.nextHopIlb)
    return { kind: "ilb" as const, value: lastToken(props.nextHopIlb) };
  return undefined;
};

const toBody = (
  project: string,
  routeName: string,
  props: RouteProps,
  ownership: Record<string, string>,
): compute.Route => ({
  name: routeName,
  destRange: props.destRange,
  network: networkUrl(project, props.network),
  description: encodeDescription(ownership, props.description),
  priority: props.priority ?? DEFAULT_PRIORITY,
  tags: props.tags,
  nextHopGateway: props.nextHopGateway
    ? gatewayUrl(project, props.nextHopGateway)
    : undefined,
  nextHopIp: props.nextHopIp,
  nextHopInstance: props.nextHopInstance,
  nextHopVpnTunnel: props.nextHopVpnTunnel,
  nextHopIlb: props.nextHopIlb,
});

const toAttrs = (route: compute.Route, project: string) => {
  const parsed = parseDescription(route.description);
  return {
    routeName: route.name ?? "",
    project,
    destRange: route.destRange ?? "",
    network: route.network ?? "",
    description: parsed.description,
    priority: route.priority ?? DEFAULT_PRIORITY,
    tags: route.tags ?? [],
    nextHopGateway: route.nextHopGateway,
    nextHopIp: route.nextHopIp,
    nextHopInstance: route.nextHopInstance,
    nextHopVpnTunnel: route.nextHopVpnTunnel,
    nextHopIlb: route.nextHopIlb,
    nextHopNetwork: route.nextHopNetwork,
    selfLink: route.selfLink,
    id: route.id,
    creationTimestamp: route.creationTimestamp,
    routeType: route.routeType,
    routeStatus: route.routeStatus,
  };
};

const getByName = (project: string, route: string) =>
  compute
    .getRoutes({ project, route })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requireRoute = (project: string, routeName: string) =>
  getByName(project, routeName).pipe(
    Effect.flatMap((route) =>
      route
        ? Effect.succeed(route)
        : Effect.fail(new RouteNotResolved({ routeName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.RouteNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const removeRoute = (project: string, routeName: string) =>
  Effect.gen(function* () {
    const operation = yield* compute
      .deleteRoutes({
        project,
        route: routeName,
      })
      .pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("1 second"),
        }),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    if (operation !== undefined) {
      yield* waitGlobalOperation(project, operation, {
        ignore: ["RESOURCE_NOT_FOUND"],
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });

const matchesDesired = (route: compute.Route, news: RouteProps) => {
  if ((route.destRange ?? "") !== news.destRange) return false;
  if (!sameRef(route.network, news.network)) return false;
  if (
    (route.priority ?? DEFAULT_PRIORITY) !== (news.priority ?? DEFAULT_PRIORITY)
  ) {
    return false;
  }
  const parsed = parseDescription(route.description);
  if ((parsed.description ?? "") !== (news.description ?? "")) return false;
  if (!sameTags(route.tags, news.tags)) return false;
  const previousHop = hopOf({
    nextHopGateway: route.nextHopGateway,
    nextHopIp: route.nextHopIp,
    nextHopInstance: route.nextHopInstance,
    nextHopVpnTunnel: route.nextHopVpnTunnel,
    nextHopIlb: route.nextHopIlb,
  });
  const nextHop = hopOf(news);
  if (nextHop === undefined) return previousHop === undefined;
  return (
    previousHop !== undefined &&
    previousHop.kind === nextHop.kind &&
    previousHop.value === nextHop.value
  );
};

const immutableChanged = (
  news: RouteProps,
  olds: Partial<RouteProps> | undefined,
  output: Route["Attributes"] | undefined,
) => {
  const previousDest = olds?.destRange ?? output?.destRange;
  if (previousDest !== undefined && news.destRange !== previousDest) {
    return true;
  }
  const previousNetwork = olds?.network ?? output?.network;
  if (
    previousNetwork !== undefined &&
    !sameRef(news.network, previousNetwork)
  ) {
    return true;
  }
  const previousPriority =
    olds?.priority ?? output?.priority ?? DEFAULT_PRIORITY;
  if ((news.priority ?? DEFAULT_PRIORITY) !== previousPriority) {
    return true;
  }
  const previousDescription = olds?.description ?? output?.description ?? "";
  if ((news.description ?? "") !== previousDescription) {
    return true;
  }
  if (!sameTags(news.tags, olds?.tags ?? output?.tags)) {
    return true;
  }
  const previousHop = hopOf(olds ?? {}) ?? hopOf(output ?? {});
  const nextHop = hopOf(news);
  if (
    nextHop !== undefined &&
    (previousHop === undefined ||
      previousHop.kind !== nextHop.kind ||
      previousHop.value !== nextHop.value)
  ) {
    return true;
  }
  return false;
};

export const RouteProvider = () =>
  Provider.succeed(Route, {
    stables: [
      "routeName",
      "project",
      "id",
      "selfLink",
      "creationTimestamp",
      "network",
      "destRange",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.routeName ?? output?.routeName;
      const nextName = news.routeName ?? previousName;
      if (previousName === undefined && output === undefined) {
        return undefined;
      }
      const nameChanged =
        news.routeName !== undefined &&
        previousName !== undefined &&
        news.routeName !== previousName;
      if (nameChanged || immutableChanged(news, olds, output)) {
        return {
          action: "replace" as const,
          deleteFirst: nextName !== undefined && nextName === previousName,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const routeName = yield* toName(id, olds?.routeName, output?.routeName);
      const existing = yield* getByName(env.project, routeName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listRoutes.items({ project: env.project }).pipe(
          Stream.filter((route) => {
            const { labels } = parseDescription(route.description);
            return Object.keys(labels).some((key) =>
              key.startsWith("alchemy-"),
            );
          }),
          Stream.map((route) => toAttrs(route, env.project)),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const routeName = yield* toName(id, news.routeName, output?.routeName);
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(env.project, routeName, news, ownership);

      let current = yield* getByName(env.project, routeName);

      if (current !== undefined && !matchesDesired(current, news)) {
        yield* removeRoute(env.project, routeName);
        current = undefined;
      }

      if (current === undefined) {
        yield* compute
          .insertRoutes({
            project: env.project,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* requireRoute(env.project, routeName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.routeName) return;
      const env = yield* GcpEnvironment.current;
      yield* removeRoute(env.project, output.routeName);
    }),
  });
