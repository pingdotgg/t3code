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
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import { isLoopbackHost, LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import * as ProcessRunner from "../processRunner.ts";

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    readonly scan: (
      configuredUrls?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
    readonly subscribe: {
      (
        input: {
          readonly configuredUrls: ReadonlyArray<string>;
          readonly initialSnapshot?: ReadonlyArray<DiscoveredLocalServer>;
        },
        listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
      ): Effect.Effect<void, never, Scope.Scope>;
      (
        listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
      ): Effect.Effect<void, never, Scope.Scope>;
    };
    readonly retain: Effect.Effect<void, never, Scope.Scope>;
    readonly retainConfigured: (
      configuredUrls: ReadonlyArray<string>,
    ) => Effect.Effect<void, never, Scope.Scope>;
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

const ACTIVE_POLL_INTERVAL = Duration.seconds(10);
const IDLE_POLL_INTERVAL = Duration.seconds(20);
const LSOF_TIMEOUT_MS = 5_000;
const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;
const WEB_PROBE_TIMEOUT = Duration.seconds(1);
const WEB_PROBE_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(15));
const WEB_PROBE_CONCURRENCY = 16;
const NAVIGATION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type Listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>;

interface ListenerNotification {
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  readonly deliveryResult: Deferred.Deferred<Exit.Exit<void>>;
  readonly isReplay: boolean;
}

interface ListenerRegistration {
  readonly listener: Listener;
  readonly configuredUrls: ReadonlyArray<string>;
  readonly notifications: Queue.Queue<ListenerNotification>;
  readonly stoppedRef: Ref.Ref<boolean>;
}

class CurrentListenerRegistration extends Context.Reference<ListenerRegistration | undefined>(
  "t3/preview/PortScanner/CurrentListenerRegistration",
  {
    defaultValue: () => undefined,
  },
) {}

interface ScannerState {
  readonly lastSnapshot: WebProbeSnapshot;
  readonly lastScanConfiguredUrls: ReadonlySet<string>;
  readonly listeners: ReadonlyMap<ListenerRegistration, ReadonlyArray<DiscoveredLocalServer>>;
  readonly retainedConfiguredUrls: ReadonlyMap<string, number>;
  readonly terminalProcesses: ReadonlyMap<
    string,
    {
      readonly owner: TerminalProcessOwner;
      readonly processIds: ReadonlySet<number>;
      readonly needsSettleScan: boolean;
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

const processIdsEqual = (left: ReadonlySet<number>, right: ReadonlySet<number>): boolean =>
  left.size === right.size && [...left].every((processId) => right.has(processId));

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

export const make = Effect.gen(function* PortDiscoveryMake() {
  const net = yield* Net.NetService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const scanLock = yield* Semaphore.make(1);
  const notificationLock = yield* Semaphore.make(1);
  const reentrantScanRequests = yield* Queue.sliding<void>(1);
  const pollScheduleSignalRef = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const stateRef = yield* Ref.make<ScannerState>({
    lastSnapshot: { discovered: [], configured: new Map() },
    lastScanConfiguredUrls: new Set(),
    listeners: new Map(),
    retainedConfiguredUrls: new Map(),
    terminalProcesses: new Map(),
    retainCount: 0,
  });
  const webProbeCacheRef = yield* Ref.make<ReadonlyMap<string, WebProbeCacheEntry>>(new Map());

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
    if (lsofResult !== null) return yield* probeWebServers(lsofResult, configuredUrls);
    return yield* probeWebServers(yield* probeCommonPorts(), configuredUrls);
  });

  const wakePollSchedule = Effect.gen(function* () {
    const signal = yield* Ref.get(pollScheduleSignalRef);
    if (signal !== undefined) {
      yield* Deferred.succeed(signal, undefined).pipe(Effect.ignore);
    }
  });

  const publishSnapshot = Effect.fn("PortDiscovery.publishSnapshot")(function* (
    snapshot: WebProbeSnapshot,
    configuredUrls: ReadonlyArray<string>,
  ) {
    const currentListener = yield* CurrentListenerRegistration;
    const result = yield* notificationLock.withPermit(
      Effect.gen(function* () {
        const result = yield* Ref.modify(stateRef, (state) => {
          const wasActive =
            state.lastSnapshot.discovered.length > 0 || state.lastSnapshot.configured.size > 0;
          const isActive = snapshot.discovered.length > 0 || snapshot.configured.size > 0;
          const listeners = new Map(state.listeners);
          const changed: Array<
            readonly [ListenerRegistration, ReadonlyArray<DiscoveredLocalServer>]
          > = [];
          for (const [registration, previous] of listeners) {
            const next = projectWebProbeSnapshot(snapshot, registration.configuredUrls);
            if (serversEqual(previous, next)) continue;
            listeners.set(registration, next);
            changed.push([registration, next]);
          }
          return [
            {
              changed,
              pollIntervalChanged: wasActive !== isActive,
            },
            {
              ...state,
              lastSnapshot: snapshot,
              lastScanConfiguredUrls: new Set(configuredUrls),
              listeners,
            },
          ];
        });
        const deliveries: Array<Deferred.Deferred<Exit.Exit<void>>> = [];
        yield* Effect.forEach(
          result.changed,
          ([registration, servers]) =>
            Effect.gen(function* () {
              const deliveryResult = yield* Deferred.make<Exit.Exit<void>>();
              deliveries.push(deliveryResult);
              yield* Queue.offer(registration.notifications, {
                servers,
                deliveryResult,
                isReplay: false,
              });
            }),
          { discard: true },
        );
        return { pollIntervalChanged: result.pollIntervalChanged, deliveries };
      }),
    );
    if (result.pollIntervalChanged) yield* wakePollSchedule;
    if (currentListener === undefined) {
      yield* Effect.forEach(result.deliveries, Deferred.await, {
        concurrency: "unbounded",
        discard: true,
      });
    }
  });

  const scanOnce: PortDiscovery["Service"]["scan"] = (configuredUrls = []) => {
    const normalized = normalizeConfiguredUrls(configuredUrls);
    return scanLock.withPermit(
      scanUnlocked(normalized).pipe(
        Effect.map((snapshot) => projectWebProbeSnapshot(snapshot, normalized)),
      ),
    );
  };

  const pollTick = Effect.fn("PortDiscovery.pollTick")(
    function* () {
      yield* scanLock.withPermit(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          if (state.retainCount <= 0) return;
          const configuredUrls = [
            ...new Set([
              ...state.retainedConfiguredUrls.keys(),
              ...[...state.listeners.keys()].flatMap(
                (registration) => registration.configuredUrls,
              ),
            ]),
          ];
          const snapshot = yield* scanUnlocked(configuredUrls);
          yield* publishSnapshot(snapshot, configuredUrls);
        }),
      );
    },
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("preview port scan failed", Cause.pretty(cause)),
    ),
  );

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      while (true) {
        yield* Queue.take(reentrantScanRequests);
        yield* pollTick();
      }
    }),
  );

  const pollAfterTerminalChange = Effect.fn("PortDiscovery.pollAfterTerminalChange")(function* () {
    const currentListener = yield* CurrentListenerRegistration;
    if (currentListener === undefined) {
      yield* pollTick();
    } else {
      yield* Queue.offer(reentrantScanRequests, undefined);
    }
  });

  // Keep broad listener discovery as a fallback, but avoid a system-wide lsof
  // process every three seconds while the app is otherwise idle. Terminal PID
  // changes trigger immediate scans below; the periodic loop is only the
  // safety net for listeners started outside a managed terminal.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      while (true) {
        const scheduleChanged = yield* Deferred.make<void>();
        yield* Ref.set(pollScheduleSignalRef, scheduleChanged);
        const state = yield* Ref.get(stateRef);
        const shouldPoll = yield* Effect.race(
          Effect.sleep(
            state.retainCount > 0 &&
              (state.lastSnapshot.discovered.length > 0 || state.lastSnapshot.configured.size > 0)
              ? ACTIVE_POLL_INTERVAL
              : IDLE_POLL_INTERVAL,
          ).pipe(Effect.as(true)),
          Deferred.await(scheduleChanged).pipe(Effect.as(false)),
        );
        yield* Ref.update(pollScheduleSignalRef, (current) =>
          current === scheduleChanged ? undefined : current,
        );
        if (shouldPoll) yield* pollTick();
      }
    }),
  );

  const acquireRetention = Effect.fn("PortDiscovery.acquireRetention")(function* (
    configuredUrls: ReadonlyArray<string>,
  ) {
    const { shouldScan, wasIdle } = yield* Ref.modify(stateRef, (state) => {
      const retainedConfiguredUrls = new Map(state.retainedConfiguredUrls);
      for (const configuredUrl of configuredUrls) {
        retainedConfiguredUrls.set(
          configuredUrl,
          (retainedConfiguredUrls.get(configuredUrl) ?? 0) + 1,
        );
      }
      return [
        {
          shouldScan:
            state.retainCount === 0 ||
            configuredUrls.some((url) => !state.lastScanConfiguredUrls.has(url)),
          wasIdle: state.retainCount === 0,
        },
        {
          ...state,
          retainCount: state.retainCount + 1,
          retainedConfiguredUrls,
        },
      ];
    });
    if (shouldScan) {
      // Run an immediate scan + broadcast so the new retainer doesn't have
      // to wait for the periodic safety-net scan.
      yield* pollTick();
    }
    if (wasIdle) {
      yield* wakePollSchedule;
    }
  });

  const releaseRetention = Effect.fn("PortDiscovery.releaseRetention")(function* (
    configuredUrls: ReadonlyArray<string>,
  ) {
    const becameIdle = yield* Ref.modify(stateRef, (state) => {
      const retainCount = Math.max(0, state.retainCount - 1);
      const retainedConfiguredUrls = new Map(state.retainedConfiguredUrls);
      for (const configuredUrl of configuredUrls) {
        const count = retainedConfiguredUrls.get(configuredUrl) ?? 0;
        if (count <= 1) retainedConfiguredUrls.delete(configuredUrl);
        else retainedConfiguredUrls.set(configuredUrl, count - 1);
      }
      return [
        state.retainCount > 0 && retainCount === 0,
        { ...state, retainCount, retainedConfiguredUrls },
      ] as const;
    });
    if (becameIdle) yield* wakePollSchedule;
  });

  const retainConfigured: PortDiscovery["Service"]["retainConfigured"] = (configuredUrls) => {
    const normalized = normalizeConfiguredUrls(configuredUrls);
    return Effect.acquireRelease(acquireRetention(normalized), () => releaseRetention(normalized));
  };

  const retain: PortDiscovery["Service"]["retain"] = retainConfigured([]);

  const removeListener = (registration: ListenerRegistration) =>
    Ref.update(stateRef, (state) => {
      const listeners = new Map(state.listeners);
      listeners.delete(registration);
      return { ...state, listeners };
    });

  const stopListener = Effect.fn("PortDiscovery.stopListener")(function* (
    registration: ListenerRegistration,
    worker: Fiber.Fiber<void>,
  ) {
    const shouldStop = yield* Ref.modify(registration.stoppedRef, (stopped) =>
      stopped ? [false, true] : [true, true],
    );
    if (!shouldStop) return;
    const pending = yield* notificationLock.withPermit(
      Effect.gen(function* () {
        yield* removeListener(registration);
        return yield* Queue.clear(registration.notifications);
      }),
    );
    yield* Effect.forEach(
      pending,
      (notification) =>
        Deferred.succeed(notification.deliveryResult, Exit.void).pipe(Effect.ignore),
      { discard: true },
    );
    yield* Fiber.interrupt(worker);
    yield* Queue.shutdown(registration.notifications);
  });

  const runListenerNotifications = Effect.fn("PortDiscovery.runListenerNotifications")(function* (
    registration: ListenerRegistration,
  ) {
    let replayFailed = false;
    while (true) {
      const notification = yield* Queue.take(registration.notifications);
      if (replayFailed) {
        yield* Deferred.succeed(notification.deliveryResult, Exit.void).pipe(Effect.ignore);
        continue;
      }
      const delivery = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const delivery = yield* Effect.exit(
            restore(
              registration
                .listener(notification.servers)
                .pipe(Effect.provideService(CurrentListenerRegistration, registration)),
            ),
          );
          yield* Deferred.succeed(notification.deliveryResult, delivery).pipe(Effect.ignore);
          return delivery;
        }),
      );
      if (notification.isReplay) {
        replayFailed = Exit.isFailure(delivery);
      } else if (Exit.isFailure(delivery)) {
        yield* Effect.logWarning(
          "preview port snapshot listener failed",
          Cause.pretty(delivery.cause),
        );
      }
    }
  });

  const subscribeConfigured = Effect.fn("PortDiscovery.subscribe")(function* (
    configuredUrls: ReadonlyArray<string>,
    listener: Listener,
  ) {
      const { registration, replayResult, worker } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const notifications = yield* Queue.unbounded<ListenerNotification>();
          const replayResult = yield* Deferred.make<Exit.Exit<void>>();
          const stoppedRef = yield* Ref.make(false);
          const registration: ListenerRegistration = {
            listener,
            configuredUrls,
            notifications,
            stoppedRef,
          };
          yield* notificationLock.withPermit(
            Effect.gen(function* () {
              const snapshot = yield* Ref.modify(stateRef, (state) => {
                const replay = projectWebProbeSnapshot(state.lastSnapshot, configuredUrls);
                const listeners = new Map(state.listeners);
                listeners.set(registration, replay);
                return [replay, { ...state, listeners }];
              });
              yield* Queue.offer(notifications, {
                servers: snapshot,
                deliveryResult: replayResult,
                isReplay: true,
              });
            }),
          );
          const worker = yield* Effect.forkScoped(runListenerNotifications(registration));
          yield* Effect.addFinalizer(() => stopListener(registration, worker));
          return { registration, worker, replayResult };
        }),
      );
      const replayExit = yield* Deferred.await(replayResult);
      if (Exit.isFailure(replayExit)) {
        yield* stopListener(registration, worker);
        return yield* Effect.failCause(replayExit.cause);
      }
  });

  const subscribe: PortDiscovery["Service"]["subscribe"] = (
    inputOrListener:
      | Listener
      | {
          readonly configuredUrls: ReadonlyArray<string>;
          readonly initialSnapshot?: ReadonlyArray<DiscoveredLocalServer>;
        },
    maybeListener?: Listener,
  ) => {
    if (typeof inputOrListener === "function") {
      return subscribeConfigured([], inputOrListener);
    }
    if (maybeListener === undefined) {
      return Effect.die(new Error("PortDiscovery.subscribe requires a listener"));
    }
    return subscribeConfigured(
      normalizeConfiguredUrls(inputOrListener.configuredUrls),
      maybeListener,
    );
  };

  const registerTerminalProcesses: PortDiscovery["Service"]["registerTerminalProcesses"] =
    Effect.fn("PortDiscovery.registerTerminalProcesses")(function* (input) {
      const owner = {
        threadId: ThreadId.make(input.threadId),
        terminalId: input.terminalId,
      };
      const processIds = new Set(
        input.processIds.filter((processId) => Number.isInteger(processId) && processId > 0),
      );
      const shouldScan = yield* Ref.modify(stateRef, (state) => {
        const terminalProcesses = new Map(state.terminalProcesses);
        const key = terminalOwnerKey(owner);
        const existing = terminalProcesses.get(key);
        if (existing && processIdsEqual(existing.processIds, processIds)) {
          if (!existing.needsSettleScan) return [false, state] as const;
          terminalProcesses.set(key, { ...existing, needsSettleScan: false });
          return [true, { ...state, terminalProcesses }] as const;
        }
        if (processIds.size === 0) {
          if (!existing) return [false, state] as const;
          terminalProcesses.delete(key);
        } else {
          terminalProcesses.set(key, { owner, processIds, needsSettleScan: true });
        }
        return [true, { ...state, terminalProcesses }] as const;
      });
      if (shouldScan) yield* pollAfterTerminalChange();
    });

  const unregisterTerminal: PortDiscovery["Service"]["unregisterTerminal"] = Effect.fn(
    "PortDiscovery.unregisterTerminal",
  )(function* (input) {
    const changed = yield* Ref.modify(stateRef, (state) => {
      const terminalProcesses = new Map(state.terminalProcesses);
      const removed = terminalProcesses.delete(terminalOwnerKey(input));
      return [removed, removed ? { ...state, terminalProcesses } : state] as const;
    });
    if (changed) yield* pollAfterTerminalChange();
  });

  return PortDiscovery.of({
    scan: scanOnce,
    subscribe,
    retain,
    retainConfigured,
    registerTerminalProcesses,
    unregisterTerminal,
  });
}).pipe(Effect.withSpan("PortDiscovery.make"));

export const layer = Layer.effect(PortDiscovery, make);
