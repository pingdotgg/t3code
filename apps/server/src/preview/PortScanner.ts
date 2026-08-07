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
 * Polling is reference-counted via scoped `retain`. A single layer-scoped fiber
 * polls forever, but each tick is a no-op when the retain count is zero.
 */
import {
  DiscoveredServerKillError,
  ThreadId,
  type DiscoveredLocalServer,
  type ThreadOwnedProcess,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import { LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";

import * as ProcessRunner from "../processRunner.ts";
import { AgentSessionRegistry } from "../process/AgentSessionRegistry.ts";

/**
 * One scan result: listening localhost servers plus every live process the
 * registered thread trees own (agent session descendants and terminal trees),
 * whether or not it listens on a port.
 */
export interface PortScanSnapshot {
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  readonly processes: ReadonlyArray<ThreadOwnedProcess>;
}

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    readonly scan: () => Effect.Effect<PortScanSnapshot>;
    readonly subscribe: (
      listener: (snapshot: PortScanSnapshot) => Effect.Effect<void>,
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
    /**
     * Kill a process owned by the thread: either registered to one of its
     * terminals, or a freshly verified live descendant of the thread's
     * provider session process. PIDs outside both ownership checks are
     * refused. SIGTERM first, SIGKILL after a short grace period in the
     * background.
     */
    readonly killOwnedProcess: (input: {
      readonly threadId: string;
      readonly pid: number;
    }) => Effect.Effect<void, DiscoveredServerKillError>;
    /**
     * Kill every live descendant of the thread's registered provider session
     * process (excluding the session root itself, which the provider stop
     * owns). Must run BEFORE the provider session is stopped — afterwards the
     * children are reparented and can no longer be attributed. No-op when the
     * thread has no registered session root.
     */
    readonly killThreadAgentTree: (threadId: string) => Effect.Effect<void>;
  }
>()("t3/preview/PortScanner/PortDiscovery") {}

export const COMMON_DEV_PORTS: ReadonlyArray<number> = Object.freeze([
  3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);

const POLL_INTERVAL = Duration.seconds(3);
const LSOF_TIMEOUT_MS = 5_000;
const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;
const KILL_ESCALATION_GRACE = Duration.seconds(2);

const isMissingProcessError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "ESRCH";

type Listener = (snapshot: PortScanSnapshot) => Effect.Effect<void>;

interface ScannerState {
  readonly lastSnapshot: PortScanSnapshot;
  readonly listeners: ReadonlySet<Listener>;
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

const terminalOwnerKey = (owner: {
  readonly threadId: string;
  readonly terminalId: string;
}): string => `${owner.threadId}\u0000${owner.terminalId}`;

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
      a.terminal?.terminalId !== b.terminal?.terminalId ||
      a.agent?.threadId !== b.agent?.threadId
    ) {
      return false;
    }
  }
  return true;
};

const threadProcessesEqual = (
  left: ReadonlyArray<ThreadOwnedProcess>,
  right: ReadonlyArray<ThreadOwnedProcess>,
): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) return false;
    if (
      a.threadId !== b.threadId ||
      a.pid !== b.pid ||
      a.processName !== b.processName ||
      a.commandLine !== b.commandLine ||
      a.owner !== b.owner
    ) {
      return false;
    }
  }
  return true;
};

export interface ProcessTable {
  readonly parents: ReadonlyMap<number, number>;
  readonly names: ReadonlyMap<number, string>;
  readonly commandLines: ReadonlyMap<number, string>;
}

const MAX_COMMAND_LINE_LENGTH = 400;

const lastPathSegment = (token: string): string => {
  const cleaned = token.replace(/^"|"$/g, "");
  const separator = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return separator >= 0 ? cleaned.slice(separator + 1) : cleaned;
};

/**
 * Parse `pid|ppid|name|commandLine` (Win32_Process) or `pid ppid args…`
 * (ps `-o pid=,ppid=,args=`) lines into parent/name/command-line maps. The
 * command line may contain the separators, so everything after the fixed
 * fields counts as the command line.
 */
export const parseProcessTable = (raw: string): ProcessTable => {
  const parents = new Map<number, number>();
  const names = new Map<number, string>();
  const commandLines = new Map<number, string>();
  const record = (pid: number, ppid: number, name: string, commandLine: string): void => {
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) return;
    parents.set(pid, ppid);
    if (name) names.set(pid, name);
    const trimmedCommand = commandLine.trim().slice(0, MAX_COMMAND_LINE_LENGTH).trim();
    if (trimmedCommand) commandLines.set(pid, trimmedCommand);
  };
  for (const line of raw.split(/\r?\n/g)) {
    const cleaned = line.trim();
    if (cleaned.length === 0) continue;
    if (cleaned.includes("|")) {
      const [pidRaw, ppidRaw, nameRaw, ...commandParts] = cleaned.split("|");
      record(Number(pidRaw), Number(ppidRaw), nameRaw?.trim() ?? "", commandParts.join("|"));
      continue;
    }
    const match = /^(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(cleaned);
    if (!match) continue;
    const args = match[3]?.trim() ?? "";
    const firstToken = args.split(/\s+/, 1)[0] ?? "";
    record(Number(match[1]), Number(match[2]), lastPathSegment(firstToken), args);
  }
  return { parents, names, commandLines };
};

/** Walk the ancestry of `pid` (inclusive) until a registered session root is hit. */
export const findAgentOwner = (
  pid: number,
  parents: ReadonlyMap<number, number>,
  rootThreadByPid: ReadonlyMap<number, string>,
): string | null => {
  let current: number | undefined = pid;
  for (let depth = 0; depth < 128 && current !== undefined; depth += 1) {
    const threadId = rootThreadByPid.get(current);
    if (threadId !== undefined) return threadId;
    const parent = parents.get(current);
    if (parent === undefined || parent === current || parent <= 0) return null;
    current = parent;
  }
  return null;
};

/** All live descendants of `root` (excluding the root itself). */
export const collectDescendantProcessIds = (
  root: number,
  parents: ReadonlyMap<number, number>,
): ReadonlyArray<number> => {
  const childrenByParent = new Map<number, number[]>();
  for (const [pid, ppid] of parents) {
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  const collected = new Set<number>();
  const pending = [root];
  while (pending.length > 0) {
    const parent = pending.pop();
    if (parent === undefined) continue;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (child === root || collected.has(child)) continue;
      collected.add(child);
      pending.push(child);
    }
  }
  return [...collected].toSorted((a, b) => a - b);
};

export const make = Effect.gen(function* PortDiscoveryMake() {
  const net = yield* Net.NetService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const agentRegistry = yield* AgentSessionRegistry;
  const stateRef = yield* Ref.make<ScannerState>({
    lastSnapshot: { servers: [], processes: [] },
    listeners: new Set(),
    terminalProcesses: new Map(),
    retainCount: 0,
  });
  const killScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(killScope, Exit.void));

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

  const recoverProcessProbeFailure =
    (probe: "lsof" | "windows-listeners") => (error: ProcessRunner.ProcessRunError) =>
      Effect.logDebug("preview port process probe failed; falling back to common-port probes", {
        cause: error,
        probe,
        platform: hostPlatform,
      }).pipe(Effect.as(null));

  const readProcessTable = Effect.fn("PortDiscovery.readProcessTable")(function* () {
    const recoverTableProbeFailure = (error: ProcessRunner.ProcessRunError) =>
      Effect.logDebug("process table probe failed; skipping thread process attribution", {
        cause: error,
        platform: hostPlatform,
      }).pipe(Effect.as(null));
    const probe =
      hostPlatform === "win32"
        ? {
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }',
            ],
            timeout: Duration.millis(WINDOWS_LISTENER_TIMEOUT_MS),
          }
        : {
            command: "ps",
            args: ["-eo", "pid=,ppid=,args="],
            timeout: Duration.millis(LSOF_TIMEOUT_MS),
          };
    return yield* processRunner
      .run({
        ...probe,
        maxOutputBytes: 4 * 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((result) => (result.code === 0 ? parseProcessTable(result.stdout) : null)),
        Effect.catchTags({
          ProcessSpawnError: recoverTableProbeFailure,
          ProcessStdinError: recoverTableProbeFailure,
          ProcessOutputLimitError: recoverTableProbeFailure,
          ProcessReadError: recoverTableProbeFailure,
          ProcessTimeoutError: recoverTableProbeFailure,
        }),
      );
  });

  /**
   * Attach `agent` ownership by walking each unattributed listener's ancestry
   * up to a registered provider session root. Done per scan so ownership is
   * always fresh — no stale descendant registry to maintain.
   */
  const attributeAgentOwners = (
    listeners: ReadonlyArray<DiscoveredLocalServer>,
    rootThreadByPid: ReadonlyMap<number, string>,
    parents: ReadonlyMap<number, number> | null,
  ): ReadonlyArray<DiscoveredLocalServer> =>
    listeners.map((listener): DiscoveredLocalServer => {
      if (parents === null || listener.pid === null || listener.terminal !== null) {
        return { ...listener, agent: null };
      }
      const threadId = findAgentOwner(listener.pid, parents, rootThreadByPid);
      return {
        ...listener,
        agent: threadId === null ? null : { threadId: ThreadId.make(threadId) },
      };
    });

  /**
   * Every live process a thread owns right now: descendants of its provider
   * session process plus its terminals' registered trees. This is what lets
   * a running `pnpm build` show up even though it never opens a port.
   */
  const collectThreadProcesses = (
    terminalProcesses: ScannerState["terminalProcesses"],
    rootThreadByPid: ReadonlyMap<number, string>,
    table: ProcessTable,
  ): ReadonlyArray<ThreadOwnedProcess> => {
    const out: ThreadOwnedProcess[] = [];
    const seen = new Set<number>();
    const push = (pid: number, threadId: ThreadId, owner: ThreadOwnedProcess["owner"]): void => {
      if (seen.has(pid)) return;
      seen.add(pid);
      const processName = table.names.get(pid) ?? null;
      // Windows console hosts are pure plumbing — one per console process,
      // never something a user started or wants to stop.
      if (processName?.toLowerCase() === "conhost.exe") return;
      out.push({
        threadId,
        pid,
        processName,
        commandLine: table.commandLines.get(pid) ?? null,
        owner,
      });
    };
    for (const [rootPid, threadId] of rootThreadByPid) {
      for (const pid of collectDescendantProcessIds(rootPid, table.parents)) {
        push(pid, ThreadId.make(threadId), "agent");
      }
    }
    for (const registration of terminalProcesses.values()) {
      for (const pid of registration.processIds) {
        if (!table.parents.has(pid)) continue;
        push(pid, registration.owner.threadId, "terminal");
      }
    }
    return out.toSorted((a, b) => a.pid - b.pid);
  };

  const probeListeners = Effect.fn("PortDiscovery.probeListeners")(function* () {
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
      if (listeners !== null) return listeners;
      return yield* probeCommonPorts();
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
    if (lsofResult !== null) return lsofResult;
    return yield* probeCommonPorts();
  });

  const scanOnce = Effect.fn("PortDiscovery.scan")(
    function* (): Effect.fn.Return<PortScanSnapshot> {
      const listeners = yield* probeListeners();
      const state = yield* Ref.get(stateRef);
      const rootThreadByPid = yield* agentRegistry.snapshot;
      const needsTable = rootThreadByPid.size > 0 || state.terminalProcesses.size > 0;
      const table = needsTable ? yield* readProcessTable() : null;
      const servers = attributeAgentOwners(listeners, rootThreadByPid, table?.parents ?? null);
      const processes =
        table === null
          ? []
          : collectThreadProcesses(state.terminalProcesses, rootThreadByPid, table);
      return { servers, processes };
    },
  );

  const broadcast = Effect.fn("PortDiscovery.broadcast")(function* (snapshot: PortScanSnapshot) {
    const listeners = (yield* Ref.get(stateRef)).listeners;
    yield* Effect.forEach(listeners, (listener) => listener(snapshot), { discard: true });
  });

  const pollTick = Effect.fn("PortDiscovery.pollTick")(
    function* () {
      if ((yield* Ref.get(stateRef)).retainCount <= 0) return;
      const next = yield* scanOnce();
      const changed = yield* Ref.modify(stateRef, (state) =>
        serversEqual(state.lastSnapshot.servers, next.servers) &&
        threadProcessesEqual(state.lastSnapshot.processes, next.processes)
          ? [false, state]
          : [true, { ...state, lastSnapshot: next }],
      );
      if (changed) yield* broadcast(next);
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
    (listener) =>
      Effect.acquireRelease(
        Ref.update(stateRef, (state) => ({
          ...state,
          listeners: new Set([...state.listeners, listener]),
        })),
        () =>
          Ref.update(stateRef, (state) => {
            const listeners = new Set(state.listeners);
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

  const isAgentOwnedByThread = Effect.fn("PortDiscovery.isAgentOwnedByThread")(function* (input: {
    readonly threadId: string;
    readonly pid: number;
  }) {
    const rootThreadByPid = yield* agentRegistry.snapshot;
    if (rootThreadByPid.size === 0) return false;
    const table = yield* readProcessTable();
    if (table === null) return false;
    return findAgentOwner(input.pid, table.parents, rootThreadByPid) === input.threadId;
  });

  const killOwnedProcess: PortDiscovery["Service"]["killOwnedProcess"] = Effect.fn(
    "PortDiscovery.killOwnedProcess",
  )(function* (input) {
    const state = yield* Ref.get(stateRef);
    const owned =
      [...state.terminalProcesses.values()].some(
        (registration) =>
          registration.owner.threadId === input.threadId && registration.processIds.has(input.pid),
      ) || (yield* isAgentOwnedByThread(input));
    if (!owned) {
      return yield* new DiscoveredServerKillError({ pid: input.pid, reason: "not-owned" });
    }

    const outcome = yield* Effect.sync((): "sent" | "gone" | "failed" => {
      try {
        process.kill(input.pid, "SIGTERM");
        return "sent";
      } catch (cause) {
        return isMissingProcessError(cause) ? "gone" : "failed";
      }
    });
    if (outcome === "failed") {
      return yield* new DiscoveredServerKillError({ pid: input.pid, reason: "signal-failed" });
    }

    if (outcome === "sent") {
      // Escalate off the request path: respond as soon as SIGTERM is out,
      // force-kill survivors after the grace period.
      yield* Effect.sleep(KILL_ESCALATION_GRACE).pipe(
        Effect.andThen(
          Effect.sync(() => {
            try {
              process.kill(input.pid, "SIGKILL");
            } catch {
              // Already exited.
            }
          }),
        ),
        Effect.andThen(pollTick()),
        Effect.forkIn(killScope),
      );
    }
  });

  const killThreadAgentTree: PortDiscovery["Service"]["killThreadAgentTree"] = Effect.fn(
    "PortDiscovery.killThreadAgentTree",
  )(function* (threadId) {
    const root = yield* agentRegistry.rootForThread(threadId);
    if (root === null) return;
    const table = yield* readProcessTable();
    if (table === null) return;
    const descendants = collectDescendantProcessIds(root, table.parents);
    if (descendants.length === 0) return;
    const survivors = yield* Effect.sync(() =>
      descendants.filter((pid) => {
        try {
          process.kill(pid, "SIGTERM");
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (survivors.length === 0) return;
    yield* Effect.sleep(KILL_ESCALATION_GRACE).pipe(
      Effect.andThen(
        Effect.sync(() => {
          for (const pid of survivors) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Already exited.
            }
          }
        }),
      ),
      Effect.forkIn(killScope),
    );
  });

  return PortDiscovery.of({
    scan: scanOnce,
    subscribe,
    retain,
    registerTerminalProcesses,
    unregisterTerminal,
    killOwnedProcess,
    killThreadAgentTree,
  });
}).pipe(Effect.withSpan("PortDiscovery.make"));

export const layer = Layer.effect(PortDiscovery, make);
