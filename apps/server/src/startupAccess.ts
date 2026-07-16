import * as NodeOS from "node:os";

import { QrCode } from "@t3tools/shared/qrCode";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as TailnetAccess from "./tailnetAccess.ts";

export interface HeadlessServeAccessInfo {
  readonly connectionString: string;
  readonly directConnectionString: string;
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

const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

export const resolveHeadlessConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): string => {
  if (!host) {
    return "localhost";
  }

  if (!isWildcardHost(host)) {
    return normalizeHost(host);
  }

  const interfaceEntries = Object.values(interfaces).flatMap((entries) => entries ?? []);
  const externalIpv4 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv4Family(entry.family),
  );
  if (externalIpv4) {
    return externalIpv4.address;
  }

  const externalIpv6 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv6Family(entry.family),
  );
  return externalIpv6 ? normalizeHost(externalIpv6.address) : "localhost";
};

export const resolveHeadlessConnectionString = (
  host: string | undefined,
  port: number,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): string => {
  const connectionHost = resolveHeadlessConnectionHost(host, interfaces);
  return `http://${formatHostForUrl(connectionHost)}:${port}`;
};

export const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
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
    ...(accessInfo.directConnectionString === accessInfo.connectionString
      ? []
      : [`Direct address: ${accessInfo.directConnectionString}`]),
    `Token: ${accessInfo.token}`,
    `Pairing URL: ${accessInfo.pairingUrl}`,
    "",
    renderTerminalQrCode(accessInfo.pairingUrl),
    "",
  ].join("\n");

export const buildHeadlessServeAccessInfo = (input: {
  readonly directConnectionString: string;
  readonly tailnetHttpsBaseUrl: string | null;
  readonly token: string;
}): HeadlessServeAccessInfo => {
  const connectionString = input.tailnetHttpsBaseUrl
    ? new URL(input.tailnetHttpsBaseUrl).origin
    : input.directConnectionString;

  return {
    connectionString,
    directConnectionString: input.directConnectionString,
    token: input.token,
    pairingUrl: buildPairingUrl(connectionString, input.token),
  };
};

// Tailnet resolution is bounded by the tailscale command timeouts; the margin
// here only guards startup output against a missed recording ever hanging it.
const TAILNET_ACCESS_WAIT_TIMEOUT = "15 seconds";

export const issueHeadlessServeAccessInfo = Effect.fn("issueHeadlessServeAccessInfo")(function* () {
  const serverConfig = yield* ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const tailnetAccess = yield* TailnetAccess.TailnetAccess;
  const directConnectionString = resolveHeadlessConnectionString(
    serverConfig.host,
    resolveListeningPort(httpServer.address, serverConfig.port),
  );
  const tailnetHttpsBaseUrl = yield* tailnetAccess.awaitTailnetHttpsBaseUrl.pipe(
    Effect.timeoutOption(TAILNET_ACCESS_WAIT_TIMEOUT),
    Effect.map((resolved) => Option.getOrElse(resolved, () => null)),
  );
  const issued = yield* serverAuth.issueStartupPairingCredential();

  return buildHeadlessServeAccessInfo({
    directConnectionString,
    tailnetHttpsBaseUrl,
    token: issued.credential,
  });
});
