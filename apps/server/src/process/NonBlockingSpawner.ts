// @effect-diagnostics nodeBuiltinImport:off - execvp's X_OK test has no Effect FileSystem equivalent.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CommandLine from "effect/process/CommandLine";

// libuv blocks the parent until the forked child has run chdir(cwd) and execvp,
// so a hung mount under the cwd, PATH or the binary freezes the event loop. This
// spawner only ever execs /bin/sh natively; the shell does the chdir and search.

// libuv's _PATH_DEFPATH when the child environment has no PATH. Assigning it in
// the shell does not export it.
const DEFAULT_PATH = "/usr/bin:/bin";

type SearchFailure = "ENOENT" | "EACCES";

// Mirrors execvp's result when every candidate fails: EACCES if any candidate
// exists but cannot be executed, otherwise ENOENT.
const findExecutable = async (candidates: ReadonlyArray<string>): Promise<void> => {
  let denied = false;
  for (const candidate of candidates) {
    try {
      await NodeFSP.access(candidate, NodeFS.constants.X_OK);
      if ((await NodeFSP.stat(candidate)).isFile()) return;
      denied = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") denied = true;
    }
  }
  throw denied ? "EACCES" : "ENOENT";
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

const make = Effect.gen(function* () {
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((yield* HostProcess.Platform) !== "linux") return native;
  const fileSystem = yield* FileSystem.FileSystem;
  // Spawns of one command share the lookup in flight, so a hung directory holds
  // one threadpool thread per command rather than one per spawn or retry.
  const lookups = new Map<string, Promise<void>>();
  const lookup = (candidates: ReadonlyArray<string>) => {
    const key = candidates.join("\0");
    let pending = lookups.get(key);
    if (pending === undefined) {
      pending = findExecutable(candidates).finally(() => lookups.delete(key));
      lookups.set(key, pending);
    }
    return pending;
  };

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
    if (cwd !== undefined) yield* fileSystem.access(cwd);
    const workingDirectory = cwd === undefined ? undefined : under(process.cwd(), cwd);
    const base = workingDirectory ?? process.cwd();
    const searchPath = childPath(command.options);
    const candidates = command.command.includes("/")
      ? [under(base, command.command)]
      : (searchPath ?? DEFAULT_PATH)
          .split(":")
          .map((entry) => `${under(base, entry)}/${command.command}`);
    yield* Effect.tryPromise({
      try: () => lookup(candidates),
      catch: (code) => spawnFailure(command, code as SearchFailure),
    });
    const script = [
      searchPath === undefined ? `PATH=${DEFAULT_PATH}; ` : "",
      workingDirectory === undefined ? "" : 'cd -P -- "$1" && shift && ',
      'exec "$@"',
    ].join("");
    return ChildProcess.make(
      "/bin/sh",
      [
        "-c",
        script,
        command.command,
        ...(workingDirectory === undefined ? [] : [workingDirectory]),
        command.command,
        ...command.args,
      ],
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
