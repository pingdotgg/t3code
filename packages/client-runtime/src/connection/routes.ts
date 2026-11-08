import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import {
  EnvironmentId,
  type DesktopSshEnvironmentTarget,
  type LanGatewayPeerAdvertisement,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { gatewayPeerHttpBaseUrl } from "../environment/endpoint.ts";
import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { BearerConnectionTarget, type ConnectionTarget } from "./model.ts";

export type ConnectionRouteKind =
  | "relay"
  | "gateway"
  | "loopback"
  | "lan"
  | "tailnet"
  | "vpn"
  | "public"
  | "ssh";

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

export function connectionRoutes(entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  return [{ target: entry.target, profile: entry.profile }, ...(entry.alternateRoutes ?? [])];
}

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

export function routeEntry(
  entry: ConnectionCatalogEntry,
  route: ConnectionRoute,
): ConnectionCatalogEntry {
  return entryWithRoutes(entry, [route]);
}

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
  const profile = Option.getOrNull(route.profile);
  if (profile?._tag === "BearerConnectionProfile" && profile.gatewayEnvironmentId !== undefined) {
    return "gateway";
  }
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
      const tailscale =
        profile?._tag === "BearerConnectionProfile" && profile.network === "tailscale";
      if (tailscale || isTailnetHost(hostname)) return "tailnet";
      if (isSharedAddressSpaceHost(hostname)) return "vpn";
      return isPrivateNetworkHost(hostname) ? "lan" : "public";
    }
  }
}

const ROUTE_KIND_RANK: Record<ConnectionRouteKind, number> = {
  loopback: 0,
  lan: 1,
  tailnet: 2,
  vpn: 2,
  public: 3,
  ssh: 4,
  gateway: 5,
  relay: 6,
};

export function insertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
  { aheadOfSameKind = false }: { readonly aheadOfSameKind?: boolean } = {},
): ReadonlyArray<ConnectionRoute> {
  const kind = connectionRouteKind(route);
  const rank = ROUTE_KIND_RANK[kind];
  const index = routes.findIndex((existing) => {
    const existingKind = connectionRouteKind(existing);
    return ROUTE_KIND_RANK[existingKind] > rank || (aheadOfSameKind && existingKind === kind);
  });
  return index === -1
    ? [...routes, route]
    : [...routes.slice(0, index), route, ...routes.slice(index)];
}

export function upsertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
): ReadonlyArray<ConnectionRoute> {
  const id = connectionRouteId(route.target);
  return routes.some((existing) => connectionRouteId(existing.target) === id)
    ? routes.map((existing) => (connectionRouteId(existing.target) === id ? route : existing))
    : // A route paired at a new address, such as localhost beside a saved
      // 127.0.0.1, goes first among its kind so its fresh credential connects.
      insertRoute(routes, route, { aheadOfSameKind: true });
}

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

export function connectionRouteLabel(route: ConnectionRoute): string {
  switch (connectionRouteKind(route)) {
    case "relay":
      return "T3 Connect";
    case "gateway":
      return "LAN gateway";
    case "loopback":
      return "This device";
    case "lan":
      return "LAN";
    case "tailnet":
      return "Tailscale";
    case "vpn":
      return "VPN";
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

export function connectionRouteAddress(route: ConnectionRoute): string | null {
  if (route.target._tag === "SshConnectionTarget") {
    const profile = Option.getOrNull(route.profile);
    return profile?._tag === "SshConnectionProfile" ? profile.target.alias : null;
  }
  return routeHttpBaseUrl(route);
}

/** Learned routes alone must not make relay environments manually retryable. */
export const hasSavedBearerRoute = (entry: ConnectionCatalogEntry) =>
  connectionRoutes(entry).some((r) => !isLearned(r) && r.target._tag === "BearerConnectionTarget");

export function hasRelayRoute(
  entry: Pick<ConnectionCatalogEntry, "target" | "alternateRoutes">,
): boolean {
  return [entry.target, ...(entry.alternateRoutes ?? []).map((route) => route.target)].some(
    (target) => target._tag === "RelayConnectionTarget",
  );
}

export function mergeLearnedRoutes(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly activeRoute: ConnectionRoute;
  readonly reported: ReadonlyArray<ReportedEndpoint>;
  /** Plain HTTP routes are unusable from an HTTPS page (mixed content). */
  readonly allowInsecure: boolean;
}): ReadonlyArray<ConnectionRoute> | null {
  const { entry } = input;
  const active = input.activeRoute.target;
  const saved = connectionRoutes(entry);
  if (active._tag !== "RelayConnectionTarget" && active._tag !== "BearerConnectionTarget") {
    return null;
  }
  const activeProfile = Option.getOrNull(input.activeRoute.profile);
  const authorization =
    active._tag === "RelayConnectionTarget" ||
    (activeProfile?._tag === "BearerConnectionProfile" &&
      activeProfile.authorization === "t3-connect")
      ? ("t3-connect" as const)
      : undefined;
  const sharedCredential =
    authorization === undefined && active._tag === "BearerConnectionTarget"
      ? credentialConnectionId(active.connectionId)
      : undefined;
  const reported = new Map<string, URL>();
  const tailscaleOrigins = new Set<string>();
  for (const endpoint of input.reported) {
    let url: URL;
    try {
      url = new URL(endpoint.httpBaseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.protocol === "http:" && !input.allowInsecure) continue;
    // A loopback address names whichever device opens it, never the server.
    if (isLocalLoopbackHost(url.hostname)) continue;
    reported.set(url.origin, url);
    if (endpoint.kind === "tailnet") tailscaleOrigins.add(url.origin);
  }
  const normalized = (url: string) => url.replace(/\/+$/, "");
  const known = new Set(
    saved.flatMap((route) => {
      const url = routeHttpBaseUrl(route);
      return url === null || isLearned(route) ? [] : [normalized(url)];
    }),
  );
  const kept = saved.flatMap((route): ReadonlyArray<ConnectionRoute> => {
    // Gateway reverse-proxy routes are learned separately; directEndpoints never list them.
    if (routeGatewayEnvironmentId(route) !== undefined) return [route];
    const url = routeHttpBaseUrl(route);
    if (!isLearned(route)) {
      return [
        url === null || !reported.has(normalized(url))
          ? route
          : withNetwork(route, tailscaleOrigins.has(normalized(url))),
      ];
    }
    if (url === null || !reported.has(normalized(url)) || known.has(normalized(url))) return [];
    if (sendsTokenInClear(saved, route, tailscaleOrigins.has(normalized(url)))) return [];
    known.add(normalized(url));
    return [withNetwork(route, tailscaleOrigins.has(normalized(url)))];
  });
  let next: ReadonlyArray<ConnectionRoute> = kept;
  for (const url of reported.values()) {
    if (known.has(url.origin)) continue;
    if (
      url.protocol === "http:" &&
      sharedCredential !== undefined &&
      !tailscaleOrigins.has(url.origin) &&
      !tokenAllowsPlainHttp(saved, sharedCredential)
    ) {
      continue;
    }
    const httpBaseUrl = `${url.origin}/`;
    const connectionId = learnedConnectionId(
      entry.target.environmentId,
      url.origin,
      sharedCredential,
    );
    next = insertRoute(next, {
      target: new BearerConnectionTarget({
        environmentId: entry.target.environmentId,
        label: entry.target.label,
        connectionId,
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId,
          environmentId: entry.target.environmentId,
          label: entry.target.label,
          httpBaseUrl,
          wsBaseUrl: `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/`,
          learned: true,
          ...(authorization === undefined ? {} : { authorization }),
          ...(tailscaleOrigins.has(url.origin) ? { network: "tailscale" as const } : {}),
        }),
      ),
    });
  }
  const signature = (routes: ReadonlyArray<ConnectionRoute>) =>
    routes
      .map(
        (route) =>
          `${connectionRouteId(route.target)} ${routeHttpBaseUrl(route) ?? ""} ${connectionRouteKind(route)}`,
      )
      .join("\n");
  return signature(saved) === signature(next) ? null : next;
}

// A paired token goes to a plain HTTP address outside the tailnet only when
// it was paired that way, so a token paired over HTTPS, loopback, or the
// tailnet keeps to the transports it was issued for.
function tokenAllowsPlainHttp(
  routes: ReadonlyArray<ConnectionRoute>,
  credentialId: string,
): boolean {
  const credentialRoute = routes.find((route) => connectionRouteId(route.target) === credentialId);
  return (
    credentialRoute !== undefined &&
    routeHttpBaseUrl(credentialRoute)?.startsWith("http:") === true &&
    (connectionRouteKind(credentialRoute) === "lan" ||
      connectionRouteKind(credentialRoute) === "public")
  );
}

/**
 * Whether connecting over `route` would send a paired token over plain HTTP
 * that it wasn't paired over. Checked against the token the route borrows,
 * so a route learned before this rule existed is refused too.
 */
export function sendsTokenInClear(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
  tailscale?: boolean,
): boolean {
  const profile = Option.getOrNull(route.profile);
  if (profile?._tag !== "BearerConnectionProfile" || profile.authorization === "t3-connect") {
    return false;
  }
  if ((tailscale ?? profile.network === "tailscale") || !profile.httpBaseUrl.startsWith("http:")) {
    return false;
  }
  const credentialId = credentialConnectionId(connectionRouteId(route.target));
  return (
    credentialId !== connectionRouteId(route.target) && !tokenAllowsPlainHttp(routes, credentialId)
  );
}

/** Routes a connect may use: none sends a paired token over plain HTTP it wasn't paired over. */
export function usableRoutes(entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  const routes = connectionRoutes(entry);
  return routes.filter((route) => !sendsTokenInClear(routes, route));
}

export interface ReportedEndpoint {
  readonly httpBaseUrl: string;
  readonly kind?: string;
}

function withNetwork(route: ConnectionRoute, tailscale: boolean): ConnectionRoute {
  const profile = Option.getOrNull(route.profile);
  if (profile?._tag !== "BearerConnectionProfile") return route;
  if ((profile.network === "tailscale") === tailscale) return route;
  return {
    target: route.target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: profile.connectionId,
        environmentId: profile.environmentId,
        label: profile.label,
        httpBaseUrl: profile.httpBaseUrl,
        wsBaseUrl: profile.wsBaseUrl,
        ...(profile.learned === undefined ? {} : { learned: profile.learned }),
        ...(profile.authorization === undefined ? {} : { authorization: profile.authorization }),
        ...(profile.gatewayEnvironmentId === undefined
          ? {}
          : { gatewayEnvironmentId: profile.gatewayEnvironmentId }),
        ...(tailscale ? { network: "tailscale" as const } : {}),
      }),
    ),
  };
}

function learnedConnectionId(
  environmentId: string,
  origin: string,
  sharedCredential: string | undefined,
): string {
  return sharedCredential === undefined
    ? `learned:${environmentId}:${origin}`
    : `learned:${environmentId}:${origin}@${sharedCredential}`;
}

function gatewayConnectionId(
  gatewayEnvironmentId: EnvironmentId,
  peerEnvironmentId: EnvironmentId,
  sharedCredential: string | undefined,
): string {
  const base = `gateway:${gatewayEnvironmentId}:${peerEnvironmentId}`;
  return sharedCredential === undefined ? base : `${base}@${sharedCredential}`;
}

export function credentialConnectionId(connectionId: string): string {
  const at = connectionId.indexOf("@");
  return (connectionId.startsWith("learned:") || connectionId.startsWith("gateway:")) && at !== -1
    ? connectionId.slice(at + 1)
    : connectionId;
}

export function routeGatewayEnvironmentId(route: ConnectionRoute): EnvironmentId | undefined {
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" ? profile.gatewayEnvironmentId : undefined;
}

function gatewayWsBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}${url.pathname}`;
}

/**
 * Upserts reverse-proxy routes through a Connect/LAN gateway host for peers it
 * advertises that match this catalog entry. Routes drop when the host stops
 * advertising the peer. They borrow the peer's paired bearer when possible.
 * A peer paired through this gateway already has that path as its primary route.
 */
export function mergeGatewayRoutes(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly gatewayEnvironmentId: EnvironmentId;
  readonly gatewayHttpBaseUrl: string;
  readonly advertised: ReadonlyArray<LanGatewayPeerAdvertisement>;
}): ReadonlyArray<ConnectionRoute> | null {
  const { entry, gatewayEnvironmentId } = input;
  if (!URL.canParse(input.gatewayHttpBaseUrl)) return null;
  const gatewayHttpBase = input.gatewayHttpBaseUrl;
  const peerEnvironmentId = entry.target.environmentId;
  // Mixed-content pages cannot fetch an http gateway; drop those routes the same as a missing ad.
  const allowInsecure =
    typeof globalThis.location === "undefined" || globalThis.location.protocol !== "https:";
  const gatewayReachable = allowInsecure || !gatewayHttpBase.startsWith("http:");
  const advertised =
    gatewayReachable && input.advertised.some((peer) => peer.environmentId === peerEnvironmentId);
  const saved = connectionRoutes(entry);

  const routeSignature = (routes: ReadonlyArray<ConnectionRoute>) =>
    routes
      .map(
        (route) =>
          `${connectionRouteId(route.target)} ${routeHttpBaseUrl(route) ?? ""} ${connectionRouteKind(route)}`,
      )
      .join("\n");

  // Pairing through the gateway stores the hop on the primary route; do not add a learned duplicate.
  if (
    saved.some(
      (route) => routeGatewayEnvironmentId(route) === gatewayEnvironmentId && !isLearned(route),
    )
  ) {
    const withoutLearned = saved.filter(
      (route) => !(isLearned(route) && routeGatewayEnvironmentId(route) === gatewayEnvironmentId),
    );
    return routeSignature(saved) === routeSignature(withoutLearned) ? null : withoutLearned;
  }

  const sharedCredential = (() => {
    for (const route of saved) {
      if (isLearned(route) || route.target._tag !== "BearerConnectionTarget") continue;
      const profile = Option.getOrNull(route.profile);
      if (profile?._tag === "BearerConnectionProfile" && profile.authorization === "t3-connect") {
        continue;
      }
      return credentialConnectionId(connectionRouteId(route.target));
    }
    return undefined;
  })();

  // Without a borrowed bearer the gateway route cannot authenticate (pair on LAN or through the gateway).
  if (sharedCredential === undefined) {
    const withoutGateway = saved.filter(
      (route) => routeGatewayEnvironmentId(route) !== gatewayEnvironmentId,
    );
    return routeSignature(saved) === routeSignature(withoutGateway) ? null : withoutGateway;
  }

  // The id names the credential, so pairing or forgetting one retires the route built on the old id.
  const connectionId = gatewayConnectionId(
    gatewayEnvironmentId,
    peerEnvironmentId,
    sharedCredential,
  );
  const kept = saved.filter(
    (route) =>
      routeGatewayEnvironmentId(route) !== gatewayEnvironmentId ||
      (advertised && connectionRouteId(route.target) === connectionId),
  );

  let next: ReadonlyArray<ConnectionRoute> = kept;
  if (advertised) {
    const httpBaseUrl = gatewayPeerHttpBaseUrl(gatewayHttpBase, peerEnvironmentId);
    const existing = kept.find((route) => connectionRouteId(route.target) === connectionId);
    const route: ConnectionRoute = {
      target: new BearerConnectionTarget({
        environmentId: peerEnvironmentId,
        label: entry.target.label,
        connectionId,
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId,
          environmentId: peerEnvironmentId,
          label: entry.target.label,
          httpBaseUrl,
          wsBaseUrl: gatewayWsBaseUrl(httpBaseUrl),
          learned: true,
          gatewayEnvironmentId,
        }),
      ),
    };
    next =
      existing === undefined
        ? insertRoute(kept, route)
        : kept.map((candidate) =>
            connectionRouteId(candidate.target) === connectionId ? route : candidate,
          );
  }

  return routeSignature(saved) === routeSignature(next) ? null : next;
}

export function isLearned(route: ConnectionRoute): boolean {
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" && profile.learned === true;
}

const GATEWAY_PEER_UPSTREAM_KIND_ORDER = ["lan", "tailnet", "loopback"] as const;

/**
 * Private address a LAN gateway host can probe and proxy. Prefers LAN, then
 * Tailscale, then loopback. Gateway/relay/public/ssh/vpn routes are never used.
 */
export function gatewayPeerUpstreamUrl(entry: ConnectionCatalogEntry): string | null {
  const byKind = new Map<ConnectionRouteKind, string>();
  for (const route of connectionRoutes(entry)) {
    const kind = connectionRouteKind(route);
    if (kind !== "lan" && kind !== "tailnet" && kind !== "loopback") continue;
    if (byKind.has(kind)) continue;
    const httpBaseUrl = routeHttpBaseUrl(route);
    if (httpBaseUrl === null) continue;
    try {
      byKind.set(kind, new URL(httpBaseUrl).origin);
    } catch {
      continue;
    }
  }
  for (const kind of GATEWAY_PEER_UPSTREAM_KIND_ORDER) {
    const url = byKind.get(kind);
    if (url !== undefined) return url;
  }
  return null;
}

/** Enabled catalog peers (other than the gateway) that have a private upstream URL. */
export function desiredGatewayPeers(
  catalog: Iterable<ConnectionCatalogEntry>,
  gatewayEnvironmentId: EnvironmentId,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly url: string }> {
  const peers: Array<{ readonly environmentId: EnvironmentId; readonly url: string }> = [];
  for (const entry of catalog) {
    if (!entry.enabled || entry.unsupportedReason !== undefined) continue;
    const environmentId = entry.target.environmentId;
    if (environmentId === gatewayEnvironmentId) continue;
    const url = gatewayPeerUpstreamUrl(entry);
    if (url === null) continue;
    peers.push({ environmentId, url });
  }
  return peers;
}

/** Peers the catalog already reaches through this gateway (paired or learned); never unregister them. */
export function retainedGatewayPeerIds(
  catalog: Iterable<ConnectionCatalogEntry>,
  gatewayEnvironmentId: EnvironmentId,
): ReadonlySet<EnvironmentId> {
  const ids = new Set<EnvironmentId>();
  for (const entry of catalog) {
    const environmentId = entry.target.environmentId;
    if (environmentId === gatewayEnvironmentId) continue;
    if (
      connectionRoutes(entry).some(
        (route) => routeGatewayEnvironmentId(route) === gatewayEnvironmentId,
      )
    ) {
      ids.add(environmentId);
    }
  }
  return ids;
}

export function planGatewayPeerReconcile(input: {
  readonly desired: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly url: string }>;
  readonly listed: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly httpBaseUrl: string;
  }>;
  /** Peers the catalog reaches through this gateway; never unregister them. */
  readonly retain?: ReadonlySet<EnvironmentId>;
  /**
   * Peers this client last registered from its own catalog. Without this, a second client
   * with an empty catalog would unregister peers still needed by others.
   */
  readonly previousDesired?: ReadonlySet<EnvironmentId>;
}): {
  readonly add: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly url: string }>;
  readonly remove: ReadonlyArray<EnvironmentId>;
} {
  const desiredById = new Map(input.desired.map((peer) => [peer.environmentId, peer.url]));
  const add: Array<{ readonly environmentId: EnvironmentId; readonly url: string }> = [];
  for (const [environmentId, url] of desiredById) {
    const listed = input.listed.find((peer) => peer.environmentId === environmentId);
    let listedOrigin: string | undefined;
    try {
      listedOrigin = listed === undefined ? undefined : new URL(listed.httpBaseUrl).origin;
    } catch {
      listedOrigin = undefined;
    }
    if (listedOrigin !== url) add.push({ environmentId, url });
  }
  const remove = input.listed
    .filter((peer) => {
      if (desiredById.has(peer.environmentId)) return false;
      if (input.retain?.has(peer.environmentId) === true) return false;
      // Unknown ownership: only remove peers this client previously desired.
      if (input.previousDesired !== undefined && !input.previousDesired.has(peer.environmentId)) {
        return false;
      }
      return true;
    })
    .map((peer) => peer.environmentId);
  return { add, remove };
}

/**
 * A learned route borrows the credential of the route it was learned over, so
 * it cannot outlive that route: removing T3 Connect also removes routes learned
 * through it, and removing a paired address removes routes that borrow its
 * token.
 */
export function routesAfterRemoving(
  routes: ReadonlyArray<ConnectionRoute>,
  removedId: string,
): ReadonlyArray<ConnectionRoute> {
  const removed = routes.find((route) => connectionRouteId(route.target) === removedId);
  if (removed === undefined) return routes;
  return routes.filter((route) => {
    if (route === removed) return false;
    if (!isLearned(route)) return true;
    const profile = Option.getOrNull(route.profile);
    if (profile?._tag === "BearerConnectionProfile" && profile.authorization === "t3-connect") {
      return removed.target._tag !== "RelayConnectionTarget";
    }
    return credentialConnectionId(connectionRouteId(route.target)) !== removedId;
  });
}

/**
 * A dragged route order shows until the saved routes catch up with it. It is
 * stale, and returns null, once the saved order matches it or the saved routes
 * are no longer the same set: kept any longer, it would hide a route added
 * later whenever the count happened to match again.
 */
export function pendingRouteOrder(
  pending: ReadonlyArray<string> | null,
  savedIds: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
  if (pending === null || pending.length !== savedIds.length) return null;
  const saved = new Set(savedIds);
  if (!pending.every((id) => saved.has(id))) return null;
  return pending.some((id, index) => id !== savedIds[index]) ? pending : null;
}

export function removedWithRelay(entry: ConnectionCatalogEntry): boolean {
  return routesAfterRemoving(connectionRoutes(entry), RELAY_ROUTE_ID).length === 0;
}

export function sshTargetKey(target: DesktopSshEnvironmentTarget): string {
  return JSON.stringify([target.alias, target.hostname, target.username, target.port]);
}
