// @effect-diagnostics nodeBuiltinImport:off - The private-network gate guards the node:http server.
import type * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  formatHostForUrl,
  isPrivateNetworkHost,
  isSharedAddressSpaceHost,
  isWildcardHost,
} from "@t3tools/shared/hostClassification";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { QrCode } from "@t3tools/shared/qrCode";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerConfig from "./config.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";

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

/**
 * Container and VM networks, macOS's `bridge100`+, and Windows' hidden virtual
 * adapters such as the hotspot's localized `Local Area Connection* 2` reach only
 * this machine's guests or tethered devices. A host bridge such as `br0` carries the LAN.
 */
const VIRTUAL_INTERFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|vEthernet|podman|cni|flannel|cali|lxcbr|lxdbr|bridge[1-9]\d\d)|\* \d+$/;

// VirtualBox and VMware host-only adapters on Windows. Their names are mutable; Linux bridges can inherit these MACs.
export const WINDOWS_HOST_ADAPTER_MAC = /^(0a:00:27|00:50:56:c0:00):/i;

/**
 * systemd-nspawn's `ve-*`/`vz-*` and NixOS containers' `vb-*` name host-side
 * veths after the machine. Windows aliases are user-renameable, so these
 * prefixes only apply to Linux interface discovery.
 */
const LINUX_CONTAINER_INTERFACE = /^(ve-|vb-|vz-)/;

export const isVirtualInterface = (name: string, platform: NodeJS.Platform): boolean =>
  VIRTUAL_INTERFACE.test(name) || (platform === "linux" && LINUX_CONTAINER_INTERFACE.test(name));

/**
 * Loopback or private-range IPv4 (LAN, tailnet, CGNAT), not link-local, in
 * plain or IPv4-mapped IPv6 form.
 */
export const isPrivateNetworkAddress = (address: string): boolean => {
  const ipv4 = address.replace(/^::ffff:/i, "");
  return NodeNet.isIPv4(ipv4) && !ipv4.startsWith("169.254.") && isPrivateNetworkHost(ipv4);
};

/** VPN and proxy clients put their tunnels in 198.18.0.0/15 (RFC 2544), which is never a LAN. */
export const isVpnTunnelAddress = (address: string): boolean => /^198\.1[89]\./.test(address);

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

const CLOSED_CONNECTION_LOG_INTERVAL_NANOS = 60_000_000_000n;

/**
 * Closing is silent to the client, so closed connections are logged with both
 * addresses: the first at once, then at most one line a minute with a count, so
 * a connect flood from outside cannot grow the service log without bound.
 */
// Untraced: the captured context would otherwise tie every later warning to a span that ended at startup.
export const closeNonPrivateNetworkConnections = Effect.fnUntraced(function* (
  server: NodeHttp.Server,
) {
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());
  let nextLogAt: bigint | undefined;
  let closedSinceLastLog = 0;
  server.on("connection", (socket) => {
    if (acceptsPrivateNetworkConnection(socket)) return;
    // Read before destroy: Node forgets localAddress once the handle closes.
    const addresses = { localAddress: socket.localAddress, remoteAddress: socket.remoteAddress };
    socket.destroy();
    runSync(
      Effect.gen(function* () {
        // Monotonic: a wall clock set backwards must not silence the warnings.
        const now = yield* Clock.monotonicTimeNanos;
        if (nextLogAt !== undefined && now < nextLogAt) {
          closedSinceLastLog += 1;
          return;
        }
        nextLogAt = now + CLOSED_CONNECTION_LOG_INTERVAL_NANOS;
        yield* Effect.logWarning("closed a connection outside the private network", {
          ...addresses,
          ...(closedSinceLastLog > 0 ? { closedSinceLastLog } : {}),
        });
        closedSinceLastLog = 0;
      }),
    );
  });
});

export const loopbackUrlHostForAddress = (address: NetAddress.InetAddress): string =>
  NetAddress.isUnspecified(address.address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address.address));

const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

const resolveHeadlessConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap,
  privateNetworkOnly: boolean,
  platform: NodeJS.Platform,
): string => {
  if (!host) {
    return "localhost";
  }

  if (!isWildcardHost(host)) {
    return normalizeHost(host);
  }

  const interfaceEntries = Object.entries(interfaces).flatMap(([name, entries]) =>
    privateNetworkOnly && isVirtualInterface(name, platform) ? [] : (entries ?? []),
  );
  const externalIpv4Entries = interfaceEntries.filter(
    (entry) =>
      !entry.internal &&
      isIpv4Family(entry.family) &&
      (!privateNetworkOnly ||
        (isPrivateNetworkAddress(entry.address) &&
          !isVpnTunnelAddress(entry.address) &&
          !(platform === "win32" && WINDOWS_HOST_ADAPTER_MAC.test(entry.mac)))),
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
    readonly platform: NodeJS.Platform;
  },
): string => {
  const connectionHost = resolveHeadlessConnectionHost(
    host,
    options.interfaces ?? NodeOS.networkInterfaces(),
    options.privateNetworkOnly === true,
    options.platform,
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
    ...(isLoopbackHost(new URL(accessInfo.connectionString).hostname)
      ? []
      : [
          "",
          "Warning: this address uses plain HTTP. Anyone on the same network can read the",
          "token and control this machine. Use it over a VPN or tailnet you trust.",
        ]),
    "",
    renderTerminalQrCode(accessInfo.pairingUrl),
    "",
  ].join("\n");

export const issueHeadlessServeAccessInfo = Effect.fn("issueHeadlessServeAccessInfo")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const platform = yield* HostProcess.Platform;
  const connectionString = resolveHeadlessConnectionString(
    serverConfig.host,
    resolveListeningPort(httpServer.address, serverConfig.port),
    { privateNetworkOnly: serverConfig.privateNetworkOnly, platform },
  );
  const issued = yield* serverAuth.issueStartupPairingCredential();

  return {
    connectionString,
    token: issued.credential,
    pairingUrl: buildPairingUrl(connectionString, issued.credential),
  } satisfies HeadlessServeAccessInfo;
});
