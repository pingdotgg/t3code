import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import type { ConnectionTarget } from "./model.ts";

/**
 * A saved environment can hold several routes: T3 Connect, direct URLs (LAN,
 * tailnet, public), and SSH. The client connects over the first route in
 * preference order that answers as the expected environment, and moves back
 * to a better one when it becomes reachable again.
 */

export type ConnectionRouteKind = "relay" | "loopback" | "lan" | "tailnet" | "public" | "ssh";

/** An environment has at most one T3 Connect route, so it needs no per-route id. */
export const RELAY_ROUTE_ID = "relay";

export function connectionRouteId(target: ConnectionTarget): string {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return "primary";
    case "RelayConnectionTarget":
      return RELAY_ROUTE_ID;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

/** Every route of an entry, preferred first. */
export function connectionRoutes(entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  return [{ target: entry.target, profile: entry.profile }, ...(entry.alternateRoutes ?? [])];
}

/** Builds an entry whose preferred route is the first of `routes`, which must not be empty. */
export function entryWithRoutes(
  entry: ConnectionCatalogEntry,
  routes: ReadonlyArray<ConnectionRoute>,
): ConnectionCatalogEntry {
  const [first, ...rest] = routes;
  if (first === undefined) {
    throw new Error("A saved environment needs at least one route.");
  }
  const { alternateRoutes: _previous, ...base } = entry;
  return {
    ...base,
    target: first.target,
    profile: first.profile,
    ...(rest.length === 0 ? {} : { alternateRoutes: rest }),
  };
}

/** The entry a single route connects with. */
export function routeEntry(
  entry: ConnectionCatalogEntry,
  route: ConnectionRoute,
): ConnectionCatalogEntry {
  return entryWithRoutes(entry, [route]);
}

/** The base URL of a direct route, or null for T3 Connect and SSH. */
export function routeHttpBaseUrl(route: ConnectionRoute): string | null {
  if (route.target._tag === "PrimaryConnectionTarget") return route.target.httpBaseUrl;
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" ? profile.httpBaseUrl : null;
}

function routeHostname(route: ConnectionRoute): string | null {
  const httpBaseUrl = routeHttpBaseUrl(route);
  if (httpBaseUrl === null) return null;
  try {
    return new URL(httpBaseUrl).hostname;
  } catch {
    return null;
  }
}

export function connectionRouteKind(route: ConnectionRoute): ConnectionRouteKind {
  switch (route.target._tag) {
    case "RelayConnectionTarget":
      return "relay";
    case "SshConnectionTarget":
      return "ssh";
    case "PrimaryConnectionTarget":
    case "BearerConnectionTarget": {
      const hostname = routeHostname(route);
      if (hostname === null) return "public";
      if (isLocalLoopbackHost(hostname)) return "loopback";
      if (isTailnetHost(hostname)) return "tailnet";
      return isPrivateNetworkHost(hostname) ? "lan" : "public";
    }
  }
}

const ROUTE_KIND_RANK: Record<ConnectionRouteKind, number> = {
  loopback: 0,
  lan: 1,
  tailnet: 2,
  public: 3,
  ssh: 4,
  relay: 5,
};

/**
 * Where a newly added route goes: after every saved route of the same or a
 * faster kind, so LAN lands ahead of tailnet and both ahead of T3 Connect.
 * Users can reorder afterwards; this only picks a sensible starting point.
 */
export function insertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
): ReadonlyArray<ConnectionRoute> {
  const rank = ROUTE_KIND_RANK[connectionRouteKind(route)];
  const index = routes.findIndex(
    (existing) => ROUTE_KIND_RANK[connectionRouteKind(existing)] > rank,
  );
  return index === -1
    ? [...routes, route]
    : [...routes.slice(0, index), route, ...routes.slice(index)];
}

/** Replaces the route with the same id in place, or inserts it by kind. */
export function upsertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
): ReadonlyArray<ConnectionRoute> {
  const id = connectionRouteId(route.target);
  return routes.some((existing) => connectionRouteId(existing.target) === id)
    ? routes.map((existing) => (connectionRouteId(existing.target) === id ? route : existing))
    : insertRoute(routes, route);
}

/**
 * A saved route that reaches the same address as `route`: the same bearer
 * URL, or the same SSH target (alias, host, user, and port, as desktop keys
 * its tunnels). Registering it again replaces that route, even when it was
 * saved under another id.
 */
export function findRouteToSameAddress(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
): ConnectionRoute | undefined {
  const key = routeAddressKey(route);
  return key === null ? undefined : routes.find((existing) => routeAddressKey(existing) === key);
}

function routeAddressKey(route: ConnectionRoute): string | null {
  const profile = Option.getOrNull(route.profile);
  switch (profile?._tag) {
    case "BearerConnectionProfile":
      return `bearer:${profile.httpBaseUrl.replace(/\/+$/, "")}`;
    case "SshConnectionProfile":
      return `ssh:${sshTargetKey(profile.target)}`;
    default:
      return null;
  }
}

/** Short user-facing route description: "LAN", "Tailscale", "T3 Connect", a URL, or an SSH host. */
export function connectionRouteLabel(route: ConnectionRoute): string {
  switch (connectionRouteKind(route)) {
    case "relay":
      return "T3 Connect";
    case "loopback":
      return "This device";
    case "lan":
      return "LAN";
    case "tailnet":
      return "Tailscale";
    case "ssh": {
      const profile = Option.getOrNull(route.profile);
      return profile?._tag === "SshConnectionProfile"
        ? `SSH ${profile.target.username ? `${profile.target.username}@` : ""}${profile.target.hostname}`
        : "SSH";
    }
    case "public":
      return routeHostname(route) ?? "Remote link";
  }
}

/** The address shown under a route, or null for T3 Connect. */
export function connectionRouteAddress(route: ConnectionRoute): string | null {
  if (route.target._tag === "SshConnectionTarget") {
    const profile = Option.getOrNull(route.profile);
    return profile?._tag === "SshConnectionProfile" ? profile.target.alias : null;
  }
  return routeHttpBaseUrl(route);
}

/** Whether the environment can be reached through T3 Connect. */
export function hasRelayRoute(
  entry: Pick<ConnectionCatalogEntry, "target" | "alternateRoutes">,
): boolean {
  return [entry.target, ...(entry.alternateRoutes ?? []).map((route) => route.target)].some(
    (target) => target._tag === "RelayConnectionTarget",
  );
}

/** One SSH target, as desktop keys its tunnels: alias, host, user, and port. */
export function sshTargetKey(target: DesktopSshEnvironmentTarget): string {
  return JSON.stringify([target.alias, target.hostname, target.username, target.port]);
}
