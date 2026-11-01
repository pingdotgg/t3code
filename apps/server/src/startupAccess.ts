import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  isPrivateNetworkHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import { QrCode } from "@t3tools/shared/qrCode";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerConfig from "./config.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";

export interface HeadlessServeAccessInfo {
  readonly connectionString: string;
  readonly token: string;
  readonly pairingUrl: string;
}

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
};

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

/**
 * Container and VM networks (Docker, libvirt, VMware, VirtualBox, Hyper-V, and
 * macOS's `bridge100`+) have private addresses only this machine reaches. A
 * host bridge such as `br0` or Proxmox's `vmbr0` carries the LAN address, so
 * it stays listed.
 */
export const VIRTUAL_INTERFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|vEthernet|podman|cni|flannel|cali|lxcbr|lxdbr|bridge[1-9]\d\d)/;

/**
 * Loopback or private-range IPv4 (LAN, tailnet, CGNAT), not link-local, in
 * plain or IPv4-mapped IPv6 form.
 */
export const isPrivateNetworkAddress = (address: string): boolean => {
  const ipv4 = address.replace(/^::ffff:/i, "");
  return NodeNet.isIPv4(ipv4) && !ipv4.startsWith("169.254.") && isPrivateNetworkHost(ipv4);
};

/**
 * A private-network listener binds every interface but serves only
 * connections that stay on loopback, a LAN, or the tailnet. Both ends must be
 * private: a cloud VM or a router port forward hands public clients to a
 * private local address.
 */
export const acceptsPrivateNetworkConnection = (socket: {
  readonly localAddress?: string | undefined;
  readonly remoteAddress?: string | undefined;
}): boolean =>
  [socket.localAddress, socket.remoteAddress].every(
    (address) => address !== undefined && isPrivateNetworkAddress(address),
  );

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

/** The IPv4 address of a plain or IPv4-mapped IPv6 address, or null. */
const plainIpv4 = (address: string): string | null => {
  const ipv4 = address.replace(/^::ffff:/i, "");
  return NodeNet.isIPv4(ipv4) ? ipv4 : null;
};

const isTailnetIpv4Address = (address: string): boolean => {
  const ipv4 = plainIpv4(address);
  return ipv4 !== null && isTailscaleIpv4Address(ipv4);
};

const isLoopbackAddress = (address: string): boolean =>
  address === "::1" || plainIpv4(address)?.startsWith("127.") === true;

// macOS utun names need Tailscale's IPv6 range to identify them; WARP shares its IPv4 range.
export const isTailscaleInterface = (
  name: string,
  entries: ReadonlyArray<{ readonly family: string | number; readonly address: string }>,
): boolean =>
  /^tailscale/i.test(name) ||
  entries.some((entry) => isIpv6Family(entry.family) && isTailnetHost(entry.address));

const tailscaleInterfaceIpv4Addresses = (interfaces: NetworkInterfacesMap): ReadonlySet<string> =>
  new Set(
    Object.entries(interfaces).flatMap(([name, entries = []]) =>
      isTailscaleInterface(name, entries)
        ? entries
            .filter((entry) => isIpv4Family(entry.family) && isTailscaleIpv4Address(entry.address))
            .map((entry) => entry.address)
        : [],
    ),
  );

/**
 * A Tailscale-only listener serves loopback and tailnet peers and nothing
 * else, so LAN devices cannot reach it even on a wildcard bind. The local end
 * must be one of `tailscaleAddresses`, since other VPNs share 100.64/10.
 */
export const acceptsTailnetConnection = (
  socket: {
    readonly localAddress?: string | undefined;
    readonly remoteAddress?: string | undefined;
  },
  tailscaleAddresses: ReadonlySet<string>,
): boolean => {
  const { localAddress, remoteAddress } = socket;
  if (localAddress === undefined || remoteAddress === undefined) return false;
  if (isLoopbackAddress(remoteAddress)) return isLoopbackAddress(localAddress);
  const local = plainIpv4(localAddress);
  return isTailnetIpv4Address(remoteAddress) && local !== null && tailscaleAddresses.has(local);
};

const TAILSCALE_ADDRESS_REFRESH_MS = 5_000;

/**
 * {@link acceptsTailnetConnection} against this machine's Tailscale interface
 * addresses, read again before a connection once they are a few seconds old, so
 * Tailscale coming up is picked up, and an address it gave up (another VPN can
 * take it) stops matching.
 */
export const makeTailnetConnectionFilter = (options: {
  readonly now: () => number;
  readonly readInterfaces?: () => NetworkInterfacesMap;
}) => {
  const readInterfaces = options.readInterfaces ?? NodeOS.networkInterfaces;
  let addresses = tailscaleInterfaceIpv4Addresses(readInterfaces());
  let readAt = options.now();
  return (socket: Parameters<typeof acceptsTailnetConnection>[0]): boolean => {
    if (options.now() - readAt >= TAILSCALE_ADDRESS_REFRESH_MS) {
      addresses = tailscaleInterfaceIpv4Addresses(readInterfaces());
      readAt = options.now();
    }
    return acceptsTailnetConnection(socket, addresses);
  };
};

export const loopbackUrlHostForAddress = (address: NetAddress.InetAddress): string =>
  address._tag === "InetAddressV6" && NetAddress.isLoopback(address.address)
    ? "[::1]"
    : "127.0.0.1";

const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const resolveHeadlessConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap,
  privateNetworkOnly: boolean,
  tailscaleOnly: boolean,
): string => {
  if (!host) {
    return "localhost";
  }

  if (!isWildcardHost(host)) {
    return normalizeHost(host);
  }

  if (tailscaleOnly) {
    const [tailnet] = tailscaleInterfaceIpv4Addresses(interfaces);
    return tailnet ?? "localhost";
  }
  const interfaceEntries = Object.entries(interfaces).flatMap(([name, entries]) =>
    privateNetworkOnly && VIRTUAL_INTERFACE.test(name) ? [] : (entries ?? []),
  );
  const externalIpv4Entries = interfaceEntries.filter(
    (entry) =>
      !entry.internal &&
      isIpv4Family(entry.family) &&
      (!privateNetworkOnly || isPrivateNetworkAddress(entry.address)),
  );
  // A tailnet or other CGNAT address reaches fewer devices than the LAN one.
  const externalIpv4 = privateNetworkOnly
    ? (externalIpv4Entries.find((entry) => !isSharedAddressSpaceHost(entry.address)) ??
      externalIpv4Entries[0])
    : externalIpv4Entries[0];
  if (externalIpv4) {
    return externalIpv4.address;
  }
  if (privateNetworkOnly) {
    return "localhost";
  }

  const externalIpv6 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv6Family(entry.family),
  );
  return externalIpv6 ? normalizeHost(externalIpv6.address) : "localhost";
};

export const resolveHeadlessConnectionString = (
  host: string | undefined,
  port: number,
  options: {
    readonly interfaces?: NetworkInterfacesMap;
    readonly privateNetworkOnly?: boolean | undefined;
    readonly tailscaleOnly?: boolean | undefined;
  } = {},
): string => {
  const connectionHost = resolveHeadlessConnectionHost(
    host,
    options.interfaces ?? NodeOS.networkInterfaces(),
    options.privateNetworkOnly === true,
    options.tailscaleOnly === true,
  );
  return `http://${formatHostForUrl(connectionHost)}:${port}`;
};

const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
  if (
    typeof address === "object" &&
    address !== null &&
    "port" in address &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return fallbackPort;
};

export const buildPairingUrl = (connectionString: string, token: string): string => {
  const url = new URL(connectionString);
  url.pathname = "/pair";
  url.searchParams.delete("token");
  url.hash = new URLSearchParams([["token", token]]).toString();
  return url.toString();
};

export const renderTerminalQrCode = (value: string, margin = 2): string => {
  const qrCode = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
  const rows: Array<string> = [];
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && x < qrCode.size && y >= 0 && y < qrCode.size && qrCode.getModule(x, y);

  for (let y = -margin; y < qrCode.size + margin; y += 2) {
    let row = "";

    for (let x = -margin; x < qrCode.size + margin; x += 1) {
      const topDark = isDark(x, y);
      const bottomDark = isDark(x, y + 1);

      row += topDark ? (bottomDark ? "█" : "▀") : bottomDark ? "▄" : " ";
    }

    rows.push(row);
  }

  return rows.join("\n");
};

export const formatHeadlessServeOutput = (accessInfo: HeadlessServeAccessInfo): string =>
  [
    "T3 Code server is ready.",
    `Connection string: ${accessInfo.connectionString}`,
    `Token: ${accessInfo.token}`,
    `Pairing URL: ${accessInfo.pairingUrl}`,
    `App link: ${buildPairingAppLink(accessInfo.pairingUrl)}`,
    "",
    renderTerminalQrCode(accessInfo.pairingUrl),
    "",
  ].join("\n");

export const issueHeadlessServeAccessInfo = Effect.fn("issueHeadlessServeAccessInfo")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  // Direct endpoints list the Serve URL only once it answers as this server.
  const servedEndpoint = serverConfig.tailscaleServeEnabled
    ? (yield* (yield* DirectEndpoints.DirectEndpoints).resolve()).find((endpoint) =>
        endpoint.httpBaseUrl.startsWith("https://"),
      )
    : undefined;
  const connectionString = servedEndpoint
    ? new URL(servedEndpoint.httpBaseUrl).origin
    : resolveHeadlessConnectionString(
        serverConfig.host,
        resolveListeningPort(httpServer.address, serverConfig.port),
        {
          privateNetworkOnly: serverConfig.privateNetworkOnly,
          tailscaleOnly: serverConfig.tailscaleOnly,
        },
      );
  const issued = yield* serverAuth.issueStartupPairingCredential();

  return {
    connectionString,
    token: issued.credential,
    pairingUrl: buildPairingUrl(connectionString, issued.credential),
  } satisfies HeadlessServeAccessInfo;
});
