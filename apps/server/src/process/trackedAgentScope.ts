// @effect-diagnostics nodeBuiltinImport:off -- instance ids and signals come from the host.
import * as NodeCrypto from "node:crypto";

import type { AgentScopeShape } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

/**
 * Without cgroups an orphaned job in its own group keeps nothing naming its agent: macOS hides
 * other processes' environments, and Claude's tool shells call setsid. Snapshots record each
 * session's descendants by pid and start time; a job that escapes between two is missed.
 */

const OWNERS_DIR = "agent-processes";
const INSTANCE_FILE = /^[0-9a-f]{32}$/;
const POSIX_POLL_INTERVAL = "5 seconds";
// Each Windows snapshot starts PowerShell.
const WINDOWS_POLL_INTERVAL = "15 seconds";
const TABLE_TIMEOUT = "15 seconds";
const TABLE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STOP_POLL_INTERVAL = "100 millis";
const STOP_POLL_ATTEMPTS = 50;
const WINDOWS_TABLE_SCRIPT =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop | " +
  'ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToFileTimeUtc())" } }';
// FILETIME counts 100 ns ticks from 1601.
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000;

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  /** Milliseconds since the epoch; whole seconds from `ps`. */
  readonly started: number;
}

/** Reads `ps -A -o pid=,ppid=,lstart=` run with `LC_ALL=C TZ=UTC`. */
export function parsePosixProcessRows(raw: string): ReadonlyArray<ProcessRow> {
  return raw.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    const started = match === null ? Number.NaN : Date.parse(`${match[3]} UTC`);
    return match === null || !Number.isFinite(started)
      ? []
      : [{ pid: Number(match[1]), ppid: Number(match[2]), started }];
  });
}

/** Reads `pid|ppid|creation FILETIME` lines from {@link WINDOWS_TABLE_SCRIPT}. */
export function parseWindowsProcessRows(raw: string): ReadonlyArray<ProcessRow> {
  return raw.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\|(\d+)\|(\d+)\s*$/.exec(line);
    return match === null
      ? []
      : [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            started: Number(match[3]) / 10_000 - FILETIME_UNIX_EPOCH_MS,
          },
        ];
  });
}

/**
 * The known processes still running, and every process below them. Windows
 * keeps a dead parent's pid as the parent, so a child older than its listed
 * parent sits under a reused pid and is not a descendant.
 */
export function trackedProcesses(
  rows: ReadonlyArray<ProcessRow>,
  known: ReadonlyMap<number, number>,
): Map<number, number> {
  const children = new Map<number, Array<ProcessRow>>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = children.get(row.ppid);
    if (siblings === undefined) children.set(row.ppid, [row]);
    else siblings.push(row);
  }
  const tracked = new Map<number, number>();
  const queue = rows.filter((row) => known.get(row.pid) === row.started);
  for (const row of queue) tracked.set(row.pid, row.started);
  while (queue.length > 0) {
    const parent = queue.pop()!;
    for (const child of children.get(parent.pid) ?? []) {
      if (tracked.has(child.pid) || child.started < parent.started) continue;
      tracked.set(child.pid, child.started);
      queue.push(child);
    }
  }
  tracked.delete(process.pid);
  return tracked;
}

interface Session {
  readonly threadId: string;
  processes: Map<number, number>;
}

const serialize = (processes: Iterable<readonly [number, number]>) =>
  [...processes].map(([pid, started]) => `${pid}\t${started}\n`).join("");

const parseRecord = (text: string) =>
  new Map(
    text.split("\n").flatMap((line) => {
      const [pid, started] = line.split("\t").map(Number);
      return Number.isInteger(pid) && Number.isFinite(started) ? [[pid!, started!] as const] : [];
    }),
  );

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const layerScope = yield* Effect.scope;
  const ownersDir = path.join(stateDir, OWNERS_DIR);
  const instance = NodeCrypto.randomUUID().replaceAll("-", "");
  const record = path.join(ownersDir, instance);
  const lock = yield* Semaphore.make(1);

  // This server's start time, which its record carries so a reused pid cannot pass for it.
  let ownStart: number | undefined;

  // Undefined when the table cannot be read, so a failed read never looks like every process exited.
  const readTable = runner
    .run(
      platform === "win32"
        ? {
            command: "powershell.exe",
            args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_SCRIPT],
            timeout: TABLE_TIMEOUT,
            maxOutputBytes: TABLE_MAX_OUTPUT_BYTES,
          }
        : {
            command: "ps",
            args: ["-A", "-o", "pid=,ppid=,lstart="],
            env: { LC_ALL: "C", TZ: "UTC" },
            timeout: TABLE_TIMEOUT,
            maxOutputBytes: TABLE_MAX_OUTPUT_BYTES,
          },
    )
    .pipe(
      Effect.map((result) =>
        result.code !== 0 || result.timedOut
          ? undefined
          : platform === "win32"
            ? parseWindowsProcessRows(result.stdout)
            : parsePosixProcessRows(result.stdout),
      ),
      Effect.tap((rows) =>
        Effect.sync(() => {
          ownStart ??= rows?.find((row) => row.pid === process.pid)?.started;
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  // Signals only processes the table just read still shows with the same start time.
  const signal = (
    targets: ReadonlyMap<number, number>,
    rows: ReadonlyArray<ProcessRow>,
    name: "SIGTERM" | "SIGKILL",
  ) => {
    const live = new Map<number, number>();
    for (const row of rows) {
      if (targets.get(row.pid) !== row.started || row.pid === process.pid) continue;
      live.set(row.pid, row.started);
      try {
        process.kill(row.pid, name);
      } catch {}
    }
    return live;
  };

  const terminate = Effect.fn("trackedAgentScope.terminate")(function* (
    targets: ReadonlyMap<number, number>,
    rows: ReadonlyArray<ProcessRow>,
  ) {
    let remaining = signal(targets, rows, "SIGTERM");
    for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS && remaining.size > 0; attempt++) {
      yield* Effect.sleep(STOP_POLL_INTERVAL);
      const current = yield* readTable;
      if (current === undefined) return;
      remaining = new Map(
        current.flatMap((row) =>
          remaining.get(row.pid) === row.started ? [[row.pid, row.started] as const] : [],
        ),
      );
    }
    if (remaining.size === 0) return;
    const current = yield* readTable;
    if (current !== undefined) signal(remaining, current, "SIGKILL");
  });

  const sessions = new Map<string, Session>();
  const sessionByThread = new Map<string, string>();
  const threadByUnit = new Map<string, string>();
  let written = "";

  // One record per server instance, so a restarted server can stop what this one tracked.
  const persist = Effect.fn("trackedAgentScope.persist")(function* () {
    const next = serialize([...sessions.values()].flatMap((session) => [...session.processes]));
    if (next === written) return;
    if (next === "") {
      yield* fileSystem.remove(record, { force: true });
    } else {
      yield* fileSystem.makeDirectory(ownersDir, { recursive: true });
      yield* fileSystem.writeFileString(`${record}.tmp`, `${process.pid}\t${ownStart}\n${next}`);
      yield* fileSystem.rename(`${record}.tmp`, record);
    }
    written = next;
  });

  const persistOrWarn = persist().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record agent processes for restart cleanup", { cause }),
    ),
  );

  /** Records what each live session has started since the last snapshot. */
  const refresh = lock.withPermits(1)(
    Effect.gen(function* () {
      const rows = yield* readTable;
      if (rows === undefined) return;
      for (const session of sessions.values()) {
        session.processes = trackedProcesses(rows, session.processes);
      }
      yield* persistOrWarn;
    }),
  );

  // A record's first line names its server. A server that still runs, such as
  // one starting up while the previous one shuts down, keeps its agents.
  const recoverLeftovers = Effect.fn("trackedAgentScope.recoverLeftovers")(function* () {
    const entries = yield* fileSystem
      .readDirectory(ownersDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const previous = entries.filter((entry) => INSTANCE_FILE.test(entry) && entry !== instance);
    if (previous.length === 0) return;
    const rows = yield* readTable;
    if (rows === undefined) return;
    for (const entry of previous) {
      const file = path.join(ownersDir, entry);
      const text = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      const [ownerLine = "", ...lines] = text.split("\n");
      const [owner] = parseRecord(ownerLine);
      if (owner !== undefined && trackedProcesses(rows, new Map([owner])).has(owner[0])) continue;
      const targets = trackedProcesses(rows, parseRecord(lines.join("\n")));
      if (targets.size > 0) {
        yield* Effect.logWarning("Stopping agent processes left by a previous server", {
          count: targets.size,
        });
        yield* terminate(targets, rows);
      }
      yield* fileSystem.remove(file, { force: true });
    }
  });

  const ready = yield* Effect.cached(
    recoverLeftovers().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not stop agent processes left by a previous server", { cause }),
      ),
    ),
  );
  yield* ready.pipe(Effect.forkIn(layerScope));

  let polling = false;
  const ensurePolling = Effect.suspend(() => {
    if (polling) return Effect.void;
    polling = true;
    return Effect.gen(function* () {
      while (sessions.size > 0) {
        yield* Effect.sleep(platform === "win32" ? WINDOWS_POLL_INTERVAL : POSIX_POLL_INTERVAL);
        yield* refresh;
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => (polling = false))),
      Effect.forkIn(layerScope),
      Effect.asVoid,
    );
  });

  const adopt: AgentScopeShape["adopt"] = Effect.fn("AgentScope.adopt")(function* (unit, pid) {
    const threadId = threadByUnit.get(unit);
    if (threadId === undefined) return;
    yield* ready;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* readTable;
        const root = rows?.find((row) => row.pid === pid);
        if (rows === undefined || root === undefined || !threadByUnit.has(unit)) return;
        sessions.set(unit, {
          threadId,
          processes: trackedProcesses(rows, new Map([[pid, root.started]])),
        });
        sessionByThread.set(threadId, unit);
        yield* persistOrWarn;
      }),
    );
    yield* ensurePolling;
  });

  // Runs when the agent exits: whatever it started and left behind is stopped.
  const stop: AgentScopeShape["stop"] = Effect.fn("AgentScope.stop")(function* (unit) {
    threadByUnit.delete(unit);
    const targets = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const session = sessions.get(unit);
        if (session === undefined) return undefined;
        sessions.delete(unit);
        if (sessionByThread.get(session.threadId) === unit)
          sessionByThread.delete(session.threadId);
        const rows = yield* readTable;
        if (rows === undefined) {
          yield* Effect.logWarning("Could not stop an exited agent's processes");
          return undefined;
        }
        return { processes: trackedProcesses(rows, session.processes), rows };
      }),
    );
    if (targets === undefined) return;
    yield* terminate(targets.processes, targets.rows);
    yield* lock.withPermits(1)(persistOrWarn);
  });

  const kill: AgentScopeShape["kill"] = Effect.fn("AgentScope.kill")(function* (threadId) {
    const unit = sessionByThread.get(threadId);
    const session = unit === undefined ? undefined : sessions.get(unit);
    if (session === undefined) return false;
    const rows = yield* readTable;
    if (rows === undefined) return false;
    return signal(trackedProcesses(rows, session.processes), rows, "SIGKILL").size > 0;
  });

  return {
    scope: {
      // Terminals and shared daemons outlive any one agent session.
      wrap: ({ command, args, name, threadId, survivesRestart, shared }) =>
        Effect.sync(() => {
          if (threadId === undefined || survivesRestart === true || shared === true) {
            return { command, args };
          }
          const unit = `t3code-${name}-${NodeCrypto.randomUUID()}`;
          threadByUnit.set(unit, threadId);
          return { command, args, unit };
        }),
      adopt,
      oomKilled: () => Effect.succeed(false),
      stop,
      kill,
      clear: (threadId) => Effect.sync(() => void sessionByThread.delete(threadId)),
    } satisfies AgentScopeShape,
    refresh,
    /** Completes once agents a previous server left are stopped. */
    ready,
  };
});
