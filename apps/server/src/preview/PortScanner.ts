/**
 * In-process PortScanner implementation.
 *
 * macOS/Linux: parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` (-F output is a
 * stable line-prefixed field format; this is the only `lsof` flag set we rely
 * on).
 *
 * Windows / lsof missing: checks a curated list of common dev ports through
 * the shared Net service.
 *
 * Listening ports are published only after a bounded HTTP(S) probe finds a
 * successful HTML document or a redirect to one.
 * Positive and negative results are cached briefly by candidate URL and listener identity,
 * limiting repeated requests without leaving stale classifications around.
 *
 * Polling is reference-counted via scoped `retain`. A single layer-scoped fiber
 * polls forever, but each tick is a no-op when the retain count is zero.
 */
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  ThreadId,
  type DiscoveredLocalServer,
  type DiscoveredLocalServerUrlKind,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import { isLoopbackHost, LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ProcessRunner from "../processRunner.ts";

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    readonly scan: (
      configuredUrls?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
    readonly subscribe: (
      input: {
        readonly configuredUrls: ReadonlyArray<string>;
        readonly initialSnapshot: ReadonlyArray<DiscoveredLocalServer>;
      },
      listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly retain: Effect.Effect<void, never, Scope.Scope>;
    readonly registerTerminalProcesses: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processIds: ReadonlyArray<number>;
    }) => Effect.Effect<void>;
    readonly unregisterTerminal: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
  }
>()("t3/preview/PortScanner/PortDiscovery") {}

export const COMMON_DEV_PORTS: ReadonlyArray<number> = Object.freeze([
  3000, 3001, 3333, 4040, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888,
  9000,
]);

const POLL_INTERVAL = Duration.seconds(3);
const LSOF_TIMEOUT_MS = 5_000;
const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;
const WEB_PROBE_TIMEOUT = Duration.seconds(1);
const WEB_PROBE_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(15));
const WEB_PROBE_CONCURRENCY = 16;
const NAVIGATION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NGROK_DEFAULT_AGENT_API_PORT = 4040;
const TAILSCALE_SERVE_STATUS_TIMEOUT = Duration.millis(1_500);

const PortlessRoute = Schema.Struct({
  hostname: Schema.String,
  port: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThan(65536)),
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const isPortlessRoute = Schema.is(PortlessRoute);
const decodePortlessRouteEntries = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const PORTLESS_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;

const NgrokTunnel = Schema.Struct({
  public_url: Schema.String,
  config: Schema.optional(Schema.Struct({ addr: Schema.String })),
  forwards_to: Schema.optional(Schema.String),
});
const isNgrokTunnel = Schema.is(NgrokTunnel);
const decodeNgrokTunnelList = Schema.decodeUnknownOption(
  Schema.Struct({ tunnels: Schema.Array(Schema.Unknown) }),
);

const TailscaleServeEndpoint = Schema.Struct({
  HTTP: Schema.optional(Schema.Boolean),
  HTTPS: Schema.optional(Schema.Boolean),
});
const isTailscaleServeEndpoint = Schema.is(TailscaleServeEndpoint);
const TailscaleServeHandler = Schema.Struct({ Proxy: Schema.optional(Schema.String) });
const isTailscaleServeHandler = Schema.is(TailscaleServeHandler);
const TailscaleServeWeb = Schema.Struct({
  Handlers: Schema.Record(Schema.String, Schema.Unknown),
});
const isTailscaleServeWeb = Schema.is(TailscaleServeWeb);
const TailscaleServeConfig = Schema.Struct({
  TCP: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  Web: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const isTailscaleServeConfig = Schema.is(TailscaleServeConfig);
const decodeTailscaleServeStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      TCP: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      Web: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      Services: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      Foreground: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

interface PortlessRouteSnapshot {
  readonly routesJson: string;
  readonly proxyPortRaw: string | null;
  readonly tls: boolean;
  readonly proxyListening: boolean;
  readonly isProcessAlive: (pid: number) => boolean;
}

interface NamedRoute {
  readonly url: string;
  readonly urlKind?: DiscoveredLocalServerUrlKind;
  readonly terminal?: Exclude<DiscoveredLocalServer["terminal"], null>;
}

const parsePortlessRouteSnapshot = (
  input: PortlessRouteSnapshot,
): ReadonlyMap<number, NamedRoute> => {
  const decoded = decodePortlessRouteEntries(input.routesJson);
  if (Option.isNone(decoded) || !input.proxyListening) return new Map();

  const defaultProxyPort = input.tls ? 443 : 80;
  const parsedProxyPort = Number(input.proxyPortRaw?.trim() ?? "");
  const proxyPort =
    Number.isInteger(parsedProxyPort) && parsedProxyPort > 0 && parsedProxyPort < 65536
      ? parsedProxyPort
      : defaultProxyPort;
  const protocol = input.tls ? "https" : "http";
  const routesByTargetPort = new Map<number, NamedRoute>();

  for (const entry of decoded.value) {
    if (!isPortlessRoute(entry)) continue;
    if (entry.pid !== 0 && !input.isProcessAlive(entry.pid)) continue;
    if (!PORTLESS_HOSTNAME_PATTERN.test(entry.hostname)) continue;
    if (routesByTargetPort.has(entry.port)) continue;

    const portSuffix = proxyPort === defaultProxyPort ? "" : `:${proxyPort}`;
    routesByTargetPort.set(entry.port, {
      url: `${protocol}://${entry.hostname}${portSuffix}`,
      urlKind: "local-proxy",
    });
  }

  return routesByTargetPort;
};

const parseLoopbackTargetPort = (raw: string): number | null => {
  const target = raw.trim();
  if (/^\d+$/.test(target)) {
    const port = Number(target);
    return port > 0 && port < 65_536 ? port : null;
  }

  try {
    const url = new URL(target.includes("://") ? target : `http://${target}`);
    if (!["http:", "https:", "https+insecure:"].includes(url.protocol)) return null;
    if (!isLoopbackHost(url.hostname)) return null;
    const port = urlPort(url);
    return port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
};

const parseNgrokTunnelSnapshot = (input: unknown): ReadonlyMap<number, NamedRoute> | null => {
  const decoded = decodeNgrokTunnelList(input);
  if (Option.isNone(decoded)) return null;

  const routesByTargetPort = new Map<number, NamedRoute>();
  for (const entry of decoded.value.tunnels) {
    if (!isNgrokTunnel(entry)) continue;
    const targetPort = parseLoopbackTargetPort(entry.config?.addr ?? entry.forwards_to ?? "");
    if (targetPort === null) continue;

    let publicUrl: URL;
    try {
      publicUrl = new URL(entry.public_url.trim());
    } catch {
      continue;
    }
    if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") continue;
    if (publicUrl.username || publicUrl.password) continue;

    const current = routesByTargetPort.get(targetPort);
    if (
      current === undefined ||
      (current.url.startsWith("http:") && publicUrl.protocol === "https:")
    ) {
      routesByTargetPort.set(targetPort, {
        url: publicUrl.href,
        urlKind: "public-tunnel",
      });
    }
  }
  return routesByTargetPort;
};

const parseTailscaleServeStatus = (raw: string): ReadonlyMap<number, NamedRoute> => {
  const decoded = decodeTailscaleServeStatus(raw);
  if (Option.isNone(decoded)) return new Map();

  const configs: Array<typeof TailscaleServeConfig.Type> = [decoded.value];
  for (const service of Object.values(decoded.value.Services ?? {})) {
    if (isTailscaleServeConfig(service)) configs.push(service);
  }
  for (const foreground of Object.values(decoded.value.Foreground ?? {})) {
    if (isTailscaleServeConfig(foreground)) configs.push(foreground);
  }

  const routesByTargetPort = new Map<number, NamedRoute>();
  for (const config of configs) {
    for (const [authority, rawWeb] of Object.entries(config.Web ?? {})) {
      if (!isTailscaleServeWeb(rawWeb)) continue;

      let inboundUrl: URL;
      try {
        inboundUrl = new URL(`http://${authority}`);
      } catch {
        continue;
      }
      if (inboundUrl.username || inboundUrl.password) continue;
      if (!inboundUrl.hostname.toLowerCase().endsWith(".ts.net")) continue;

      const inboundPort = urlPort(inboundUrl);
      const rawEndpoint = config.TCP?.[String(inboundPort)];
      if (!isTailscaleServeEndpoint(rawEndpoint)) continue;
      const protocol =
        rawEndpoint.HTTPS === true ? "https" : rawEndpoint.HTTP === true ? "http" : null;
      if (protocol === null) continue;

      for (const [mountPath, rawHandler] of Object.entries(rawWeb.Handlers)) {
        if (!isTailscaleServeHandler(rawHandler) || rawHandler.Proxy === undefined) continue;
        if (!mountPath.startsWith("/") || mountPath.startsWith("//")) continue;
        const targetPort = parseLoopbackTargetPort(rawHandler.Proxy);
        if (targetPort === null) continue;

        const routeUrl = new URL(`${protocol}://${inboundUrl.host}`);
        routeUrl.pathname = mountPath;
        const candidate = { url: routeUrl.href };
        const current = routesByTargetPort.get(targetPort);
        const shouldReplace =
          current === undefined ||
          (current.url.startsWith("http:") && routeUrl.protocol === "https:") ||
          (current.url.startsWith(`${routeUrl.protocol}//`) &&
            new URL(current.url).pathname !== "/" &&
            routeUrl.pathname === "/");
        if (shouldReplace) routesByTargetPort.set(targetPort, candidate);
      }
    }
  }
  return routesByTargetPort;
};

const applyNamedRoutes = (
  servers: ReadonlyArray<DiscoveredLocalServer>,
  routesByTargetPort: ReadonlyMap<number, NamedRoute>,
): ReadonlyArray<DiscoveredLocalServer> =>
  servers.map((server) => {
    const route = routesByTargetPort.get(server.port);
    return route === undefined
      ? server
      : { ...server, ...route, terminal: server.terminal ?? route.terminal ?? null };
  });

const hasNamedRoute = (server: DiscoveredLocalServer): boolean => {
  if (server.urlKind !== undefined) return true;
  try {
    const urlHost = new URL(server.url).hostname;
    if (isLoopbackHost(urlHost) && isLoopbackHost(server.host)) return false;
    return urlHost !== server.host;
  } catch {
    return false;
  }
};

type Listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>;

interface ListenerSubscription {
  readonly configuredUrls: ReadonlyArray<string>;
  readonly lastSnapshot: ReadonlyArray<DiscoveredLocalServer>;
}

interface ScannerState {
  readonly listeners: ReadonlyMap<Listener, ListenerSubscription>;
  readonly terminalProcesses: ReadonlyMap<
    string,
    {
      readonly owner: TerminalProcessOwner;
      readonly processIds: ReadonlySet<number>;
    }
  >;
  readonly retainCount: number;
}

interface TerminalProcessOwner {
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

interface WebProbeCacheEntry {
  readonly pid: number | null;
  readonly isWeb: boolean;
  readonly expiresAtMillis: number;
}

interface WebProbeGroup {
  readonly server: DiscoveredLocalServer;
  readonly urls: ReadonlyArray<string>;
  readonly configuredKey: string | null;
}

interface WebProbeSnapshot {
  readonly discovered: ReadonlyArray<DiscoveredLocalServer>;
  readonly configured: ReadonlyMap<string, DiscoveredLocalServer>;
}

interface NamedRouteCacheEntry {
  readonly routes: ReadonlyMap<number, NamedRoute>;
  readonly expiresAtMillis: number;
}

const terminalOwnerKey = (owner: {
  readonly threadId: string;
  readonly terminalId: string;
}): string => `${owner.threadId}\u0000${owner.terminalId}`;

const parseConfiguredUrl = (raw: string): URL | null => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isLoopbackHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
};

const localServerKey = (host: string, port: number): string =>
  `${isLoopbackHost(host) ? "loopback" : host.toLowerCase()}:${port}`;

const urlPort = (url: URL): number =>
  url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "http:" ? 80 : 443;

const webProbeCacheKey = (raw: string): string => {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
};

const projectConfiguredPath = (namedUrl: URL, configuredUrl: URL): void => {
  const mountPath = namedUrl.pathname.replace(/\/+$/, "");
  namedUrl.pathname =
    mountPath.length === 0
      ? configuredUrl.pathname
      : configuredUrl.pathname === "/"
        ? namedUrl.pathname
        : `${mountPath}/${configuredUrl.pathname.replace(/^\/+/, "")}`;
  namedUrl.search = configuredUrl.search;
  namedUrl.hash = configuredUrl.hash;
};

const normalizeConfiguredUrls = (urls: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(
    urls
      .slice(0, CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS)
      .filter((raw) => raw.length <= PREVIEW_URL_MAX_LENGTH)
      .map(parseConfiguredUrl)
      .filter((url): url is URL => url !== null && url.href.length <= PREVIEW_URL_MAX_LENGTH)
      .map((url) => {
        if (url.hostname === "0.0.0.0") url.hostname = "localhost";
        return url.href;
      })
      .filter((url) => url.length <= PREVIEW_URL_MAX_LENGTH),
  ),
];

const projectWebProbeSnapshot = (
  snapshot: WebProbeSnapshot,
  configuredUrls: ReadonlyArray<string>,
): ReadonlyArray<DiscoveredLocalServer> => {
  const visibleByServer = new Map<string, DiscoveredLocalServer>();
  const namedRouteByServer = new Map<string, DiscoveredLocalServer>();
  for (const server of snapshot.discovered) {
    if (hasNamedRoute(server)) {
      namedRouteByServer.set(localServerKey(server.host, server.port), server);
    }
  }
  for (const raw of normalizeConfiguredUrls(configuredUrls)) {
    const url = new URL(raw);
    const port = urlPort(url);
    const serverKey = localServerKey(url.hostname, port);
    if (visibleByServer.has(serverKey)) continue;
    const configured = snapshot.configured.get(webProbeCacheKey(raw));
    if (!configured) continue;
    const namedRoute =
      namedRouteByServer.get(serverKey) ?? (hasNamedRoute(configured) ? configured : null);
    if (!namedRoute) {
      visibleByServer.set(serverKey, { ...configured, url: raw });
      continue;
    }
    const namedUrl = new URL(namedRoute.url);
    projectConfiguredPath(namedUrl, url);
    visibleByServer.set(serverKey, {
      ...configured,
      url: namedUrl.href,
      urlKind: namedRoute.urlKind,
      terminal: namedRoute.terminal,
    });
  }
  for (const server of snapshot.discovered) {
    const key = localServerKey(server.host, server.port);
    if (!visibleByServer.has(key)) visibleByServer.set(key, server);
  }
  return [...visibleByServer.values()].toSorted((left, right) => left.port - right.port);
};

const parseLsofOutput = (
  raw: string,
  terminalByProcessId: ReadonlyMap<number, TerminalProcessOwner> = new Map(),
): ReadonlyArray<DiscoveredLocalServer> => {
  const seen = new Map<string, DiscoveredLocalServer>();
  let pid: number | null = null;
  let processName: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      processName = null;
      continue;
    }
    if (tag === "c") {
      processName = value.trim() || null;
      continue;
    }
    if (tag === "n") {
      const portMatch = parsePortFromLsofName(value);
      if (portMatch == null) continue;
      const url = `http://localhost:${portMatch}`;
      const key = `localhost:${portMatch}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        host: "localhost",
        port: portMatch,
        url,
        processName,
        pid,
        terminal: pid === null ? null : (terminalByProcessId.get(pid) ?? null),
      });
    }
  }

  return Array.from(seen.values()).toSorted((a, b) => a.port - b.port);
};

const parsePortFromLsofName = (name: string): number | null => {
  // Examples: "*:5173", "127.0.0.1:5173", "[::1]:5173", "localhost:5173",
  //           "192.168.1.10:5173 (LISTEN)" — we only care if the host part is local.
  const trimmed = name.split(" ", 1)[0]?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) return null;
  const hostPart = trimmed.slice(0, lastColon);
  const portPart = trimmed.slice(lastColon + 1);
  if (!LSOF_LOCAL_HOST_TOKENS.has(hostPart)) return null;
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  return port;
};

const parseWindowsListenerOutput = (
  raw: string,
  terminalByProcessId: ReadonlyMap<number, TerminalProcessOwner> = new Map(),
): ReadonlyArray<DiscoveredLocalServer> => {
  const seen = new Map<number, DiscoveredLocalServer>();
  for (const line of raw.split(/\r?\n/g)) {
    const [hostRaw, portRaw, pidRaw, processNameRaw] = line.trim().split("|", 4);
    const host = hostRaw?.trim() ?? "";
    if (!LSOF_LOCAL_HOST_TOKENS.has(host) && host !== "::") continue;
    const port = Number(portRaw);
    const pid = Number(pidRaw);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    const normalizedPid = Number.isInteger(pid) && pid > 0 ? pid : null;
    if (seen.has(port)) continue;
    seen.set(port, {
      host: "localhost",
      port,
      url: `http://localhost:${port}`,
      processName: processNameRaw?.trim() || null,
      pid: normalizedPid,
      terminal: normalizedPid === null ? null : (terminalByProcessId.get(normalizedPid) ?? null),
    });
  }
  return [...seen.values()].toSorted((left, right) => left.port - right.port);
};

const serversEqual = (
  left: ReadonlyArray<DiscoveredLocalServer>,
  right: ReadonlyArray<DiscoveredLocalServer>,
): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) return false;
    if (
      a.host !== b.host ||
      a.port !== b.port ||
      a.url !== b.url ||
      a.urlKind !== b.urlKind ||
      a.processName !== b.processName ||
      a.pid !== b.pid ||
      a.terminal?.threadId !== b.terminal?.threadId ||
      a.terminal?.terminalId !== b.terminal?.terminalId
    ) {
      return false;
    }
  }
  return true;
};

export const make = Effect.gen(function* PortDiscoveryMake() {
  const net = yield* Net.NetService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostEnvironment = yield* HostProcessEnvironment;
  const hostPlatform = yield* HostProcessPlatform;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateRef = yield* Ref.make<ScannerState>({
    listeners: new Map(),
    terminalProcesses: new Map(),
    retainCount: 0,
  });
  const webProbeCacheRef = yield* Ref.make<ReadonlyMap<string, WebProbeCacheEntry>>(new Map());
  const tailscaleRouteCacheRef = yield* Ref.make<NamedRouteCacheEntry>({
    routes: new Map(),
    expiresAtMillis: 0,
  });
  const scanSemaphore = yield* Semaphore.make(1);

  const readPortlessRoutes = Effect.fn("PortDiscovery.readPortlessRoutes")(function* () {
    const configuredStateDir = hostEnvironment.PORTLESS_STATE_DIR?.trim();
    const homeDirectory = hostEnvironment.HOME?.trim() || hostEnvironment.USERPROFILE?.trim();
    const stateDir = configuredStateDir || (homeDirectory && path.join(homeDirectory, ".portless"));
    if (!stateDir) return new Map<number, NamedRoute>();
    const routesJson = yield* fileSystem
      .readFileString(path.join(stateDir, "routes.json"))
      .pipe(Effect.option);
    if (Option.isNone(routesJson)) return new Map<number, NamedRoute>();

    const proxyPortRaw = yield* fileSystem
      .readFileString(path.join(stateDir, "proxy.port"))
      .pipe(Effect.option);
    const tls = yield* fileSystem
      .exists(path.join(stateDir, "proxy.tls"))
      .pipe(Effect.orElseSucceed(() => false));
    const defaultProxyPort = tls ? 443 : 80;
    const parsedProxyPort = Number(Option.getOrNull(proxyPortRaw)?.trim() ?? "");
    const proxyPort =
      Number.isInteger(parsedProxyPort) && parsedProxyPort > 0 && parsedProxyPort < 65_536
        ? parsedProxyPort
        : defaultProxyPort;
    const proxyListening = yield* Effect.zipWith(
      net.hasListenerOnHost(proxyPort, "127.0.0.1"),
      net.hasListenerOnHost(proxyPort, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );

    return parsePortlessRouteSnapshot({
      routesJson: routesJson.value,
      proxyPortRaw: Option.getOrNull(proxyPortRaw),
      tls,
      proxyListening,
      isProcessAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
    });
  });

  const readNgrokRoutes = Effect.fn("PortDiscovery.readNgrokRoutes")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    const candidatesByPort = new Map<
      number,
      {
        readonly processNameIsNgrok: boolean;
        readonly terminal: DiscoveredLocalServer["terminal"];
      }
    >();
    for (const server of servers) {
      const processNameIsNgrok = server.processName?.toLowerCase() === "ngrok";
      if (server.port !== NGROK_DEFAULT_AGENT_API_PORT && !processNameIsNgrok) continue;
      const current = candidatesByPort.get(server.port);
      candidatesByPort.set(server.port, {
        processNameIsNgrok: current?.processNameIsNgrok === true || processNameIsNgrok,
        terminal: current?.terminal ?? server.terminal,
      });
    }
    const responses = yield* Effect.forEach(
      candidatesByPort,
      ([port, candidate]) =>
        httpClient.get(`http://localhost:${port}/api/tunnels`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => {
            const routes = parseNgrokTunnelSnapshot(body);
            return routes === null ? null : { port, ...candidate, routes };
          }),
          Effect.scoped,
          Effect.timeoutOption(WEB_PROBE_TIMEOUT),
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: "unbounded" },
    );
    const agentPorts = new Set<number>();
    const routes = new Map<number, NamedRoute>();
    for (const response of responses) {
      if (response === null) continue;
      if (response.routes.size > 0 || response.processNameIsNgrok) agentPorts.add(response.port);
      for (const [targetPort, route] of response.routes) {
        routes.set(
          targetPort,
          response.terminal === null ? route : { ...route, terminal: response.terminal },
        );
      }
    }
    return { agentPorts, routes };
  });

  const readTailscaleRoutes = Effect.fn("PortDiscovery.readTailscaleRoutes")(function* () {
    const nowMillis = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(tailscaleRouteCacheRef);
    if (cached.expiresAtMillis > nowMillis) return cached.routes;

    const result = yield* processRunner
      .run({
        command: hostPlatform === "win32" ? "tailscale.exe" : "tailscale",
        args: ["serve", "status", "--json"],
        timeout: TAILSCALE_SERVE_STATUS_TIMEOUT,
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.option);
    if (
      Option.isNone(result) ||
      result.value.code !== 0 ||
      result.value.timedOut ||
      result.value.stdoutTruncated ||
      result.value.stdoutInvalidUtf8
    ) {
      const routes = new Map<number, NamedRoute>();
      yield* Ref.set(tailscaleRouteCacheRef, {
        routes,
        expiresAtMillis: nowMillis + WEB_PROBE_CACHE_TTL_MS,
      });
      return routes;
    }
    const routes = parseTailscaleServeStatus(result.value.stdout);
    yield* Ref.set(tailscaleRouteCacheRef, {
      routes,
      expiresAtMillis: nowMillis + WEB_PROBE_CACHE_TTL_MS,
    });
    return routes;
  });

  const probeCommonPorts = Effect.fn("PortDiscovery.probeCommonPorts")(function* () {
    const results = yield* Effect.forEach(
      COMMON_DEV_PORTS,
      (port) =>
        net.isPortAvailableOnLoopback(port).pipe(
          Effect.map((available) => ({
            port,
            listening: !available,
          })),
        ),
      { concurrency: "unbounded" },
    );
    return results
      .filter((result) => result.listening)
      .map<DiscoveredLocalServer>((result) => ({
        host: "localhost",
        port: result.port,
        url: `http://localhost:${result.port}`,
        processName: null,
        pid: null,
        terminal: null,
      }));
  });

  const probeWebUrl = Effect.fn("PortDiscovery.probeWebUrl")((url: string) =>
    httpClient.get(url).pipe(
      Effect.map((response) => {
        const location = response.headers.location?.trim();
        if (NAVIGATION_REDIRECT_STATUSES.has(response.status) && location) return url;
        if (response.status < 200 || response.status >= 300) return null;
        if (response.status === 204 || response.status === 205) return null;
        const contentType = response.headers["content-type"]
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        return contentType === "text/html" || contentType === "application/xhtml+xml" ? url : null;
      }),
      Effect.scoped,
      Effect.timeoutOption(WEB_PROBE_TIMEOUT),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  );

  const makeWebProbeGroups = (
    servers: ReadonlyArray<DiscoveredLocalServer>,
    configuredUrls: ReadonlyArray<string>,
  ): ReadonlyArray<WebProbeGroup> => {
    const serversByKey = new Map(
      servers.map((server) => [localServerKey(server.host, server.port), server] as const),
    );
    const groups: WebProbeGroup[] = [];
    const configuredResources = new Set<string>();

    for (const raw of configuredUrls) {
      const url = new URL(raw);
      const port = urlPort(url);
      const key = localServerKey(url.hostname, port);
      const resourceKey = webProbeCacheKey(raw);
      if (configuredResources.has(resourceKey)) continue;
      configuredResources.add(resourceKey);
      groups.push({
        server: serversByKey.get(key) ?? {
          host: url.hostname,
          port,
          url: raw,
          processName: null,
          pid: null,
          terminal: null,
        },
        urls: [raw],
        configuredKey: resourceKey,
      });
    }

    for (const server of servers) {
      groups.push({
        server,
        urls: [`http://${server.host}:${server.port}`, `https://${server.host}:${server.port}`],
        configuredKey: null,
      });
    }

    return groups;
  };

  const probeWebServers = Effect.fn("PortDiscovery.probeWebServers")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
    configuredUrls: ReadonlyArray<string>,
  ) {
    const nowMillis = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(webProbeCacheRef);
    const groups = makeWebProbeGroups(servers, configuredUrls);
    const batchProbes = new Map<
      string,
      Effect.Effect<{ readonly probe: WebProbeCacheEntry; readonly fresh: boolean }>
    >();
    const batchProbeSemaphore = yield* Semaphore.make(1);
    const getProbe = (url: string, pid: number | null) => {
      const key = webProbeCacheKey(url);
      const identity = `${key}\u0000${pid ?? ""}`;
      return batchProbeSemaphore
        .withPermits(1)(
          Effect.gen(function* () {
            const existing = batchProbes.get(identity);
            if (existing) return [existing] as const;
            const cachedProbe = cached.get(key);
            const cachedIsCurrent =
              cachedProbe?.pid === pid && cachedProbe.expiresAtMillis > nowMillis;
            const memoized = yield* Effect.cached(
              cachedIsCurrent
                ? Effect.succeed({ probe: cachedProbe, fresh: false })
                : probeWebUrl(url).pipe(
                    Effect.map((result) => ({
                      probe: { pid, isWeb: result !== null, expiresAtMillis: 0 },
                      fresh: true,
                    })),
                  ),
            );
            batchProbes.set(identity, memoized);
            return [memoized] as const;
          }),
        )
        .pipe(Effect.flatMap(([probe]) => probe));
    };
    const probed = yield* Effect.forEach(
      groups,
      (group) =>
        Effect.gen(function* () {
          const probes: Array<readonly [string, WebProbeCacheEntry, boolean]> = [];
          let visibleUrl: string | null = null;
          for (const url of group.urls) {
            const key = webProbeCacheKey(url);
            const { probe, fresh } = yield* getProbe(url, group.server.pid);
            probes.push([key, probe, fresh]);
            if (probe.isWeb) {
              visibleUrl = url;
              break;
            }
          }
          return { group, probes, visibleUrl };
        }),
      { concurrency: WEB_PROBE_CONCURRENCY },
    );
    const completedAtMillis = yield* Clock.currentTimeMillis;
    const nextCache = new Map(
      [...cached].filter(([, probe]) => probe.expiresAtMillis > completedAtMillis),
    );
    const discovered: DiscoveredLocalServer[] = [];
    const configured = new Map<string, DiscoveredLocalServer>();
    for (const { group, probes, visibleUrl } of probed) {
      for (const [key, probe, fresh] of probes) {
        nextCache.set(
          key,
          fresh ? { ...probe, expiresAtMillis: completedAtMillis + WEB_PROBE_CACHE_TTL_MS } : probe,
        );
      }
      if (visibleUrl === null) continue;
      const server = { ...group.server, url: visibleUrl };
      if (group.configuredKey === null) discovered.push(server);
      else configured.set(group.configuredKey, server);
    }
    yield* Ref.set(webProbeCacheRef, nextCache);
    return { discovered, configured } satisfies WebProbeSnapshot;
  });

  const probeAndEnrichWebServers = Effect.fn("PortDiscovery.probeAndEnrichWebServers")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
    configuredUrls: ReadonlyArray<string>,
  ) {
    const [portlessRoutes, tailscaleRoutes, ngrok] = yield* Effect.all(
      [readPortlessRoutes(), readTailscaleRoutes(), readNgrokRoutes(servers)],
      { concurrency: "unbounded" },
    );
    const snapshot = yield* probeWebServers(
      servers.filter((server) => !ngrok.agentPorts.has(server.port)),
      configuredUrls,
    );
    const namedRoutes = new Map(portlessRoutes);
    for (const [targetPort, route] of tailscaleRoutes) namedRoutes.set(targetPort, route);
    for (const [targetPort, route] of ngrok.routes) namedRoutes.set(targetPort, route);
    return {
      discovered: applyNamedRoutes(snapshot.discovered, namedRoutes),
      configured: new Map(
        [...snapshot.configured].map(([key, server]) => [
          key,
          applyNamedRoutes([server], namedRoutes)[0] ?? server,
        ]),
      ),
    };
  });

  const recoverProcessProbeFailure =
    (probe: "lsof" | "windows-listeners") => (error: ProcessRunner.ProcessRunError) =>
      Effect.logDebug("preview port process probe failed; falling back to common-port probes", {
        cause: error,
        probe,
        platform: hostPlatform,
      }).pipe(Effect.as(null));

  const scanUnlocked = Effect.fn("PortDiscovery.scanUnlocked")(function* (
    configuredUrls: ReadonlyArray<string>,
  ) {
    const state = yield* Ref.get(stateRef);
    const terminalByProcessId = new Map<number, TerminalProcessOwner>();
    for (const registration of state.terminalProcesses.values()) {
      for (const processId of registration.processIds) {
        terminalByProcessId.set(processId, registration.owner);
      }
    }
    if (hostPlatform === "win32") {
      const recoverWindowsProbeFailure = recoverProcessProbeFailure("windows-listeners");
      const command =
        'Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { $processName = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; Write-Output "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)|$processName" }';
      const listeners = yield* processRunner
        .run({
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", command],
          timeout: Duration.millis(WINDOWS_LISTENER_TIMEOUT_MS),
          maxOutputBytes: 1024 * 1024,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((result) => parseWindowsListenerOutput(result.stdout, terminalByProcessId)),
          Effect.catchTags({
            ProcessSpawnError: recoverWindowsProbeFailure,
            ProcessStdinError: recoverWindowsProbeFailure,
            ProcessOutputLimitError: recoverWindowsProbeFailure,
            ProcessReadError: recoverWindowsProbeFailure,
            ProcessTimeoutError: recoverWindowsProbeFailure,
          }),
        );
      return yield* probeAndEnrichWebServers(
        listeners ?? (yield* probeCommonPorts()),
        configuredUrls,
      );
    }
    const recoverLsofProbeFailure = recoverProcessProbeFailure("lsof");
    const lsofResult = yield* processRunner
      .run({
        command: "lsof",
        args: ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
        timeout: Duration.millis(LSOF_TIMEOUT_MS),
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((result) => parseLsofOutput(result.stdout, terminalByProcessId)),
        Effect.catchTags({
          ProcessSpawnError: recoverLsofProbeFailure,
          ProcessStdinError: recoverLsofProbeFailure,
          ProcessOutputLimitError: recoverLsofProbeFailure,
          ProcessReadError: recoverLsofProbeFailure,
          ProcessTimeoutError: recoverLsofProbeFailure,
        }),
      );
    return yield* probeAndEnrichWebServers(
      lsofResult ?? (yield* probeCommonPorts()),
      configuredUrls,
    );
  });

  const scanSnapshot = Effect.fn("PortDiscovery.scanSnapshot")(
    (configuredUrls: ReadonlyArray<string>) =>
      scanSemaphore.withPermits(1)(scanUnlocked(configuredUrls)),
  );

  const scanOnce: PortDiscovery["Service"]["scan"] = (configuredUrls = []) => {
    const normalized = normalizeConfiguredUrls(configuredUrls);
    return scanSnapshot(normalized).pipe(
      Effect.map((snapshot) => projectWebProbeSnapshot(snapshot, normalized)),
    );
  };

  const pollTick = Effect.fn("PortDiscovery.pollTick")(
    function* () {
      if ((yield* Ref.get(stateRef)).retainCount <= 0) return;
      const configuredUrls = [
        ...new Set(
          [...(yield* Ref.get(stateRef)).listeners.values()].flatMap(
            (subscription) => subscription.configuredUrls,
          ),
        ),
      ];
      const snapshot = yield* scanSnapshot(configuredUrls);
      const notifications = yield* Ref.modify(stateRef, (state) => {
        const listeners = new Map(state.listeners);
        const changed: Array<readonly [Listener, ReadonlyArray<DiscoveredLocalServer>]> = [];
        for (const [listener, subscription] of listeners) {
          const next = projectWebProbeSnapshot(snapshot, subscription.configuredUrls);
          if (serversEqual(subscription.lastSnapshot, next)) continue;
          listeners.set(listener, { ...subscription, lastSnapshot: next });
          changed.push([listener, next]);
        }
        return [changed, { ...state, listeners }];
      });
      yield* Effect.forEach(notifications, ([listener, servers]) => listener(servers), {
        discard: true,
      });
    },
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("preview port scan failed", Cause.pretty(cause)),
    ),
  );

  // Single layer-scoped polling fiber. Ticks are no-ops when no client is
  // currently retained, so the cost is one Ref.get every POLL_INTERVAL.
  yield* Effect.forkScoped(pollTick().pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  const acquireRetention = Effect.fn("PortDiscovery.retain")(function* () {
    const wasIdle = yield* Ref.modify(stateRef, (state) => [
      state.retainCount === 0,
      { ...state, retainCount: state.retainCount + 1 },
    ]);
    if (wasIdle) {
      // Run an immediate scan + broadcast so the new retainer doesn't have
      // to wait up to POLL_INTERVAL for the first emission.
      yield* pollTick();
    }
  });

  const retain: PortDiscovery["Service"]["retain"] = Effect.acquireRelease(acquireRetention(), () =>
    Ref.update(stateRef, (state) => ({
      ...state,
      retainCount: Math.max(0, state.retainCount - 1),
    })),
  );

  const subscribe: PortDiscovery["Service"]["subscribe"] = Effect.fn("PortDiscovery.subscribe")(
    (input, listener) =>
      Effect.acquireRelease(
        Ref.update(stateRef, (state) => {
          const listeners = new Map(state.listeners);
          listeners.set(listener, {
            configuredUrls: normalizeConfiguredUrls(input.configuredUrls),
            lastSnapshot: input.initialSnapshot,
          });
          return { ...state, listeners };
        }),
        () =>
          Ref.update(stateRef, (state) => {
            const listeners = new Map(state.listeners);
            listeners.delete(listener);
            return { ...state, listeners };
          }),
      ),
  );

  const registerTerminalProcesses: PortDiscovery["Service"]["registerTerminalProcesses"] =
    Effect.fn("PortDiscovery.registerTerminalProcesses")(function* (input) {
      const owner = {
        threadId: ThreadId.make(input.threadId),
        terminalId: input.terminalId,
      };
      const processIds = new Set(
        input.processIds.filter((processId) => Number.isInteger(processId) && processId > 0),
      );
      yield* Ref.update(stateRef, (state) => {
        const terminalProcesses = new Map(state.terminalProcesses);
        const key = terminalOwnerKey(owner);
        if (processIds.size === 0) {
          terminalProcesses.delete(key);
        } else {
          terminalProcesses.set(key, { owner, processIds });
        }
        return { ...state, terminalProcesses };
      });
    });

  const unregisterTerminal: PortDiscovery["Service"]["unregisterTerminal"] = Effect.fn(
    "PortDiscovery.unregisterTerminal",
  )(function* (input) {
    yield* Ref.update(stateRef, (state) => {
      const terminalProcesses = new Map(state.terminalProcesses);
      terminalProcesses.delete(terminalOwnerKey(input));
      return { ...state, terminalProcesses };
    });
  });

  return PortDiscovery.of({
    scan: scanOnce,
    subscribe,
    retain,
    registerTerminalProcesses,
    unregisterTerminal,
  });
}).pipe(Effect.withSpan("PortDiscovery.make"));

export const layer = Layer.effect(PortDiscovery, make);

export const __testing = {
  applyNamedRoutes,
  parseLoopbackTargetPort,
  parseNgrokTunnelSnapshot,
  parsePortlessRouteSnapshot,
  parseTailscaleServeStatus,
};
