import type { EnvironmentSocket, OpenEnvironmentSocket } from "../state/environmentSocket.ts";

export interface DeviceHubAccess {
  readonly httpBase: string;
  readonly wsBase: string;
  readonly query: Readonly<Record<string, string>>;
  readonly credentials: boolean;
  /** Set when the ticket is bound to the device key: each socket proves the key itself. */
  readonly openSocket?: OpenEnvironmentSocket;
  /**
   * Single-use upgrade proofs by socket path, for a context that gets this access as JSON and so
   * cannot sign (a mobile WebView). A reconnect after its proof is spent is refused as unauthorized.
   */
  readonly socketProofs?: Readonly<Record<string, string>>;
}

/** The hub sockets a device stream opens: serve-sim input, and serve-emu video and input. */
export const DEVICE_STREAM_SOCKET_PATHS = [
  "/vendor/serve-sim/helper/ws",
  "/vendor/serve-emu/ws",
] as const;

export const withDeviceHubQuery = (url: string, access: DeviceHubAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};

/** Opens a hub or stream socket the way `access` authenticates it. */
export const openDeviceHubSocket = (access: DeviceHubAccess, url: string): EnvironmentSocket => {
  if (access.openSocket) return access.openSocket(url);
  const target = new URL(url);
  const proof = access.socketProofs?.[target.pathname];
  if (proof === undefined) return new WebSocket(url);
  target.searchParams.set("dpop", proof);
  return new WebSocket(target.toString());
};
