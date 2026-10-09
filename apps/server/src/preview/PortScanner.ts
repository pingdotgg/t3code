/**
 * In-process PortScanner implementation.
 *
 * macOS/Linux: parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` (-F output is a
 * stable line-prefixed field format; this is the only `lsof` flag set we rely
 * on).
 *
 * Linux without lsof: reads listening sockets from `/proc/net/tcp{,6}` and
 * finds their processes through `/proc/<pid>/fd`.
 *
 * Windows listener failures, or neither source: checks a curated list of
 * common dev ports through the shared Net service.
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
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/http";

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
  3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);

const POLL_INTERVAL = Duration.seconds(3);
const LSOF_TIMEOUT_MS = 5_000;
/** File descriptors one `/proc` walk may read before it stops looking for socket owners. */
const PROC_FD_WALK_LIMIT = 50_000;
/** Scans that retry the fd walk for a listening socket whose owner was not found. */
const SOCKET_OWNER_ATTEMPTS = 3;
const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;
const WEB_PROBE_TIMEOUT = Duration.seconds(1);
const WEB_PROBE_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(15));
const WEB_PROBE_CONCURRENCY = 16;
const NAVIGATION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
  for (const raw of normalizeConfiguredUrls(configuredUrls)) {
    const url = new URL(raw);
    const port = urlPort(url);
    const serverKey = localServerKey(url.hostname, port);
    if (visibleByServer.has(serverKey)) continue;
    const configured = snapshot.configured.get(webProbeCacheKey(raw));
    if (configured) visibleByServer.set(serverKey, { ...configured, url: raw });
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

/** `/proc/net/tcp` state for a listening socket. */
const PROC_TCP_LISTEN = "0A";

/**
 * Whether a `/proc/net/tcp{,6}` address is one the preview can reach on
 * loopback: the wildcard or a loopback address, as `lsof` parsing accepts.
 * Each 32-bit word of the hex address is little-endian.
 */
const procLocalAddress = (hex: string): boolean => {
  if (hex.length === 8) {
    return hex === "00000000" || hex.endsWith("7F");
  }
  if (hex.length !== 32) return false;
  if (hex === "0".repeat(32) || hex === `${"0".repeat(24)}01000000`) return true;
  // IPv4-mapped (::ffff:a.b.c.d): wildcard or 127.0.0.0/8.
  return hex.startsWith(`${"0".repeat(16)}FFFF0000`) && procLocalAddress(hex.slice(24));
};

/** Listening loopback ports in `/proc/net/tcp{,6}` content, with their socket inodes. */
const parseProcNetTcp = (
  raw: string,
): ReadonlyArray<{ readonly port: number; readonly inode: string }> => {
  const listeners: Array<{ port: number; inode: string }> = [];
  for (const line of raw.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [address, portHex] = fields[1]?.split(":") ?? [];
    if (fields[3] !== PROC_TCP_LISTEN || !address || !portHex) continue;
    if (!procLocalAddress(address.toUpperCase())) continue;
    const port = Number.parseInt(portHex, 16);
    const inode = fields[9];
    if (!Number.isInteger(port) || port <= 0 || port >= 65536 || !inode) continue;
    listeners.push({ port, inode });
  }
  return listeners;
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

const isCommandNotFound = (error: ProcessRunner.ProcessSpawnError): boolean =>
  PlatformError.isPlatformError(error.cause) && error.cause.reason._tag === "NotFound";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* PortDiscoveryMake() {
  const net = yield* Net.NetService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcess.Platform;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const stateRef = yield* Ref.make<ScannerState>({
    listeners: new Map(),
    terminalProcesses: new Map(),
    retainCount: 0,
  });
  const webProbeCacheRef = yield* Ref.make<ReadonlyMap<string, WebProbeCacheEntry>>(new Map());
  const scanSemaphore = yield* Semaphore.make(1);
  const lsofMissingRef = yield* Ref.make(false);
  /** Confirmed owners of listening socket inodes. */
  const socketOwnersRef = yield* Ref.make<
    ReadonlyMap<string, { readonly pid: number; readonly processName: string | null }>
  >(new Map());
  /** Fd walks that found no owner, per socket inode; retried up to `SOCKET_OWNER_ATTEMPTS`. */
  const socketOwnerMissesRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  /** Maps socket inodes to the processes holding them, by `/proc/<pid>/fd`. */
  const findSocketOwners = Effect.fn("PortDiscovery.findSocketOwners")(function* (
    inodes: ReadonlySet<string>,
  ) {
    const owners = new Map<string, { pid: number; processName: string | null }>();
    const pids = (yield* fileSystem
      .readDirectory("/proc")
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).filter((entry) =>
      /^\d+$/.test(entry),
    );
    let budget = PROC_FD_WALK_LIMIT;
    for (const pidText of pids) {
      if (owners.size === inodes.size || budget <= 0) break;
      // Other users' fds are unreadable; their ports still list, without a pid.
      const fds = yield* fileSystem
        .readDirectory(`/proc/${pidText}/fd`)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const walked = fds.slice(0, budget);
      budget -= walked.length;
      const links = yield* Effect.forEach(
        walked,
        (fd) =>
          fileSystem.readLink(`/proc/${pidText}/fd/${fd}`).pipe(Effect.orElseSucceed(() => "")),
        { concurrency: 16 },
      );
      const held = links.flatMap((link) => /^socket:\[(\d+)\]$/.exec(link)?.[1] ?? []);
      const matched = held.filter((inode) => inodes.has(inode) && !owners.has(inode));
      if (matched.length === 0) continue;
      const processName = yield* fileSystem.readFileString(`/proc/${pidText}/comm`).pipe(
        Effect.map((name) => name.trim() || null),
        Effect.orElseSucceed(() => null),
      );
      for (const inode of matched) owners.set(inode, { pid: Number(pidText), processName });
    }
    return owners;
  });

  /**
   * Linux listeners from `/proc/net/tcp{,6}`, for hosts without `lsof`. Null
   * when neither file is readable, so discovery falls back to common ports.
   */
  const scanProcListeners = Effect.fn("PortDiscovery.scanProcListeners")(function* (
    terminalByProcessId: ReadonlyMap<number, TerminalProcessOwner>,
  ) {
    if (hostPlatform !== "linux") return null;
    const tables = yield* Effect.forEach(["/proc/net/tcp", "/proc/net/tcp6"], (path) =>
      fileSystem.readFileString(path).pipe(Effect.option),
    );
    if (tables.every(Option.isNone)) return null;
    const listeners = tables.flatMap((table) =>
      Option.isSome(table) ? parseProcNetTcp(table.value) : [],
    );
    const known = yield* Ref.get(socketOwnersRef);
    const knownMisses = yield* Ref.get(socketOwnerMissesRef);
    const inodes = new Set(listeners.map((listener) => listener.inode));
    // Listeners rarely change, so the fd walk runs only for sockets without a
    // confirmed owner, and gives up on one after a few walks miss it (another
    // user's process, or one that exited mid-walk).
    const unseen = new Set(
      [...inodes].filter(
        (inode) => !known.has(inode) && (knownMisses.get(inode) ?? 0) < SOCKET_OWNER_ATTEMPTS,
      ),
    );
    const found = unseen.size === 0 ? new Map() : yield* findSocketOwners(unseen);
    const owners = new Map([...known, ...found].filter(([inode]) => inodes.has(inode)));
    const misses = new Map([...knownMisses].filter(([inode]) => inodes.has(inode)));
    for (const inode of unseen) {
      if (!found.has(inode)) misses.set(inode, (misses.get(inode) ?? 0) + 1);
    }
    yield* Ref.set(socketOwnersRef, owners);
    yield* Ref.set(socketOwnerMissesRef, misses);
    const seen = new Map<number, DiscoveredLocalServer>();
    for (const { port, inode } of listeners) {
      const owner = owners.get(inode) ?? null;
      const existing = seen.get(port);
      if (existing && (existing.pid !== null || owner === null)) continue;
      seen.set(port, {
        host: "localhost",
        port,
        url: `http://localhost:${port}`,
        processName: owner?.processName ?? null,
        pid: owner?.pid ?? null,
        terminal: owner === null ? null : (terminalByProcessId.get(owner.pid) ?? null),
      });
    }
    return [...seen.values()].toSorted((left, right) => left.port - right.port);
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
      if (listeners !== null) return yield* probeWebServers(listeners, configuredUrls);
      return yield* probeWebServers(yield* probeCommonPorts(), configuredUrls);
    }
    const recoverLsofProbeFailure = recoverProcessProbeFailure("lsof");
    if (yield* Ref.get(lsofMissingRef)) {
      const fromProc = yield* scanProcListeners(terminalByProcessId);
      return yield* probeWebServers(fromProc ?? (yield* probeCommonPorts()), configuredUrls);
    }
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
          // A missing lsof stays missing; later scans skip straight to the fallback.
          ProcessSpawnError: (error) =>
            (isCommandNotFound(error) ? Ref.set(lsofMissingRef, true) : Effect.void).pipe(
              Effect.andThen(recoverLsofProbeFailure(error)),
            ),
          ProcessStdinError: recoverLsofProbeFailure,
          ProcessOutputLimitError: recoverLsofProbeFailure,
          ProcessReadError: recoverLsofProbeFailure,
          ProcessTimeoutError: recoverLsofProbeFailure,
        }),
      );
    if (lsofResult !== null) return yield* probeWebServers(lsofResult, configuredUrls);
    const fromProc = yield* scanProcListeners(terminalByProcessId);
    return yield* probeWebServers(fromProc ?? (yield* probeCommonPorts()), configuredUrls);
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

  // Single layer-scoped polling fiber. Ticks skip the scan and its span when no
  // client is currently retained, so the cost is one Ref.get every POLL_INTERVAL.
  const pollIfRetained = Ref.get(stateRef).pipe(
    Effect.flatMap((state) => (state.retainCount > 0 ? pollTick() : Effect.void)),
  );
  yield* Effect.forkScoped(pollIfRetained.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

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
