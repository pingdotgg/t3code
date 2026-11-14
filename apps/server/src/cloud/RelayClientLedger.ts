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

const ProcessIdentity = Schema.Struct({
  pid: Schema.Int,
  startTime: Schema.String,
  command: Schema.optional(Schema.String),
});
type ProcessIdentity = typeof ProcessIdentity.Type;

const RelayClientEntry = Schema.Struct({
  version: Schema.Literal(1),
  client: ProcessIdentity,
  // A process may rewrite its own argv, so the owner is identified by pid and start time.
  owner: ProcessIdentity,
});
type RelayClientEntry = typeof RelayClientEntry.Type;
const RelayClientEntryJson = Schema.fromJsonString(RelayClientEntry);
const decodeEntry = Schema.decodeUnknownOption(RelayClientEntryJson);
const encodeEntry = Schema.encodeEffect(RelayClientEntryJson);

/** Remembers running relay clients so a server can stop the ones a crashed server left behind. */
export class RelayClientLedger extends Context.Service<
  RelayClientLedger,
  {
    /** Records a started relay client; the returned effect forgets it once it has stopped. */
    readonly track: (pid: number) => Effect.Effect<Effect.Effect<void>>;
  }
>()("t3/cloud/RelayClientLedger") {}

const ENTRY_DIRECTORY = "relay-clients";
const ENTRY_FILE = /^\d+\.json$/;
const STOP_POLL_INTERVAL = "50 millis";
const STOP_POLL_ATTEMPTS = 40;

interface ObservedProcess {
  readonly startTime: string;
  readonly command: string;
  readonly zombie: boolean;
}

// ps lstart needs C locale and UTC for stable parsing.
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

  const observeLinux = Effect.fnUntraced(function* (pid: number) {
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    if (startTime === undefined) return undefined;
    const cmdline = yield* fs.readFileString(`/proc/${pid}/cmdline`);
    return {
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
        Effect.map((output) => {
          for (const line of output.split("\n")) {
            const match = DARWIN_PS_LINE.exec(line);
            if (match === null || Number(match[1]) !== pid) continue;
            return {
              zombie: match[2]!.startsWith("Z"),
              startTime: match[3]!,
              command: match[4]!.trimEnd(),
            } satisfies ObservedProcess;
          }
          return undefined;
        }),
      );

  const observe = (pid: number): Effect.Effect<ObservedProcess | undefined> => {
    if (platform === "linux") return observeLinux(pid).pipe(Effect.orElseSucceed(() => undefined));
    if (platform === "darwin")
      return observeDarwin(pid).pipe(Effect.orElseSucceed(() => undefined));
    return Effect.undefined;
  };

  // "unknown" means the pid exists but could not be read, so nothing may be concluded about it.
  const compare = (identity: ProcessIdentity) =>
    observe(identity.pid).pipe(
      Effect.map((observed): "same" | "gone" | "unknown" => {
        if (observed === undefined) return processExists(identity.pid) ? "unknown" : "gone";
        return !observed.zombie &&
          observed.startTime === identity.startTime &&
          (identity.command === undefined || observed.command === identity.command)
          ? "same"
          : "gone";
      }),
    );

  const identify = (pid: number) =>
    observe(pid).pipe(
      Effect.map((observed) =>
        observed === undefined || observed.zombie
          ? undefined
          : { pid, startTime: observed.startTime, command: observed.command },
      ),
    );

  const ownerProcess = yield* identify(input.ownerPid ?? process.pid);
  const owner =
    ownerProcess === undefined
      ? undefined
      : { pid: ownerProcess.pid, startTime: ownerProcess.startTime };

  const track: RelayClientLedger["Service"]["track"] = Effect.fn("RelayClientLedger.track")(
    function* (pid) {
      if (!recordable) return Effect.void;
      const client = yield* identify(pid);
      if (owner === undefined || client?.command === undefined) {
        yield* Effect.logWarning(
          "Could not record the relay client; it will keep running if this server crashes",
          { pid },
        );
        return Effect.void;
      }
      const entryPath = path.join(directory, `${pid}.json`);
      yield* writeFileStringAtomically({
        filePath: entryPath,
        contents: yield* encodeEntry({ version: 1, client, owner }),
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
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record the relay client", { cause }).pipe(
        Effect.as(Effect.void),
      ),
    ),
  );

  // Signals only a process that still has the recorded pid, start time and command line,
  // so a recycled pid is never touched. Returns whether the client is gone.
  const stopOrphan = Effect.fn("RelayClientLedger.stopOrphan")(function* (client: ProcessIdentity) {
    let state = yield* compare(client);
    if (state !== "same") return state === "gone";
    yield* Effect.logInfo("Stopping a relay client left by a previous T3 Code server", {
      pid: client.pid,
    });
    for (const name of ["SIGTERM", "SIGKILL"] as const) {
      signal(client.pid, name);
      for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS && state === "same"; attempt++) {
        yield* Effect.sleep(STOP_POLL_INTERVAL);
        state = yield* compare(client);
      }
      if (state !== "same") break;
    }
    return state === "gone";
  });

  const reapEntry = Effect.fn("RelayClientLedger.reapEntry")(
    function* (entryPath: string) {
      const entry = decodeEntry(yield* fs.readFileString(entryPath));
      if (Option.isSome(entry)) {
        if ((yield* compare(entry.value.owner)) !== "gone") return;
        if (!(yield* stopOrphan(entry.value.client))) return;
      }
      yield* fs.remove(entryPath, { force: true });
    },
    (effect, entryPath) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not clean up a recorded relay client", { entryPath, cause }),
        ),
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

// Reaping finishes before any connector starts, so exactly one serves the tunnel.
export const layer = (input: { readonly stateDir: string }) =>
  Layer.effect(
    RelayClientLedger,
    Effect.gen(function* () {
      const ledger = yield* make(input);
      yield* ledger.reapOrphans;
      return RelayClientLedger.of({ track: ledger.track });
    }),
  );

export const layerTest = Layer.succeed(
  RelayClientLedger,
  RelayClientLedger.of({
    track: Effect.fn("RelayClientLedger.track")(function () {
      return Effect.succeed(Effect.void);
    }),
  }),
);
