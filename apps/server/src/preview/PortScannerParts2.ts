import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  PreviewStopLocalServerError,
  ThreadId,
  type DiscoveredLocalServer,
  type PreviewStopLocalServerInput,
} from "@t3tools/contracts";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import * as HostProcess from "@t3tools/shared/HostProcess";
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

import * as WindowsTcpListeners from "../process/windowsTcpListeners.ts";
import * as ProcessRunner from "../processRunner.ts";

import type { PortDiscovery } from "./PortScanner.ts";
import {
  LSOF_TIMEOUT_MS,
  NAVIGATION_REDIRECT_STATUSES,
  POLL_INTERVAL,
  PORT_DISCOVERY_ENV,
  PROC_FD_WALK_LIMIT,
  PS_MAX_OUTPUT_BYTES,
  PS_TIMEOUT_MS,
  SOCKET_OWNER_ATTEMPTS,
  STOP_GRACE_MS,
  STOP_POLL_INTERVAL,
  UNOWNED,
  WEB_PROBE_CACHE_TTL_MS,
  WEB_PROBE_CONCURRENCY,
  WEB_PROBE_TIMEOUT,
  WINDOWS_LISTENER_TIMEOUT_MS,
  WINDOWS_PROCESS_NAME_CONCURRENCY,
  WINDOWS_PROCESS_NAME_TTL_MS,
  discoveredWindowsListeners,
  exitedWithError,
  isCommandNotFound,
  isNoSuchProcess,
  isOwned,
  localServerKey,
  lsofProcessIds,
  make,
  normalizeConfiguredUrls,
  parseLsofOutput,
  parseProcEnvironThread,
  parseProcNetTcp,
  parseProcessTable,
  parsePsEnvironmentThreads,
  parseTasklistProcessName,
  projectWebProbeSnapshot,
  serversEqual,
  stoppableProcessGroup,
  terminalOwnerKey,
  urlPort,
  webProbeCacheKey,
} from "./PortScanner.ts";
import type {
  Listener,
  ScannerState,
  ServerOwner,
  WebProbeCacheEntry,
  WebProbeGroup,
  WebProbeSnapshot,
} from "./PortScanner.ts";

export const makePortDiscoveryShape = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcess.Platform;
  const listenerDiscovery = (yield* HostProcess.Environment)[PORT_DISCOVERY_ENV] !== "0";
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const stateRef = yield* Ref.make<ScannerState>({
    listeners: new Map(),
    terminalProcesses: new Map(),
    retainCount: 0,
  });
  const webProbeCacheRef = yield* Ref.make<ReadonlyMap<string, WebProbeCacheEntry>>(new Map());
  const scanSemaphore = yield* Semaphore.make(1);
  const lsofMissingRef = yield* Ref.make(false);
  const windowsProcessNamesRef = yield* Ref.make<
    ReadonlyMap<number, { readonly name: string | null; readonly expiresAtMillis: number }>
  >(new Map());
  const socketOwnersRef = yield* Ref.make<
    ReadonlyMap<string, { readonly pid: number; readonly processName: string | null }>
  >(new Map());
  const socketOwnerMissesRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  // Each current listener pid's agent thread, or null without one. A process keeps its launch
  // environment, so a pid is read once while it listens. Cleared while no client retains the
  // scanner, since unscanned pids can be reused.
  const agentThreadsRef = yield* Ref.make<ReadonlyMap<number, ThreadId | null>>(new Map());
  let runningAgents = 0;
  // An agent that exited, or a cache cleared with a marked listener, owes one listener read: the
  // servers it left may still run. So does startup, for agents that ran before a restart.
  let agentScanPending = true;

  const readAgentThreads = Effect.fn("PortDiscovery.readAgentThreads")(function* (
    pids: ReadonlyArray<number>,
  ) {
    const cached = yield* Ref.get(agentThreadsRef);
    const unread = pids.filter((pid) => !cached.has(pid));
    const read: ReadonlyMap<number, ThreadId | null> =
      unread.length === 0
        ? new Map()
        : hostPlatform === "linux"
          ? new Map(
              yield* Effect.forEach(
                unread,
                (pid) =>
                  fileSystem.readFileString(`/proc/${pid}/environ`).pipe(
                    Effect.map(parseProcEnvironThread),
                    Effect.orElseSucceed(() => null),
                    Effect.map((threadId) => [pid, threadId] as const),
                  ),
                { concurrency: 16 },
              ),
            )
          : yield* processRunner
              .run({
                command: "ps",
                args: ["-E", "-ww", "-o", "pid=,command=", "-p", unread.join(",")],
                timeout: Duration.millis(PS_TIMEOUT_MS),
                maxOutputBytes: PS_MAX_OUTPUT_BYTES,
              })
              .pipe(
                Effect.map((result) => parsePsEnvironmentThreads(result.stdout)),
                Effect.orElseSucceed(() => {
                  agentScanPending = true;
                  return new Map();
                }),
              );
    const next = new Map<number, ThreadId | null>();
    for (const pid of pids) {
      const threadId = cached.has(pid) ? cached.get(pid) : read.get(pid);
      if (threadId !== undefined) next.set(pid, threadId);
    }
    yield* Ref.set(agentThreadsRef, next);
    return next;
  });

  const withAgentOwners = Effect.fn("PortDiscovery.withAgentOwners")(function* (
    terminalOwners: ReadonlyMap<number, ServerOwner>,
    pids: ReadonlyArray<number>,
  ) {
    // Runs only once a listener snapshot exists, so a failed read leaves the scan pending.
    agentScanPending = false;
    const threads = yield* readAgentThreads(pids.filter((pid) => !terminalOwners.has(pid)));
    const owners = new Map(terminalOwners);
    for (const [pid, threadId] of threads) {
      if (threadId !== null) owners.set(pid, { terminal: null, agent: { threadId } });
    }
    return owners;
  });

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

  const scanProcListeners = Effect.fn("PortDiscovery.scanProcListeners")(function* (
    resolveOwners: (pids: ReadonlyArray<number>) => Effect.Effect<ReadonlyMap<number, ServerOwner>>,
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
    // Walk fds only for unowned sockets; stop after repeated misses for inaccessible or exited processes.
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
    const serverOwners = yield* resolveOwners([
      ...new Set([...owners.values()].map(({ pid }) => pid)),
    ]);
    const seen = new Map<number, DiscoveredLocalServer>();
    for (const { port, inode } of listeners) {
      const socketOwner = owners.get(inode) ?? null;
      const owner = socketOwner === null ? undefined : serverOwners.get(socketOwner.pid);
      const existing = seen.get(port);
      if (existing && (existing.pid !== null || socketOwner === null)) {
        if (owner === undefined) seen.set(port, { ...existing, ...UNOWNED });
        continue;
      }
      seen.set(port, {
        host: "localhost",
        port,
        url: `http://localhost:${port}`,
        processName: socketOwner?.processName ?? null,
        pid: socketOwner?.pid ?? null,
        ...(existing ? UNOWNED : (owner ?? UNOWNED)),
      });
    }
    return [...seen.values()].toSorted((left, right) => left.port - right.port);
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
        url: raw,
        configuredKey: resourceKey,
      });
    }

    return groups;
  };

  // Only configured URLs are requested. Owned listeners are listed as plain HTTP without a
  // request: owning a process says nothing about its protocol, and HTTP or TLS bytes break
  // binary ones such as Unity's test runner or Steam's IPC.
  const probeWebServers = Effect.fn("PortDiscovery.probeWebServers")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
    configuredUrls: ReadonlyArray<string>,
  ) {
    const nowMillis = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(webProbeCacheRef);
    const groups = makeWebProbeGroups(servers, configuredUrls);
    const probed = yield* Effect.forEach(
      groups,
      (group) => {
        const { pid } = group.server;
        const cachedProbe = cached.get(group.configuredKey);
        return cachedProbe?.pid === pid && cachedProbe.expiresAtMillis > nowMillis
          ? Effect.succeed({ group, probe: cachedProbe, fresh: false })
          : probeWebUrl(group.url).pipe(
              Effect.map((result) => ({
                group,
                probe: { pid, isWeb: result !== null, expiresAtMillis: 0 },
                fresh: true,
              })),
            );
      },
      { concurrency: WEB_PROBE_CONCURRENCY },
    );
    const completedAtMillis = yield* Clock.currentTimeMillis;
    const nextCache = new Map(
      [...cached].filter(([, probe]) => probe.expiresAtMillis > completedAtMillis),
    );
    const configured = new Map<string, DiscoveredLocalServer>();
    for (const { group, probe, fresh } of probed) {
      nextCache.set(
        group.configuredKey,
        fresh ? { ...probe, expiresAtMillis: completedAtMillis + WEB_PROBE_CACHE_TTL_MS } : probe,
      );
      if (probe.isWeb) configured.set(group.configuredKey, { ...group.server, url: group.url });
    }
    yield* Ref.set(webProbeCacheRef, nextCache);
    return { discovered: servers.filter(isOwned), configured } satisfies WebProbeSnapshot;
  });

  // tasklist costs 200-300ms per PID; query visible servers with bounded concurrency and cache names.
  const withWindowsProcessNames = Effect.fn("PortDiscovery.withWindowsProcessNames")(function* (
    snapshot: WebProbeSnapshot,
  ) {
    const servers = [...snapshot.discovered, ...snapshot.configured.values()];
    const pids = new Set(servers.flatMap((server) => (server.pid === null ? [] : [server.pid])));
    const nowMillis = yield* Clock.currentTimeMillis;
    const cached = [...(yield* Ref.get(windowsProcessNamesRef))].filter(
      ([pid, entry]) => pids.has(pid) && entry.expiresAtMillis > nowMillis,
    );
    const cachedPids = new Set(cached.map(([pid]) => pid));
    const expiresAtMillis = nowMillis + WINDOWS_PROCESS_NAME_TTL_MS;
    const fetched = yield* Effect.forEach(
      [...pids].filter((pid) => !cachedPids.has(pid)),
      (pid) =>
        processRunner
          .run({
            command: "tasklist.exe",
            args: ["/FO", "CSV", "/NH", "/FI", `PID eq ${pid}`],
            timeout: Duration.millis(WINDOWS_LISTENER_TIMEOUT_MS),
            maxOutputBytes: 64 * 1024,
          })
          .pipe(
            Effect.map((result) =>
              exitedWithError(result)
                ? []
                : [
                    [
                      pid,
                      { name: parseTasklistProcessName(result.stdout, pid), expiresAtMillis },
                    ] as const,
                  ],
            ),
            Effect.orElseSucceed(() => []),
          ),
      { concurrency: WINDOWS_PROCESS_NAME_CONCURRENCY },
    );
    const names = new Map([...cached, ...fetched.flat()]);
    yield* Ref.set(windowsProcessNamesRef, names);
    const withName = (server: DiscoveredLocalServer): DiscoveredLocalServer =>
      server.pid === null || server.processName !== null
        ? server
        : { ...server, processName: names.get(server.pid)?.name ?? null };
    return {
      discovered: snapshot.discovered.map(withName),
      configured: new Map([...snapshot.configured].map(([key, server]) => [key, withName(server)])),
    } satisfies WebProbeSnapshot;
  });

  const recoverProcessProbeFailure =
    (probe: "lsof" | "windows-listeners") => (error: ProcessRunner.ProcessRunError) =>
      Effect.logDebug("preview port process probe failed; probing configured URLs only", {
        cause: error,
        probe,
        platform: hostPlatform,
      }).pipe(Effect.as(null));

  const scanUnlocked = Effect.fn("PortDiscovery.scanUnlocked")(function* (
    configuredUrls: ReadonlyArray<string>,
  ) {
    if (!listenerDiscovery) return yield* probeWebServers([], configuredUrls);
    const state = yield* Ref.get(stateRef);
    const terminalOwners = new Map<number, ServerOwner>();
    for (const registration of state.terminalProcesses.values()) {
      for (const processId of registration.processIds) {
        terminalOwners.set(processId, { terminal: registration.owner, agent: null });
      }
    }
    // A server an agent started can outlive the agent, so listeners are read while the last scan
    // still found one.
    const agentsPossible =
      hostPlatform !== "win32" &&
      (runningAgents > 0 ||
        agentScanPending ||
        [...(yield* Ref.get(agentThreadsRef)).values()].some((threadId) => threadId !== null));
    if (terminalOwners.size === 0 && configuredUrls.length === 0 && !agentsPossible) {
      return { discovered: [], configured: new Map() } satisfies WebProbeSnapshot;
    }
    const resolveOwners = (pids: ReadonlyArray<number>) =>
      agentsPossible ? withAgentOwners(terminalOwners, pids) : Effect.succeed(terminalOwners);
    if (hostPlatform === "win32") {
      const recoverWindowsProbeFailure = recoverProcessProbeFailure("windows-listeners");
      const listeners = yield* WindowsTcpListeners.queryWindowsTcpListeners(
        processRunner,
        "netstat.exe",
      ).pipe(
        Effect.map((snapshot) =>
          snapshot === null ? null : discoveredWindowsListeners(snapshot, terminalOwners),
        ),
        Effect.catchTags({
          ProcessSpawnError: recoverWindowsProbeFailure,
          ProcessStdinError: recoverWindowsProbeFailure,
          ProcessOutputLimitError: recoverWindowsProbeFailure,
          ProcessReadError: recoverWindowsProbeFailure,
          ProcessTimeoutError: recoverWindowsProbeFailure,
        }),
      );
      return yield* withWindowsProcessNames(
        yield* probeWebServers(listeners ?? [], configuredUrls),
      );
    }
    const recoverLsofProbeFailure = recoverProcessProbeFailure("lsof");
    if (yield* Ref.get(lsofMissingRef)) {
      const fromProc = yield* scanProcListeners(resolveOwners);
      return yield* probeWebServers(fromProc ?? [], configuredUrls);
    }
    const lsofResult = yield* processRunner
      .run({
        command: "lsof",
        args: ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
        timeout: Duration.millis(LSOF_TIMEOUT_MS),
        // Partial output could hide another app's listener on an owned port.
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(
        Effect.flatMap((result) =>
          resolveOwners(lsofProcessIds(result.stdout)).pipe(
            Effect.map((owners) => parseLsofOutput(result.stdout, owners)),
          ),
        ),
        Effect.catchTags({
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
    const fromProc = yield* scanProcListeners(resolveOwners);
    return yield* probeWebServers(fromProc ?? [], configuredUrls);
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
      yield* pollTick();
    }
  });

  const releaseRetention = Effect.gen(function* () {
    const idle = yield* Ref.modify(stateRef, (state) => {
      const retainCount = Math.max(0, state.retainCount - 1);
      return [retainCount === 0, { ...state, retainCount }];
    });
    if (!idle) return;
    const threads = yield* Ref.getAndSet(agentThreadsRef, new Map());
    if ([...threads.values()].some((threadId) => threadId !== null)) agentScanPending = true;
  });

  const retain: PortDiscovery["Service"]["retain"] = Effect.acquireRelease(
    acquireRetention(),
    () => releaseRetention,
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

  const trackAgent: PortDiscovery["Service"]["trackAgent"] = () => {
    runningAgents += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      runningAgents -= 1;
      agentScanPending = true;
    };
  };

  // Fails when `ps` does, so an empty table never reads as every process having exited.
  const readProcessTable = Effect.suspend(() =>
    processRunner.run({
      command: "ps",
      args: ["-A", "-o", "pid=,ppid=,pgid="],
      timeout: Duration.millis(PS_TIMEOUT_MS),
      maxOutputBytes: PS_MAX_OUTPUT_BYTES,
    }),
  ).pipe(
    Effect.mapError((cause) => new PreviewStopLocalServerError({ reason: "signal-failed", cause })),
    Effect.filterOrFail(
      (result) => !exitedWithError(result),
      () => new PreviewStopLocalServerError({ reason: "signal-failed" }),
    ),
    Effect.map((result) => parseProcessTable(result.stdout)),
  );

  const signalUntilStopped = Effect.fn("PortDiscovery.signalUntilStopped")(function* (
    input: PreviewStopLocalServerInput,
  ) {
    if (hostPlatform === "win32") {
      return yield* new PreviewStopLocalServerError({ reason: "unsupported" });
    }
    // A socket can outlive its cached owner. Wait for any in-flight scan before invalidating
    // that owner, so the /proc fallback confirms who holds it before a signal is sent.
    yield* scanSemaphore.withPermits(1)(
      Ref.update(
        socketOwnersRef,
        (owners) => new Map([...owners].filter(([, owner]) => owner.pid !== input.pid)),
      ),
    );
    // The pid comes from a client, so only a server this scan attributes to a thread is signaled,
    // from its environment as read now.
    yield* Ref.update(agentThreadsRef, (threads) => {
      const next = new Map(threads);
      next.delete(input.pid);
      return next;
    });
    agentScanPending = true;
    const listed = (yield* scanOnce()).some(
      (server) => server.pid === input.pid && server.port === input.port && isOwned(server),
    );
    if (!listed) return yield* new PreviewStopLocalServerError({ reason: "not-found" });
    const table = yield* readProcessTable;
    // It exited after the scan, so there is nothing left to stop.
    if (!table.has(input.pid)) return;
    const group = stoppableProcessGroup(table, input.pid, process.pid);
    if (group === null) return yield* new PreviewStopLocalServerError({ reason: "shared-group" });
    // False when the whole group already exited.
    const signalGroup = (signal: "SIGTERM" | "SIGKILL") =>
      Effect.suspend(() => {
        try {
          signalProcessGroup(group, signal);
          return Effect.succeed(true);
        } catch (cause) {
          return isNoSuchProcess(cause)
            ? Effect.succeed(false)
            : Effect.fail(new PreviewStopLocalServerError({ reason: "signal-failed", cause }));
        }
      });
    if (!(yield* signalGroup("SIGTERM"))) return;
    // While one of the group's original members is still in it, the group has not been reused,
    // so SIGKILL goes only to the job that ignored SIGTERM.
    const members = [...table.values()].filter((row) => row.pgid === group).map((row) => row.pid);
    const jobRunning = readProcessTable.pipe(
      Effect.map((current) => members.some((pid) => current.get(pid)?.pgid === group)),
      Effect.orElseSucceed(() => false),
    );
    const deadline = (yield* Clock.currentTimeMillis) + STOP_GRACE_MS;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      yield* Effect.sleep(STOP_POLL_INTERVAL);
      if (!(yield* jobRunning)) return;
    }
    yield* signalGroup("SIGKILL");
  });

  const stopServer: PortDiscovery["Service"]["stopServer"] = (input) =>
    // Subscribers see the server leave now rather than on the next poll.
    signalUntilStopped(input).pipe(Effect.andThen(pollIfRetained));

  return {
    scan: scanOnce,
    subscribe,
    retain,
    registerTerminalProcesses,
    unregisterTerminal,
    trackAgent,
    stopServer,
  };});
