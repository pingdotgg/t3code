// @effect-diagnostics nodeBuiltinImport:off - execvp's X_OK test has no Effect FileSystem equivalent.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CommandLine from "effect/process/CommandLine";

// libuv blocks the parent until the forked child has run chdir(cwd) and the
// execvp PATH search, so a hung mount on either freezes the event loop. This
// spawner resolves the command off the loop and moves chdir past the exec.

const CHDIR_TRAMPOLINE = 'cd -- "$1" && shift && exec "$@"';
// libuv's _PATH_DEFPATH when the child environment has no PATH.
const DEFAULT_PATH = "/usr/bin:/bin";
// Matches the shared PATH resolver's hit lifetime. Misses are never kept: a failed
// spawn is how providers report "not installed", and that must clear on install.
const RESOLUTION_TTL = Duration.seconds(30);
const KEY_SEPARATOR = "\0";

type SearchFailure = "ENOENT" | "EACCES";

// Mirrors libuv's execvpe: skip candidates that are missing or not executable, and
// report EACCES over ENOENT when a non-executable candidate was seen.
const searchPath = (key: string): Effect.Effect<string, SearchFailure> =>
  Effect.tryPromise({
    try: async () => {
      const [command, ...directories] = key.split(KEY_SEPARATOR);
      let denied = false;
      for (const directory of directories) {
        const candidate = `${directory}/${command}`;
        try {
          await NodeFSP.access(candidate, NodeFS.constants.X_OK);
          if ((await NodeFSP.stat(candidate)).isFile()) return candidate;
          denied = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EACCES") denied = true;
        }
      }
      throw denied ? "EACCES" : "ENOENT";
    },
    catch: (failure) => failure as SearchFailure,
  });

const unwrap = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

// The PATH libuv searches is the child's, built the way Effect's Node spawner builds it.
const childPath = (options: ChildProcess.CommandOptions): string | undefined => {
  const env = options.env;
  if (env === undefined) return process.env.PATH;
  if (Object.hasOwn(env, "PATH")) {
    const value = env.PATH;
    return value === undefined ? undefined : unwrap(value);
  }
  return options.extendEnv === true ? process.env.PATH : undefined;
};

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

const make = Effect.gen(function* () {
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((yield* HostProcess.Platform) !== "linux") return native;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Concurrent spawns of one command share a lookup, so a hung PATH entry holds
  // one threadpool thread per command rather than one per spawn.
  const resolutions = yield* Cache.makeWith(searchPath, {
    capacity: 512,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? RESOLUTION_TTL : Duration.zero),
  });

  // Runs inside the NonBlockingSpawner.spawn span.
  const prepareStandard = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
    const { cwd, shell } = command.options;
    const explicitPath = command.command.includes("/");
    if (
      (shell !== undefined && shell !== false) ||
      command.command.length === 0 ||
      command.command.includes("\0") ||
      (explicitPath && cwd === undefined)
    ) {
      return command;
    }
    let workingDirectory: string | undefined;
    if (cwd !== undefined) {
      yield* fileSystem.access(cwd);
      workingDirectory = path.resolve(cwd);
    }
    let executable = command.command;
    if (!explicitPath) {
      const base = workingDirectory ?? process.cwd();
      // An empty PATH entry means the child's working directory, as in execvp.
      const directories = (childPath(command.options) ?? DEFAULT_PATH)
        .split(":")
        .map((entry) => path.resolve(base, entry));
      executable = yield* Cache.get(
        resolutions,
        [command.command, ...directories].join(KEY_SEPARATOR),
      ).pipe(Effect.mapError((code) => spawnFailure(command, code)));
    }
    if (workingDirectory === undefined) {
      return ChildProcess.make(executable, command.args, command.options);
    }
    return ChildProcess.make(
      "/bin/sh",
      ["-c", CHDIR_TRAMPOLINE, command.command, workingDirectory, executable, ...command.args],
      { ...command.options, cwd: undefined },
    );
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
