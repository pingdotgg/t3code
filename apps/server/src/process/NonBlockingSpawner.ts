// @effect-diagnostics nodeBuiltinImport:off - execvp's X_OK test has no Effect FileSystem equivalent.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { envTrampoline, supportsEnvChdir } from "@t3tools/shared/envTrampoline";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CommandLine from "effect/process/CommandLine";

// libuv's _PATH_DEFPATH, searched when the child environment has no PATH.
const DEFAULT_PATH = "/usr/bin:/bin";

// A check on a hung mount holds a libuv threadpool thread until the mount answers, and the
// pool's four threads also compress every WebSocket frame. Checks therefore run one at a time
// per directory and two at a time overall; the rest wait without holding a thread.
const CHECK_LIMIT = 2;
const directoryTails = new Map<string, Promise<unknown>>();
const waiting: Array<() => void> = [];
let running = 0;

const access = async (path: string, mode: number) => {
  if (running < CHECK_LIMIT) running++;
  else await new Promise<void>((resume) => waiting.push(resume));
  try {
    await NodeFSP.access(path, mode);
    return undefined;
  } catch (error) {
    return error as NodeJS.ErrnoException;
  } finally {
    // A waiter takes over the slot.
    const next = waiting.shift();
    if (next === undefined) running--;
    else next();
  }
};

/** The errno error of `access(path, mode)`, or undefined when it passes. */
const check = (directory: string, path: string, mode: number) => {
  const result = (directoryTails.get(directory) ?? Promise.resolve()).then(() =>
    access(path, mode),
  );
  directoryTails.set(directory, result);
  void result.then(() => {
    if (directoryTails.get(directory) === result) directoryTails.delete(directory);
  });
  return Effect.promise(() => result);
};

// The PATH the child searches, from the environment Effect's Node spawner gives it.
const childPath = ({ env, extendEnv }: ChildProcess.CommandOptions) => {
  if (env === undefined) return process.env.PATH;
  if (!Object.hasOwn(env, "PATH")) return extendEnv === true ? process.env.PATH : undefined;
  const value = env.PATH;
  return value === undefined || !Redacted.isRedacted(value) ? value : Redacted.value(value);
};

// The spawn error Effect's Node spawner reports when execvp fails with `code`.
const spawnFailure = (command: ChildProcess.StandardCommand, code: "ENOENT" | "EACCES") => {
  const syscall = `spawn ${command.command}`;
  return PlatformError.systemError({
    _tag: code === "ENOENT" ? "NotFound" : "PermissionDenied",
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: CommandLine.display([command.command, ...command.args], { format: "posix" }),
    syscall,
    cause: Object.assign(new Error(`${syscall} ${code}`), {
      errno: code === "ENOENT" ? -2 : -13,
      code,
      syscall,
      path: command.command,
      spawnargs: command.args.map((arg) => (Redacted.isRedacted(arg) ? "<redacted>" : arg)),
    }),
  });
};

// The error of the `FileSystem.access(cwd)` Effect's Node spawner runs before it spawns.
const cwdFailure = (cwd: string, cause: NodeJS.ErrnoException) =>
  PlatformError.systemError({
    _tag:
      cause.code === "ENOENT"
        ? "NotFound"
        : cause.code === "EACCES" || cause.code === "EPERM"
          ? "PermissionDenied"
          : cause.code === "ENOTDIR" || cause.code === "ELOOP"
            ? "BadResource"
            : "Unknown",
    module: "FileSystem",
    method: "access",
    pathOrDescriptor: cwd,
    syscall: cause.syscall,
    cause,
  });

/**
 * Fails as a native spawn does when the command is missing or not executable: callers read
 * that error to tell a CLI that is not installed from one that failed. execvp reports EACCES
 * when a candidate exists but cannot be run, and ENOENT otherwise.
 */
const findExecutable = Effect.fnUntraced(function* (
  command: ChildProcess.StandardCommand,
  cwd: string | undefined,
) {
  // Joined as text: the kernel resolves `..` after a symlink differently from a normalized path.
  const fromCwd = (path: string) =>
    cwd === undefined || path.startsWith("/") ? path : `${cwd}/${path}`;
  const candidates = command.command.includes("/")
    ? [fromCwd(command.command)]
    : (childPath(command.options) ?? DEFAULT_PATH)
        .split(":")
        .map((entry) => `${fromCwd(entry || ".")}/${command.command}`);
  let denied = false;
  for (const candidate of candidates) {
    const error = yield* check(
      candidate.slice(0, candidate.lastIndexOf("/")) || "/",
      candidate,
      NodeFS.constants.X_OK,
    );
    // Any other errno is left for `env` to report through its exit code.
    if (error === undefined || (error.code !== "ENOENT" && error.code !== "EACCES")) return;
    denied ||= error.code === "EACCES";
  }
  return yield* spawnFailure(command, denied ? "EACCES" : "ENOENT");
});

const make = Effect.gen(function* () {
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((yield* HostProcess.Platform) !== "linux") return native;
  if (!(yield* Effect.promise(supportsEnvChdir))) return native;
  const path = yield* Path.Path;

  // Runs inside the NonBlockingSpawner.spawn span.
  const prepareStandard = Effect.fnUntraced(function* (input: ChildProcess.StandardCommand) {
    const { cwd: givenCwd, shell, ...options } = input.options;
    // Effect rejects a shell command with arguments, and a NUL, itself.
    if ((shell && input.args.length > 0) || input.command.includes("\0")) return input;
    // Node's shell mode on Unix, spelled out so the trampoline can run it.
    const command = shell
      ? ChildProcess.make(typeof shell === "string" ? shell : "/bin/sh", ["-c", input.command])
      : input;
    // Checked as given and entered resolved, as Effect's Node spawner does.
    const cwd = givenCwd === undefined ? undefined : path.resolve(givenCwd);
    const trampoline = envTrampoline(command.command, command.args, cwd);
    if (trampoline === undefined) return input;
    if (givenCwd !== undefined && cwd !== undefined) {
      const error = yield* check(cwd, givenCwd, NodeFS.constants.F_OK);
      if (error !== undefined) return yield* cwdFailure(givenCwd, error);
    }
    yield* findExecutable(ChildProcess.make(command.command, command.args, options), cwd);
    return ChildProcess.make(trampoline.command, trampoline.args, options);
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

/**
 * On Linux with GNU `env`, replaces the provided `ChildProcessSpawner` with one that never
 * hands libuv a cwd or a PATH search; elsewhere it passes the provided one through.
 */
export const layer = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, make);
