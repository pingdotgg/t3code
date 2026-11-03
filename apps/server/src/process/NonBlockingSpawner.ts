// @effect-diagnostics nodeBuiltinImport:off - execvp's X_OK test has no Effect FileSystem equivalent.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

type SearchFailure = "ENOENT" | "EACCES";

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

// Same shape as the ENOENT/EACCES PlatformError a native spawn produces.
const spawnFailure = (command: ChildProcess.StandardCommand, code: SearchFailure) => {
  const cause = Object.assign(new Error(`spawn ${command.command} ${code}`), {
    errno: code === "ENOENT" ? -2 : -13,
    code,
    syscall: `spawn ${command.command}`,
    path: command.command,
    spawnargs: command.args.map((arg) => (Redacted.isRedacted(arg) ? "<redacted>" : arg)),
  });
  return PlatformError.systemError({
    _tag: code === "ENOENT" ? "NotFound" : "PermissionDenied",
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: CommandLine.display([command.command, ...command.args], { format: "posix" }),
    syscall: cause.syscall,
    cause,
  });
};

// GNU env passes the environment through untouched and execvp's the command.
// It reads any operand containing `=` as an assignment, even after `--`.
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

const make = Effect.gen(function* () {
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((yield* HostProcess.Platform) !== "linux") return native;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const envChdir = yield* native
    .exitCode(ChildProcess.make("/usr/bin/env", ["-C", "/", "--", "/bin/sh", "-c", ":"]))
    .pipe(
      Effect.map((code) => code === 0),
      Effect.orElseSucceed(() => false),
    );

  // At most one check runs per directory and checks of one path share it, so a
  // hung directory holds one of libuv's four threadpool threads, which also
  // compress every WebSocket frame.
  const inFlight = new Map<string, Promise<string>>();
  const queues = new Map<string, Promise<unknown>>();
  const check = (directory: string, target: string) => {
    const pending = inFlight.get(target);
    if (pending !== undefined) return pending;
    const result = (queues.get(directory) ?? Promise.resolve()).then(() => probe(target));
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
  const findExecutable = async (candidates: ReadonlyArray<readonly [string, string]>) => {
    let denied = false;
    for (const [directory, candidate] of candidates) {
      const kind = await check(directory, candidate);
      if (kind === "file") return;
      if (kind === "EACCES" || kind === "directory" || kind === "other") denied = true;
    }
    throw denied ? "EACCES" : "ENOENT";
  };

  // Resolved lexically, as the native spawner does.
  const enter = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand, cwd: string) {
    const directory = path.resolve(cwd);
    const kind = yield* Effect.promise(() => check(directory, directory));
    if (kind === "EACCES") return yield* spawnFailure(command, "EACCES");
    // The native spawner's own check, for its exact error.
    if (kind !== "directory") yield* fileSystem.access(cwd);
    return directory;
  });

  // Runs inside the NonBlockingSpawner.spawn span.
  const prepareStandard = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
    const { cwd, shell } = command.options;
    if (
      (shell !== undefined && shell !== false) ||
      command.command.length === 0 ||
      command.command.includes("\0")
    ) {
      return command;
    }
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
      try: () => findExecutable(candidates),
      catch: (code) => spawnFailure(command, code as SearchFailure),
    });
    return envChdir && !command.command.includes("=")
      ? viaEnv(command, workingDirectory)
      : viaShell(command, workingDirectory);
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
