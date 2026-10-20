import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/**
 * The relay client is a plain child of the server, stopped only by a scope
 * finalizer. A server that dies without running finalizers (SIGKILL, a crash,
 * an OOM kill) leaves it running under init/launchd, still serving the tunnel
 * with the token it started with, and the next server starts a second one.
 * Each started client is recorded here so the next server can stop it.
 *
 * Same identity rules as OpenCodeServerLedger: only a process whose pid,
 * start time and full command line still match the record is signalled, and
 * only after the server that started it is gone.
 */
const ProcessIdentity = Schema.Struct({ pid: Schema.Int, startTime: Schema.String });
type ProcessIdentity = typeof ProcessIdentity.Type;

const RelayClientEntry = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  startTime: Schema.String,
  command: Schema.String,
  stateDir: Schema.String,
  owner: ProcessIdentity,
});
type RelayClientEntry = typeof RelayClientEntry.Type;
const RelayClientEntryJson = Schema.fromJsonString(RelayClientEntry);
const decodeEntry = Schema.decodeUnknownOption(RelayClientEntryJson);
const encodeEntry = Schema.encodeEffect(RelayClientEntryJson);

export class RelayClientLedger extends Context.Service<
  RelayClientLedger,
  {
    /** Records a started relay client; the returned effect forgets it. */
    readonly track: (client: { readonly pid: number }) => Effect.Effect<Effect.Effect<void>>;
  }
>()("t3/cloud/RelayClientLedger") {}

const ENTRY_DIRECTORY = "relay-clients";
const ENTRY_FILE = /^\d+\.json$/;
const STOP_POLL_INTERVAL = "50 millis";
const STOP_POLL_ATTEMPTS = 40;

interface ObservedProcess {
  readonly pid: number;
  readonly startTime: string;
  readonly command: string;
  readonly zombie: boolean;
}

// `ps -o lstart` prints e.g. `Sat Sep  6 20:51:57 2026`; C locale and UTC keep it stable.
const DARWIN_PS_LINE = /^\s*(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
};

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch {}
};

export const make = Effect.fn("RelayClientLedger.make")(function* (input: {
  readonly stateDir: string;
  readonly ownerPid?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const directory = path.join(input.stateDir, ENTRY_DIRECTORY);
  const recordable = platform === "linux" || platform === "darwin";

  const observeLinux = (pid: number) =>
    Effect.gen(function* () {
      const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      if (startTime === undefined) return undefined;
      const cmdline = yield* fs.readFileString(`/proc/${pid}/cmdline`);
      return {
        pid,
        startTime,
        command: cmdline.replace(/\0$/, "").replaceAll("\0", " "),
        zombie: fields[0] === "Z",
      } satisfies ObservedProcess;
    });

  const observeDarwin = (pid: number) =>
    spawner
      .string(
        ChildProcess.make("/bin/ps", ["-ww", "-o", "pid=,stat=,lstart=,args=", "-p", String(pid)], {
          env: { LC_ALL: "C", TZ: "UTC" },
          extendEnv: true,
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.timeout("5 seconds"),
        Effect.map((output) =>
          output.split("\n").flatMap((line): ReadonlyArray<ObservedProcess> => {
            const match = DARWIN_PS_LINE.exec(line);
            if (match === null || Number(match[1]) !== pid) return [];
            return [
              {
                pid,
                zombie: match[2]!.startsWith("Z"),
                startTime: match[3]!,
                command: match[4]!.trimEnd(),
              },
            ];
          }),
        ),
        Effect.map((found) => found[0]),
      );

  const observe = (pid: number): Effect.Effect<ObservedProcess | undefined> => {
    if (platform === "linux") return observeLinux(pid).pipe(Effect.orElseSucceed(() => undefined));
    if (platform === "darwin") {
      return observeDarwin(pid).pipe(Effect.orElseSucceed(() => undefined));
    }
    return Effect.succeed(undefined);
  };

  const sameProcess = (
    observed: ObservedProcess | undefined,
    identity: { readonly startTime: string; readonly command?: string },
  ) =>
    observed !== undefined &&
    !observed.zombie &&
    observed.startTime === identity.startTime &&
    (identity.command === undefined || observed.command === identity.command);

  const ownerPid = input.ownerPid ?? process.pid;
  const ownerProcess = yield* observe(ownerPid);
  const owner =
    ownerProcess === undefined ? undefined : { pid: ownerPid, startTime: ownerProcess.startTime };

  const track: RelayClientLedger["Service"]["track"] = (client) =>
    Effect.gen(function* () {
      if (!recordable) return Effect.void;
      const observed = yield* observe(client.pid);
      if (owner === undefined || observed === undefined || observed.zombie) {
        yield* Effect.logWarning(
          "Could not record the relay client; it will keep running if this server crashes",
          { pid: client.pid },
        );
        return Effect.void;
      }
      const entryPath = path.join(directory, `${client.pid}.json`);
      const entry: RelayClientEntry = {
        version: 1,
        pid: observed.pid,
        startTime: observed.startTime,
        command: observed.command,
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
            Effect.logWarning("Could not forget a stopped relay client", { cause }),
          ),
        );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record the relay client process", { cause }).pipe(
          Effect.as(Effect.void),
        ),
      ),
    );

  // SIGTERM lets cloudflared close its edge connections; SIGKILL only if the
  // same process (not a recycled pid) is still there afterwards.
  const stopOrphan = (entry: RelayClientEntry) =>
    Effect.gen(function* () {
      if (!sameProcess(yield* observe(entry.pid), entry)) return;
      yield* Effect.logInfo("Stopping a relay client left by a previous T3 Code server", {
        pid: entry.pid,
      });
      signal(entry.pid, "SIGTERM");
      for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS && processExists(entry.pid); attempt++) {
        yield* Effect.sleep(STOP_POLL_INTERVAL);
      }
      if (sameProcess(yield* observe(entry.pid), entry)) signal(entry.pid, "SIGKILL");
    });

  const reapEntry = (entryPath: string) =>
    Effect.gen(function* () {
      const entry = decodeEntry(yield* fs.readFileString(entryPath));
      if (Option.isSome(entry) && entry.value.stateDir === input.stateDir) {
        if (sameProcess(yield* observe(entry.value.owner.pid), entry.value.owner)) return;
        yield* stopOrphan(entry.value);
      }
      yield* fs.remove(entryPath, { force: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not clean up a recorded relay client", { entryPath, cause }),
      ),
    );

  const reapOrphans = Effect.gen(function* () {
    if (!recordable) return;
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      names.filter((name) => ENTRY_FILE.test(name)),
      (name) => reapEntry(path.join(directory, name)),
      { concurrency: "unbounded", discard: true },
    );
  });

  return { track, reapOrphans };
});

export const layer = (input: { readonly stateDir: string }) =>
  Layer.effect(
    RelayClientLedger,
    Effect.gen(function* () {
      const ledger = yield* make(input);
      yield* ledger.reapOrphans.pipe(Effect.forkScoped);
      return RelayClientLedger.of({ track: ledger.track });
    }),
  );

export const layerTest = Layer.succeed(
  RelayClientLedger,
  RelayClientLedger.of({ track: () => Effect.succeed(Effect.void) }),
);
