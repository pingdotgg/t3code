import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { openSandboxPreview } from "~/connection/cloudSandbox";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { readPreparedConnection } from "~/state/session";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export { normalizeHostname, isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

const readEnvironmentUrl = (environmentId: EnvironmentId): URL => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return new URL(connection.httpBaseUrl);
};

const resolveEnvironmentPortTarget = (
  environmentId: EnvironmentId,
  target: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  environmentUrl: URL,
  requestedUrl?: string,
  sourceUrl?: URL,
): PreviewUrlResolution => {
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new Error(
      "External access to this environment’s loopback service is unavailable through its current connection.",
    );
  }
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  // localhost lets Chromium reach loopback servers bound to either IPv4 or IPv6.
  const resolvedHost = isLocalLoopbackHost(normalizedEnvironmentHost)
    ? "localhost"
    : normalizedEnvironmentHost.includes(":")
      ? `[${normalizedEnvironmentHost}]`
      : normalizedEnvironmentHost;
  const resolved = sourceUrl
    ? new URL(sourceUrl)
    : new URL(path, `${protocol}://${resolvedHost}:${target.port}`);
  if (sourceUrl) {
    resolved.hostname = resolvedHost;
    resolved.port = String(target.port);
  }
  return {
    requestedUrl: requestedUrl ?? `${protocol}://localhost:${target.port}${path}`,
    resolvedUrl: resolved.toString(),
    resolutionKind: isLocalLoopbackHost(normalizedEnvironmentHost)
      ? "direct"
      : "direct-private-network",
    environmentId,
  };
};

// Desktop renders primary and WSL tabs locally; loopback servers require localhost even for LAN backends.
const reachesEnvironmentLoopback = (target: ConnectionTarget): boolean =>
  isElectron &&
  (target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target));

export function resolveDiscoveredServerUrl(environmentId: EnvironmentId, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    // A sandbox's loopback exists only inside the sandbox, so its own URL is the one to load.
    if (readPreparedConnection(environmentId)?.target._tag === "CloudSandboxConnectionTarget")
      return normalizedUrl;
    const parsed = new URL(normalizedUrl);
    if (!isLoopbackHost(parsed.hostname)) return normalizedUrl;
    const target = readPreparedConnection(environmentId)?.target;
    if (target && reachesEnvironmentLoopback(target)) return normalizedUrl;
    return resolveEnvironmentPortTarget(
      environmentId,
      {
        kind: "environment-port",
        port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
        protocol: parsed.protocol === "https:" ? "https" : "http",
        path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
      },
      readEnvironmentUrl(environmentId),
      rawUrl,
      parsed,
    ).resolvedUrl;
  } catch {
    return rawUrl;
  }
}

// Hosted sandbox previews are minted through the sandbox's controller. Each
// minted preview URL carries a provider-issued path prefix and its own query
// parameters, so the base of every alias is remembered to map those back to
// the sandbox loopback URLs they expose.
interface SandboxedPreviewBase {
  readonly origin: string;
  readonly pathPrefix: string;
  /** The sandbox loopback origin, e.g. `http://localhost:3000`. */
  readonly sandboxOrigin: string;
  readonly providerParams: ReadonlyArray<readonly [string, string]>;
}

const previewOrigins = new Map<string, Map<string, SandboxedPreviewBase>>();

const isSandboxEnvironment = (environmentId: EnvironmentId): boolean =>
  readPreparedConnection(environmentId)?.target._tag === "CloudSandboxConnectionTarget";

const sandboxAliasBases = (environmentId: EnvironmentId): Map<string, SandboxedPreviewBase> => {
  const existing = previewOrigins.get(environmentId);
  if (existing !== undefined) return existing;
  const created = new Map<string, SandboxedPreviewBase>();
  previewOrigins.set(environmentId, created);
  return created;
};

const rememberAliasBase = (environmentId: EnvironmentId, sandboxUrl: URL, aliasUrl: URL) => {
  const aliasPathname = aliasUrl.pathname;
  const sandboxPathname = sandboxUrl.pathname;
  if (aliasPathname.length < sandboxPathname.length || !aliasPathname.endsWith(sandboxPathname))
    return;
  const providerParams: Array<readonly [string, string]> = [];
  for (const [key, value] of aliasUrl.searchParams) {
    if (!sandboxUrl.searchParams.getAll(key).includes(value)) providerParams.push([key, value]);
  }
  const origin = `${aliasUrl.protocol}//${aliasUrl.host}`;
  sandboxAliasBases(environmentId).set(`${origin}${aliasPathname}`, {
    origin,
    pathPrefix: aliasPathname.slice(0, aliasPathname.length - sandboxPathname.length),
    sandboxOrigin: `${sandboxUrl.protocol}//${sandboxUrl.host}`,
    providerParams,
  });
};

const aliasToServerOwnedUrl = (environmentId: EnvironmentId, aliasUrl: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(aliasUrl);
  } catch {
    return null;
  }
  for (const known of sandboxAliasBases(environmentId).values()) {
    if (`${parsed.protocol}//${parsed.host}` !== known.origin) continue;
    if (!parsed.pathname.startsWith(known.pathPrefix)) continue;
    const restored = new URL(
      `${known.sandboxOrigin}${parsed.pathname.slice(known.pathPrefix.length)}`,
    );
    const pairs = [...parsed.searchParams.entries()];
    for (const [key, value] of known.providerParams) {
      const index = pairs.findIndex(
        ([pairKey, pairValue]) => pairKey === key && pairValue === value,
      );
      if (index >= 0) pairs.splice(index, 1);
    }
    restored.search = new URLSearchParams(pairs).toString();
    restored.hash = parsed.hash;
    return restored.toString();
  }
  return null;
};

/**
 * The URL the sandbox environment itself would load: its loopback form for
 * provider-hosted preview aliases, and anything else unchanged.
 */
export function resolveServerOwnedUrl(environmentId: EnvironmentId, rawUrl: string): string {
  if (!isSandboxEnvironment(environmentId)) return rawUrl;
  return aliasToServerOwnedUrl(environmentId, rawUrl) ?? rawUrl;
}

/**
 * The URL this client should load for a sandbox-owned service. Aliases are
 * re-minted on every resolve so hosted previews reconnect instead of failing
 * after their session expires; non-loopback addresses load directly.
 */
export async function resolveExternalServerUrl(
  environmentId: EnvironmentId,
  rawUrl: string,
): Promise<string> {
  if (!isSandboxEnvironment(environmentId))
    return resolveDiscoveredServerUrl(environmentId, normalizePreviewUrl(rawUrl));
  const serverOwned = aliasToServerOwnedUrl(environmentId, rawUrl) ?? rawUrl;
  const parsed = new URL(serverOwned);
  if (!isLoopbackHost(parsed.hostname)) return serverOwned;
  const result = await openSandboxPreview.run(appAtomRegistry, {
    environmentId,
    url: serverOwned,
    local: isElectron && appAtomRegistry.get(primaryEnvironmentIdAtom) !== null,
  });
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) return serverOwned;
    const failure = squashAtomCommandFailure(result);
    throw new Error(
      failure instanceof Error ? failure.message : "This sandbox preview could not be hosted.",
    );
  }
  rememberAliasBase(environmentId, parsed, new URL(result.value.url));
  return result.value.url;
}

export async function releaseExternalServerUrl(
  environmentId: EnvironmentId,
  url: string,
): Promise<void> {
  if (!isSandboxEnvironment(environmentId)) return;
  if (aliasToServerOwnedUrl(environmentId, url) === null) return;
  // The server closes the forward it opened, which is keyed by the forwarded URL.
  await openSandboxPreview
    .run(appAtomRegistry, {
      environmentId,
      url,
      local: isElectron && appAtomRegistry.get(primaryEnvironmentIdAtom) !== null,
      close: true,
    })
    .catch(() => undefined);
  const alias = new URL(url);
  if (alias.hostname === "127.0.0.1")
    sandboxAliasBases(environmentId).delete(`${alias.protocol}//${alias.host}${alias.pathname}`);
}
