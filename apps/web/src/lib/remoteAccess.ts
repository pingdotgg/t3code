import type { ServerRemoteAccess } from "@t3tools/contracts";
import { buildRemoteAppConnectionUrl } from "@t3tools/shared/remote";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const UNSPECIFIED_HOSTS = new Set(["0.0.0.0", "::"]);

function normalizeHost(host: string | null | undefined): string | null {
  const normalized = host?.trim() ?? "";
  if (normalized.length === 0) {
    return null;
  }

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1).toLowerCase();
  }

  return normalized.toLowerCase();
}

function isReachableRemoteHost(host: string | null | undefined): host is string {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) {
    return false;
  }

  return !LOOPBACK_HOSTS.has(normalizedHost) && !UNSPECIFIED_HOSTS.has(normalizedHost);
}

function formatHostForUrl(host: string): string {
  const trimmedHost = host.trim();
  if (trimmedHost.includes(":") && !trimmedHost.startsWith("[") && !trimmedHost.endsWith("]")) {
    return `[${trimmedHost}]`;
  }
  return trimmedHost;
}

function buildRemoteHttpUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`;
}

export interface RemoteConnectionDetails {
  readonly listeningUrl: string | null;
  readonly connectUrl: string | null;
  readonly appConnectionUrl: string | null;
}

export function resolveRemoteConnectionDetails(
  remote: ServerRemoteAccess | null,
  browserHostname?: string,
): RemoteConnectionDetails {
  if (!remote?.enabled) {
    return {
      listeningUrl: null,
      connectUrl: null,
      appConnectionUrl: null,
    };
  }

  const listeningUrl = remote.host ? buildRemoteHttpUrl(remote.host, remote.port) : null;
  const connectHost = [browserHostname, remote.host].find(isReachableRemoteHost) ?? null;
  const connectUrl = connectHost ? buildRemoteHttpUrl(connectHost, remote.port) : null;

  return {
    listeningUrl,
    connectUrl,
    appConnectionUrl: connectUrl
      ? buildRemoteAppConnectionUrl({
          serverUrl: connectUrl,
          authToken: remote.authToken ?? null,
        })
      : null,
  };
}
