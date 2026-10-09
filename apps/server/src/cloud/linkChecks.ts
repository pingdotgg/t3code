/**
 * Pure checks behind T3 Connect link proofs and relay requests: which local
 * origin a link may point at, and which scopes and lifetimes a proof claims and
 * accepts.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no timingSafeEqual.
import * as NodeCrypto from "node:crypto";
import type {
  RelayEnvironmentLinkProofPayload,
  RelayLinkProofRequest,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import type { HttpServerRequest } from "effect/http";

const CLOUD_PROOF_MAX_LIFETIME_SECONDS = 5 * 60;
const CLOUD_PROOF_CLOCK_SKEW_SECONDS = 60;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

export function requestAbsoluteUrl(request: HttpServerRequest.HttpServerRequest): string | null {
  try {
    return new URL(request.originalUrl).href;
  } catch {
    const host = firstForwardedHeaderValue(request.headers.host) ?? "127.0.0.1";
    try {
      return new URL(request.originalUrl, `http://${host}`).href;
    } catch {
      return null;
    }
  }
}

export function hasForwardedAuthorityHeaders(
  request: HttpServerRequest.HttpServerRequest,
): boolean {
  return (
    firstForwardedHeaderValue(request.headers["x-forwarded-host"]) !== undefined ||
    firstForwardedHeaderValue(request.headers["x-forwarded-proto"]) !== undefined ||
    firstForwardedHeaderValue(request.headers.forwarded) !== undefined
  );
}

/** A verified gateway reaches this listener; public forwarded authority is
 * retained for MCP, but never decides which local port a proof can authorize. */
export function linkProofRequestUrl(
  request: HttpServerRequest.HttpServerRequest,
  proxyToken: string | undefined,
  listeningPort: number | undefined,
): string | null {
  if (!hasForwardedAuthorityHeaders(request)) return requestAbsoluteUrl(request);
  const credential = request.headers["x-t3code-proxy-token"];
  const host = request.headers["x-forwarded-host"];
  const protocol = request.headers["x-forwarded-proto"];
  if (
    !proxyToken ||
    proxyToken.length < 32 ||
    !credential ||
    !host ||
    (protocol !== "https" && protocol !== "http") ||
    !Number.isInteger(listeningPort) ||
    listeningPort === undefined ||
    listeningPort < 1 ||
    listeningPort > 65535 ||
    request.headers.forwarded !== undefined
  )
    return null;
  try {
    const authority = new URL(`${protocol}://${host}`);
    if (authority.host !== host || authority.username || authority.password) return null;
  } catch {
    return null;
  }
  const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();
  if (!NodeCrypto.timingSafeEqual(hash(proxyToken), hash(credential))) return null;
  return `http://127.0.0.1:${listeningPort}`;
}

function endpointRequestPort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

export function parseManagedEndpointLocalOrigin(localOrigin: string) {
  const url = new URL(localOrigin);
  if (
    localOrigin !== localOrigin.trim() ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    localOrigin.includes("?") ||
    localOrigin.includes("#")
  ) {
    throw new Error("Invalid local origin");
  }
  const wsUrl = new URL(url.origin);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    httpBaseUrl: url.origin,
    wsBaseUrl: wsUrl.origin,
    origin: {
      localHttpHost: url.hostname,
      localHttpPort: endpointRequestPort(url),
    } satisfies RelayManagedEndpointOrigin,
  };
}

export function isAllowedEndpointOrigin(input: {
  readonly origin: RelayManagedEndpointOrigin;
  readonly requestUrl: string;
}): boolean {
  if (!isLoopbackHostname(input.origin.localHttpHost)) {
    return false;
  }

  const url = new URL(input.requestUrl);
  if (!isLoopbackHostname(url.hostname)) {
    return false;
  }

  return input.origin.localHttpPort === endpointRequestPort(url);
}

// A managed (Cloudflare tunnel) endpoint is provisioned by the relay and must
// point at a loopback origin. A manual endpoint is reached out of band (e.g.
// Tailscale) or not advertised at all for publish-only links, so it is not
// tied to the managed-tunnel scope.
export function isSupportedLinkProviderKind(request: RelayLinkProofRequest): boolean {
  return (
    request.endpoint.providerKind === "cloudflare_tunnel" ||
    request.endpoint.providerKind === "manual"
  );
}

export function linkProofScopes(
  request: RelayLinkProofRequest,
): RelayEnvironmentLinkProofPayload["scopes"] {
  return request.endpoint.providerKind === "cloudflare_tunnel"
    ? ["agent_activity_notifications", "managed_tunnels"]
    : ["agent_activity_notifications"];
}

export function hasExactScope(input: {
  readonly scopes: ReadonlyArray<string>;
  readonly expected: string;
}): boolean {
  return input.scopes.length === 1 && input.scopes[0] === input.expected;
}

export function hasBoundedCloudProofLifetime(input: {
  readonly iat: number;
  readonly exp: number;
  readonly nowSeconds: number;
}): boolean {
  return (
    input.exp > input.iat &&
    input.exp - input.iat <= CLOUD_PROOF_MAX_LIFETIME_SECONDS &&
    input.iat <= input.nowSeconds + CLOUD_PROOF_CLOCK_SKEW_SECONDS
  );
}

export function managedEndpointRuntimeConfigsMatch(
  left: RelayManagedEndpointRuntimeConfig,
  right: RelayManagedEndpointRuntimeConfig,
): boolean {
  return (
    left.providerKind === right.providerKind &&
    left.connectorToken === right.connectorToken &&
    left.tunnelId === right.tunnelId &&
    left.tunnelName === right.tunnelName
  );
}
