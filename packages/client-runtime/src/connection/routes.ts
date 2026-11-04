import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { BearerConnectionTarget, type ConnectionTarget } from "./model.ts";
import { parseLanDiscoveryCandidate } from "./lanDiscoveryProof.ts";

export type ConnectionRouteKind =
  | "relay"
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
  return [
    {
      target: entry.target,
      profile: entry.profile,
      ...(entry.discovery ? { discovery: true as const } : {}),
    },
    ...(entry.alternateRoutes ?? []),
  ];
}

export function entryWithRoutes(
  entry: ConnectionCatalogEntry,
  routes: ReadonlyArray<ConnectionRoute>,
): ConnectionCatalogEntry {
  const [first, ...rest] = routes;
  if (first === undefined) {
    throw new Error("A saved environment needs at least one route.");
  }
  const { alternateRoutes: _previous, discovery: _discovery, ...base } = entry;
  return {
    ...base,
    target: first.target,
    profile: first.profile,
    ...(first.discovery ? { discovery: true as const } : {}),
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
      const profile = Option.getOrNull(route.profile);
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
  relay: 5,
};

export function isLanDpopRoute(route: ConnectionRoute): boolean {
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" && profile.lanDpop === true;
}

const CLEARTEXT_LAN_FALLBACK_RANK = ROUTE_KIND_RANK.relay + 1;

function isCleartextLanFallback(route: ConnectionRoute): boolean {
  const profile = Option.getOrNull(route.profile);
  if (
    profile?._tag !== "BearerConnectionProfile" ||
    !profile.httpBaseUrl.startsWith("http:") ||
    connectionRouteKind(route) !== "lan"
  ) {
    return false;
  }
  return profile.lanDpop === true || profile.authorization === "t3-connect";
}

const routeRank = (route: ConnectionRoute) =>
  isCleartextLanFallback(route)
    ? CLEARTEXT_LAN_FALLBACK_RANK
    : ROUTE_KIND_RANK[connectionRouteKind(route)];

export function insertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
  { aheadOfSameKind = false }: { readonly aheadOfSameKind?: boolean } = {},
): ReadonlyArray<ConnectionRoute> {
  const kind = connectionRouteKind(route);
  const rank = routeRank(route);
  const index = routes.findIndex((existing) => {
    return (
      routeRank(existing) > rank || (aheadOfSameKind && connectionRouteKind(existing) === kind)
    );
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
  readonly lanCredential?: boolean;
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
  const savedParentId = savedLanCredentialParentId(saved);
  const activeParentId =
    sharedCredential !== undefined && !tokenAllowsPlainHttp(saved, sharedCredential)
      ? sharedCredential
      : null;
  const lanParentId = activeParentId ?? savedParentId;
  const canUseLanCredential =
    lanParentId !== null && (input.lanCredential === true || isLanDpopRoute(input.activeRoute));
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
    const url = routeHttpBaseUrl(route);
    if (!isLearned(route)) {
      return [
        url === null || !reported.has(normalized(url))
          ? route
          : withNetwork(route, tailscaleOrigins.has(normalized(url))),
      ];
    }
    if (url === null || !reported.has(normalized(url)) || known.has(normalized(url))) return [];
    if (
      canUseLanCredential &&
      lanParentId !== null &&
      replacesWithLanCredential(route, url, lanParentId, tailscaleOrigins)
    ) {
      return [];
    }
    if (sendsTokenInClear(saved, route, tailscaleOrigins.has(normalized(url)))) return [];
    known.add(normalized(url));
    return [withNetwork(route, tailscaleOrigins.has(normalized(url)))];
  });
  let next: ReadonlyArray<ConnectionRoute> = kept;
  for (const url of reported.values()) {
    if (known.has(url.origin)) continue;
    const needsLanCredential =
      url.protocol === "http:" &&
      sharedCredential !== undefined &&
      !tailscaleOrigins.has(url.origin) &&
      !tokenAllowsPlainHttp(saved, sharedCredential);
    if (needsLanCredential && (!canUseLanCredential || !lanCredentialCanProve(url))) continue;
    const lanDpop = needsLanCredential && canUseLanCredential && lanParentId !== null;
    const httpBaseUrl = `${url.origin}/`;
    const connectionId = learnedConnectionId(
      entry.target.environmentId,
      url.origin,
      lanDpop ? lanParentId : sharedCredential,
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
          ...(lanDpop || authorization === undefined ? {} : { authorization }),
          ...(lanDpop ? { lanDpop: true as const } : {}),
          ...(tailscaleOrigins.has(url.origin) ? { network: "tailscale" as const } : {}),
        }),
      ),
    });
  }
  const signature = (routes: ReadonlyArray<ConnectionRoute>) =>
    routes
      .map((route) => {
        const profile = Option.getOrNull(route.profile);
        const bearer = profile?._tag === "BearerConnectionProfile" ? profile : null;
        return `${connectionRouteId(route.target)} ${routeHttpBaseUrl(route) ?? ""} ${connectionRouteKind(route)} ${bearer?.lanDpop === true ? "lanDpop" : ""} ${bearer?.authorization ?? ""}`;
      })
      .join("\n");
  return signature(saved) === signature(next) ? null : next;
}

// The proof binds the socket's IPv4 address, so a route with a host name can never verify.
const lanCredentialCanProve = (url: URL) => parseLanDiscoveryCandidate(url.href) !== null;

function replacesWithLanCredential(
  route: ConnectionRoute,
  httpBaseUrl: string,
  parentId: string,
  tailscaleOrigins: ReadonlySet<string>,
): boolean {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || tailscaleOrigins.has(url.origin) || !lanCredentialCanProve(url)) {
    return false;
  }
  const profile = Option.getOrNull(route.profile);
  return !(
    connectionRouteId(route.target) ===
      learnedConnectionId(route.target.environmentId, url.origin, parentId) &&
    profile?._tag === "BearerConnectionProfile" &&
    profile.lanDpop === true &&
    profile.authorization === undefined
  );
}

function savedLanCredentialParentId(routes: ReadonlyArray<ConnectionRoute>): string | null {
  for (const route of routes) {
    const profile = Option.getOrNull(route.profile);
    if (
      route.target._tag !== "BearerConnectionTarget" ||
      profile?._tag !== "BearerConnectionProfile" ||
      profile.learned === true ||
      profile.authorization === "t3-connect" ||
      profile.lanDpop === true
    ) {
      continue;
    }
    const parentId = credentialConnectionId(route.target.connectionId);
    if (!tokenAllowsPlainHttp(routes, parentId)) return parentId;
  }
  return null;
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
  if (
    profile?._tag !== "BearerConnectionProfile" ||
    profile.authorization === "t3-connect" ||
    profile.lanDpop === true
  ) {
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

export function lanCredentialParentId(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly activeRoute: ConnectionRoute;
  readonly reported: ReadonlyArray<ReportedEndpoint>;
}): string | null {
  const { target } = input.activeRoute;
  const profile = Option.getOrNull(input.activeRoute.profile);
  if (
    target._tag !== "BearerConnectionTarget" ||
    profile?._tag !== "BearerConnectionProfile" ||
    profile.authorization === "t3-connect" ||
    profile.lanDpop === true
  ) {
    return null;
  }
  const saved = connectionRoutes(input.entry);
  const parentId = credentialConnectionId(target.connectionId);
  if (tokenAllowsPlainHttp(saved, parentId)) return null;
  const known = new Set(
    saved.flatMap((route) => {
      if (isLearned(route)) return [];
      const httpBaseUrl = routeHttpBaseUrl(route);
      if (httpBaseUrl === null) return [];
      try {
        return [new URL(httpBaseUrl).origin];
      } catch {
        return [];
      }
    }),
  );
  return input.reported.some((endpoint) => acceptedLanOrigin(endpoint, known) !== null)
    ? parentId
    : null;
}

function acceptedLanOrigin(endpoint: ReportedEndpoint, known: ReadonlySet<string>): string | null {
  if (endpoint.kind === "tailnet") return null;
  let url: URL;
  try {
    url = new URL(endpoint.httpBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || isLocalLoopbackHost(url.hostname) || known.has(url.origin)) {
    return null;
  }
  return url.origin;
}

export function lanCredentialConnectionId(parentId: string): string {
  return `lan-credential:${parentId}`;
}

export function discoveredRoutes(
  entry: ConnectionCatalogEntry,
  candidates: ReadonlyArray<string>,
): ReadonlyArray<ConnectionRoute> {
  const saved = connectionRoutes(entry);
  const paired = saved.find((route) => {
    const profile = Option.getOrNull(route.profile);
    return (
      route.target._tag === "BearerConnectionTarget" &&
      profile?._tag === "BearerConnectionProfile" &&
      !profile.learned &&
      profile.authorization !== "t3-connect" &&
      profile.httpBaseUrl.startsWith("http:") &&
      ["lan", "public"].includes(connectionRouteKind(route))
    );
  });
  const parentId = savedLanCredentialParentId(saved);
  const parentRoute =
    parentId === null
      ? undefined
      : saved.find((route) => connectionRouteId(route.target) === parentId);
  const learnedOverConnect = saved.some(
    (route) => isCleartextLanFallback(route) && !isLanDpopRoute(route),
  );
  const source =
    paired ?? saved.find(isLanDpopRoute) ?? (learnedOverConnect ? parentRoute : undefined);
  if (!entry.enabled || !source || source.target._tag !== "BearerConnectionTarget") return [];
  const known = new Set(
    saved
      .map(routeHttpBaseUrl)
      .filter((url): url is string => url !== null)
      .flatMap((url) => {
        try {
          return [new URL(url).origin];
        } catch {
          return [];
        }
      }),
  );
  const result: ConnectionRoute[] = [];
  for (const candidate of candidates.slice(0, 32)) {
    const url = parseLanDiscoveryCandidate(candidate);
    if (!url || known.has(url.origin)) continue;
    known.add(url.origin);
    const connectionId = learnedConnectionId(
      entry.target.environmentId,
      url.origin,
      credentialConnectionId(source.target.connectionId),
    );
    const route: ConnectionRoute = {
      discovery: true,
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
          httpBaseUrl: `${url.origin}/`,
          wsBaseUrl: `ws://${url.host}/`,
          learned: true,
          ...(paired === undefined ? { lanDpop: true as const } : {}),
        }),
      ),
    };
    if (!sendsTokenInClear(saved, route)) result.push(route);
  }
  return result;
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
        ...(profile.lanDpop === undefined ? {} : { lanDpop: profile.lanDpop }),
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

export function credentialConnectionId(connectionId: string): string {
  const at = connectionId.indexOf("@");
  return connectionId.startsWith("learned:") && at !== -1
    ? connectionId.slice(at + 1)
    : connectionId;
}

export function isLearned(route: ConnectionRoute): boolean {
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" && profile.learned === true;
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
