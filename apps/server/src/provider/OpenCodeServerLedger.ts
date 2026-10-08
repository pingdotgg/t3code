import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { signalProcessGroup } from "../process/processGroup.ts";

const ProcessIdentity = Schema.Struct({ pid: Schema.Int, startTime: Schema.String });
type ProcessIdentity = typeof ProcessIdentity.Type;

const OpenCodeServerEntry = Schema.Struct({
  version: Schema.Literal(1),
  /** The spawned group. Its id is the pid T3 spawned, which also names the entry file. */
  pgid: Schema.Int,
  /**
   * A group member seen at spawn: the spawned process, or a process it left in
   * the group if it had already exited. Its pid, start time, and command line
   * must all still match before the group is signalled.
   */
  pid: Schema.Int,
  /** Linux `/proc/<pid>/stat` start ticks, or macOS `ps` lstart (whole seconds). */
  startTime: Schema.String,
  command: Schema.String,
  port: Schema.Int,
  /** Entries copied along with a state directory are dropped, never acted on. */
  stateDir: Schema.String,
  /** The T3 server that spawned it. Entries of a live owner are never touched. */
  owner: ProcessIdentity,
});
type OpenCodeServerEntry = typeof OpenCodeServerEntry.Type;
const OpenCodeServerEntryJson = Schema.fromJsonString(OpenCodeServerEntry);
const decodeEntry = Schema.decodeUnknownOption(OpenCodeServerEntryJson);
const encodeEntry = Schema.encodeEffect(OpenCodeServerEntryJson);

/**
 * Local `opencode serve` processes run in their own process group so T3 can
 * stop the whole group, which also means they outlive a T3 server that is
 * SIGKILLed or crashes. Each spawn is recorded under the state directory and
 * removed on a graceful stop; the next server start stops whatever a dead
 * server left behind.
 */
export class OpenCodeServerLedger extends Context.Service<
  OpenCodeServerLedger,
  {
    /** Records a spawned server group and returns the effect that forgets it after a graceful stop. */
    readonly track: (server: {
      readonly pid: number;
      readonly port: number;
      /** The argv after the binary, e.g. `["serve", "--hostname=127.0.0.1", "--port=4096"]`. */
      readonly args: ReadonlyArray<string>;
    }) => Effect.Effect<Effect.Effect<void>>;
  }
>()("t3/provider/OpenCodeServerLedger") {}

const ENTRY_DIRECTORY = "opencode-servers";
const ENTRY_FILE = /^\d+\.json$/;
const STOP_POLL_INTERVAL = "50 millis";
const STOP_POLL_ATTEMPTS = 40;

interface ObservedProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly command: string;
  readonly zombie: boolean;
}

// `ps -o lstart` prints e.g. `Sat Sep  6 20:51:57 2026`; C locale and UTC keep it stable.
const DARWIN_PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

const parseDarwinPs = (output: string): ReadonlyArray<ObservedProcess> =>
  output.split("\n").flatMap((line) => {
    const match = DARWIN_PS_LINE.exec(line);
    if (match === null) return [];
    return [
      {
        pid: Number(match[1]),
        pgid: Number(match[2]),
        zombie: match[3]!.startsWith("Z"),
        startTime: match[4]!,
        command: match[5]!.trimEnd(),
      },
    ];
  });

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  try {
    signalProcessGroup(pgid, signal);
  } catch {
    // The group may already be gone.
  }
};

const groupExists = (pgid: number) => {
  try {
    signalProcessGroup(pgid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
};

/**
 * Builds a ledger for one state directory. `ownerPid` is the T3 server that
 * owns the servers it tracks; it defaults to this process.
 */
export const make = Effect.fn("OpenCodeServerLedger.make")(function* (input: {
  readonly stateDir: string;
  readonly ownerPid?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const directory = path.join(input.stateDir, ENTRY_DIRECTORY);
  // Windows servers are not detached and are never recorded.
  const recordable = platform === "linux" || platform === "darwin";

  /** Observes `pid`, or nothing when it is not in `group` (if given). */
  const observeLinux = (pid: number, group?: number) =>
    Effect.gen(function* () {
      const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
      // After the parenthesized comm: state, ppid, pgrp, session, … starttime (index 19).
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const pgid = Number(fields[2]);
      const startTime = fields[19];
      if (!Number.isSafeInteger(pgid) || startTime === undefined) return undefined;
      if (group !== undefined && pgid !== group) return undefined;
      const cmdline = yield* fs.readFileString(`/proc/${pid}/cmdline`);
      return {
        pid,
        pgid,
        startTime,
        command: cmdline.replace(/\0$/, "").replaceAll("\0", " "),
        zombie: fields[0] === "Z",
      } satisfies ObservedProcess;
    });

  const psDarwin = (selection: ReadonlyArray<string>) =>
    spawner
      .string(
        ChildProcess.make(
          "/bin/ps",
          ["-ww", "-o", "pid=,pgid=,stat=,lstart=,args=", ...selection],
          {
            env: { LC_ALL: "C", TZ: "UTC" },
            extendEnv: true,
            stdin: "ignore",
            stderr: "ignore",
          },
        ),
      )
      .pipe(Effect.timeout("5 seconds"), Effect.map(parseDarwinPs));

  const observe = (pid: number): Effect.Effect<ObservedProcess | undefined> => {
    if (platform === "linux") return observeLinux(pid).pipe(Effect.orElseSucceed(() => undefined));
    if (platform === "darwin") {
      return psDarwin(["-p", String(pid)]).pipe(
        Effect.map((found) => found.find((candidate) => candidate.pid === pid)),
        Effect.orElseSucceed(() => undefined),
      );
    }
    return Effect.succeed(undefined);
  };

  // Scans every process, so it is only used when the spawned process is gone.
  const observeGroup = (pgid: number): Effect.Effect<ReadonlyArray<ObservedProcess>> => {
    if (platform === "linux") {
      return fs.readDirectory("/proc").pipe(
        Effect.flatMap((names) =>
          Effect.forEach(
            names.filter((name) => /^\d+$/.test(name)),
            (name) => observeLinux(Number(name), pgid).pipe(Effect.orElseSucceed(() => undefined)),
            { concurrency: 16 },
          ),
        ),
        Effect.map((found) => found.filter((candidate) => candidate !== undefined)),
        Effect.orElseSucceed(() => []),
      );
    }
    if (platform === "darwin") {
      return psDarwin(["-A"]).pipe(
        Effect.map((found) => found.filter((candidate) => candidate.pgid === pgid)),
        Effect.orElseSucceed(() => []),
      );
    }
    return Effect.succeed([]);
  };

  const isRunning = (identity: ProcessIdentity) =>
    observe(identity.pid).pipe(
      Effect.map(
        (observed) =>
          observed !== undefined && !observed.zombie && observed.startTime === identity.startTime,
      ),
    );

  const ownerPid = input.ownerPid ?? process.pid;
  const ownerProcess = yield* observe(ownerPid);
  const owner =
    ownerProcess === undefined ? undefined : { pid: ownerPid, startTime: ownerProcess.startTime };

  const track: OpenCodeServerLedger["Service"]["track"] = (server) =>
    Effect.gen(function* () {
      if (!recordable) return Effect.void;
      const pgid = server.pid;
      // The spawned process leads the group. If it already exited (a wrapper
      // that left the server running), any live member identifies the group:
      // a group id is not reused while the group has members.
      const leader = yield* observe(pgid);
      const members =
        leader !== undefined && !leader.zombie && leader.pgid === pgid
          ? [leader]
          : (yield* observeGroup(pgid)).filter((candidate) => !candidate.zombie);
      const member =
        members.find((candidate) => candidate.command.endsWith(` ${server.args.join(" ")}`)) ??
        members[0];
      if (owner === undefined || member === undefined) {
        if (groupExists(pgid)) {
          yield* Effect.logWarning(
            "Could not record an OpenCode server; it will keep running if this server crashes",
            { pid: pgid, port: server.port },
          );
        }
        return Effect.void;
      }
      const entryPath = path.join(directory, `${pgid}.json`);
      const entry: OpenCodeServerEntry = {
        version: 1,
        pgid,
        pid: member.pid,
        startTime: member.startTime,
        command: member.command,
        port: server.port,
        stateDir: input.stateDir,
        owner,
      };
      yield* writeFileStringAtomically({
        filePath: entryPath,
        contents: yield* encodeEntry(entry),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return fs
        .remove(entryPath, { force: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not forget a stopped OpenCode server", { cause }),
          ),
        );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record an OpenCode server process", { cause }).pipe(
          Effect.as(Effect.void),
        ),
      ),
    );

  // Signals only a group whose recorded member still has the same pid, start
  // time, group, and full command line, so a recycled pid is never touched.
  const stopOrphan = (entry: OpenCodeServerEntry) =>
    Effect.gen(function* () {
      const observed = yield* observe(entry.pid);
      if (
        observed === undefined ||
        observed.zombie ||
        observed.startTime !== entry.startTime ||
        observed.pgid !== entry.pgid ||
        observed.command !== entry.command
      ) {
        return;
      }
      yield* Effect.logInfo("Stopping an OpenCode server left by a previous T3 Code server", {
        pid: entry.pgid,
        port: entry.port,
      });
      signalGroup(entry.pgid, "SIGTERM");
      for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS && groupExists(entry.pgid); attempt++) {
        yield* Effect.sleep(STOP_POLL_INTERVAL);
      }
      // The group never emptied, so its pgid cannot have been reused.
      if (groupExists(entry.pgid)) signalGroup(entry.pgid, "SIGKILL");
    });

  const reapEntry = (entryPath: string) =>
    Effect.gen(function* () {
      const entry = decodeEntry(yield* fs.readFileString(entryPath));
      if (Option.isSome(entry) && entry.value.stateDir === input.stateDir) {
        if (yield* isRunning(entry.value.owner)) return;
        yield* stopOrphan(entry.value);
      }
      yield* fs.remove(entryPath, { force: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not clean up a recorded OpenCode server", { entryPath, cause }),
      ),
    );

  /** Stops recorded servers whose owning T3 server is gone and drops stale entries. */
  const reapOrphans = Effect.gen(function* () {
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      names.filter((name) => ENTRY_FILE.test(name)),
      (name) => reapEntry(path.join(directory, name)),
      { concurrency: "unbounded", discard: true },
    );
  });

  return { track, reapOrphans };
});

export const layer = Layer.effect(
  OpenCodeServerLedger,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const ledger = yield* make({ stateDir: config.stateDir });
    // Reaping waits for orphans to exit, so it must not hold up startup.
    yield* ledger.reapOrphans.pipe(Effect.forkScoped);
    return OpenCodeServerLedger.of({ track: ledger.track });
  }),
);

/** Records nothing. For tests that start OpenCode servers without a state directory. */
export const layerTest = Layer.succeed(
  OpenCodeServerLedger,
  OpenCodeServerLedger.of({ track: () => Effect.succeed(Effect.void) }),
);
