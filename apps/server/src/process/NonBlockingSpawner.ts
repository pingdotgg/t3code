// @effect-diagnostics nodeBuiltinImport:off - execvp's X_OK test has no Effect FileSystem equivalent.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CommandLine from "effect/process/CommandLine";

// libuv blocks the parent until the forked child has run chdir(cwd) and execvp,
// so a hung mount under the cwd, PATH or the binary freezes the event loop. This
// spawner only ever execs a trampoline natively, without a cwd; the trampoline
// does the chdir and the PATH search in the child.

// libuv's _PATH_DEFPATH when the child environment has no PATH.
const DEFAULT_PATH = "/usr/bin:/bin";

// errno and PlatformError tag of the spawn failures the native spawner reports.
const spawnErrors = {
  ENOENT: [-2, "NotFound"],
  EACCES: [-13, "PermissionDenied"],
  ENOTDIR: [-20, "BadResource"],
  ELOOP: [-40, "BadResource"],
} as const;
type SpawnFailure = keyof typeof spawnErrors;

// "file", "directory" or "other" when the path passes execvp's X_OK test,
// otherwise the errno code.
const probe = async (path: string): Promise<string> => {
  try {
    await NodeFSP.access(path, NodeFS.constants.X_OK);
    const stats = await NodeFSP.stat(path);
    return stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "ENOENT";
  }
};

// Same shape as the error of the native spawner's `FileSystem.access(cwd)` check.
const accessFailure = (cwd: string, code: string) =>
  PlatformError.systemError({
    _tag:
      code === "ENOENT"
        ? "NotFound"
        : code === "ENOTDIR" || code === "ELOOP"
          ? "BadResource"
          : "Unknown",
    module: "FileSystem",
    method: "access",
    pathOrDescriptor: cwd,
    syscall: "access",
    cause: Object.assign(new Error(`${code}: access '${cwd}'`), {
      code,
      syscall: "access",
      path: cwd,
    }),
  });

const unwrap = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

// The PATH the child searches, built the way Effect's Node spawner builds its env.
const childPath = (options: ChildProcess.CommandOptions): string | undefined => {
  const env = options.env;
  if (env === undefined) return process.env.PATH;
  if (Object.hasOwn(env, "PATH")) {
    const value = env.PATH;
    return value === undefined ? undefined : unwrap(value);
  }
  return options.extendEnv === true ? process.env.PATH : undefined;
};

// Joined without normalizing, so `..` after a symlink resolves as the kernel does.
const under = (base: string, entry: string) => (entry.startsWith("/") ? entry : `${base}/${entry}`);

// Same shape as the PlatformError a native spawn produces.
const spawnFailure = (command: ChildProcess.StandardCommand, code: SpawnFailure) => {
  const cause = Object.assign(new Error(`spawn ${command.command} ${code}`), {
    errno: spawnErrors[code][0],
    code,
    syscall: `spawn ${command.command}`,
    path: command.command,
    spawnargs: command.args.map((arg) => (Redacted.isRedacted(arg) ? "<redacted>" : arg)),
  });
  return PlatformError.systemError({
    _tag: spawnErrors[code][1],
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: CommandLine.display([command.command, ...command.args], { format: "posix" }),
    syscall: cause.syscall,
    cause,
  });
};

// GNU env passes the environment through untouched and execvp's the command.
// It reads any operand containing `=` as an assignment, and a lone `-` as -i, even after `--`.
const viaEnv = (command: ChildProcess.StandardCommand, cwd: string | undefined) =>
  ChildProcess.make(
    "/usr/bin/env",
    [...(cwd === undefined ? [] : ["-C", cwd]), "--", command.command, ...command.args],
    { ...command.options, cwd: undefined },
  );

// Fallback without `env -C` (busybox): dash drops environment entries whose
// names are not identifiers and sets PWD.
const viaShell = (command: ChildProcess.StandardCommand, cwd: string | undefined) => {
  const script = [
    childPath(command.options) === undefined ? `PATH=${DEFAULT_PATH}; ` : "",
    cwd === undefined ? "" : 'cd -- "$1" && shift && ',
    'exec "$@"',
  ].join("");
  return ChildProcess.make(
    "/bin/sh",
    [
      "-c",
      script,
      command.command,
      ...(cwd === undefined ? [] : [cwd]),
      command.command,
      ...command.args,
    ],
    { ...command.options, cwd: undefined },
  );
};

// Node's shell mode on Unix, made explicit so the trampoline can run it.
const shellMode = (command: ChildProcess.StandardCommand) =>
  ChildProcess.make(
    typeof command.options.shell === "string" ? command.options.shell : "/bin/sh",
    ["-c", command.command],
    { ...command.options, shell: false },
  );

const make = Effect.gen(function* () {
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((yield* HostProcess.Platform) !== "linux") return native;
  const path = yield* Path.Path;
  const envChdir = yield* native
    .exitCode(ChildProcess.make("/usr/bin/env", ["-C", "/", "--", "/bin/sh", "-c", ":"]))
    .pipe(
      Effect.map((code) => code === 0),
      Effect.orElseSucceed(() => false),
    );

  // At most one check runs per directory, checks of one path share it, and at
  // most two run at once, so hung mounts never hold more than two of libuv's
  // four threadpool threads, which also compress every WebSocket frame.
  const inFlight = new Map<string, Promise<string>>();
  const queues = new Map<string, Promise<unknown>>();
  const waiting: Array<() => void> = [];
  let probing = 0;
  const limitedProbe = async (target: string) => {
    if (probing < 2) probing++;
    else await new Promise<void>((resume) => waiting.push(resume));
    try {
      return await probe(target);
    } finally {
      // A waiter inherits the slot.
      const next = waiting.shift();
      if (next === undefined) probing--;
      else next();
    }
  };
  const check = (directory: string, target: string) => {
    const pending = inFlight.get(target);
    if (pending !== undefined) return pending;
    const result = (queues.get(directory) ?? Promise.resolve()).then(() => limitedProbe(target));
    queues.set(directory, result);
    inFlight.set(target, result);
    void result.then(() => {
      inFlight.delete(target);
      if (queues.get(directory) === result) queues.delete(directory);
    });
    return result;
  };

  // Mirrors execvp's result when every candidate fails: EACCES if any candidate
  // exists but cannot be executed, otherwise ENOENT.
  // An explicit path fails with its own errno, as execve reports it.
  const findExecutable = async (
    candidates: ReadonlyArray<readonly [string, string]>,
    explicit: boolean,
  ) => {
    let denied = false;
    for (const [directory, candidate] of candidates) {
      const kind = await check(directory, candidate);
      if (kind === "file") return;
      if (explicit && (kind === "ENOTDIR" || kind === "ELOOP")) throw kind;
      if (kind === "EACCES" || kind === "directory" || kind === "other") denied = true;
    }
    throw denied ? "EACCES" : "ENOENT";
  };

  // Checked as given and entered resolved lexically, as the native spawner does.
  const enter = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand, cwd: string) {
    const directory = path.resolve(cwd);
    const kind = yield* Effect.promise(() => check(directory, cwd));
    if (kind === "directory") return directory;
    if (kind === "EACCES") return yield* spawnFailure(command, "EACCES");
    if (kind === "file" || kind === "other") return yield* spawnFailure(command, "ENOTDIR");
    return yield* accessFailure(cwd, kind);
  });

  // Runs inside the NonBlockingSpawner.spawn span.
  const prepareStandard = Effect.fnUntraced(function* (input: ChildProcess.StandardCommand) {
    // Effect itself rejects shell mode with arguments.
    if (input.options.shell && input.args.length > 0) return input;
    const command = input.options.shell ? shellMode(input) : input;
    const { cwd } = command.options;
    if (command.command.length === 0 || command.command.includes("\0")) return command;
    // env misreads these even after `--`, and dash would drop exported bash functions.
    if (command.command === "-" || command.command.includes("=")) return command;
    const workingDirectory = cwd === undefined ? undefined : yield* enter(command, cwd);
    const base = workingDirectory ?? process.cwd();
    const explicit = under(base, command.command);
    const candidates = command.command.includes("/")
      ? [[explicit.slice(0, explicit.lastIndexOf("/")) || "/", explicit] as const]
      : (childPath(command.options) ?? DEFAULT_PATH).split(":").map((entry) => {
          const directory = under(base, entry);
          return [directory, `${directory}/${command.command}`] as const;
        });
    yield* Effect.tryPromise({
      try: () => findExecutable(candidates, command.command.includes("/")),
      catch: (code) => spawnFailure(command, code as SpawnFailure),
    });
    return envChdir ? viaEnv(command, workingDirectory) : viaShell(command, workingDirectory);
  });

  const prepare = (
    command: ChildProcess.Command,
  ): Effect.Effect<ChildProcess.Command, PlatformError.PlatformError> =>
    command._tag === "StandardCommand"
      ? prepareStandard(command)
      : Effect.map(Effect.all([prepare(command.left), prepare(command.right)]), ([left, right]) =>
          ChildProcess.pipeTo(left, right, command.options),
        );

  return ChildProcessSpawner.make(
    Effect.fn("NonBlockingSpawner.spawn")(function* (command) {
      return yield* native.spawn(yield* prepare(command));
    }),
  );
});

/** Replaces the provided `ChildProcessSpawner` on Linux; elsewhere it passes it through. */
export const layer = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, make);
