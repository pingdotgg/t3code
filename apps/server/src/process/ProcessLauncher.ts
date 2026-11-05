// @effect-diagnostics nodeBuiltinImport:off - IPC and signal callbacks implement the spawner boundary, as in the native spawner.
import * as NodeChildProcess from "node:child_process";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CommandLine from "effect/process/CommandLine";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type {
  LauncherEvent,
  LauncherRequest,
  LauncherSpawnFailure,
} from "./processLauncherWorker.ts";

type ExitStatus = readonly [code: number | null, signal: NodeJS.Signals | null];

class LauncherUnavailable extends Schema.TaggedError<LauncherUnavailable>()(
  "LauncherUnavailable",
  {},
) {}

interface HostedChild {
  readonly command: ChildProcess.StandardCommand;
  readonly started: Deferred.Deferred<number, PlatformError.PlatformError | LauncherUnavailable>;
  readonly exited: Deferred.Deferred<ExitStatus>;
  readonly stdout: Queue.Queue<Uint8Array, Cause.Done>;
  readonly stderr: Queue.Queue<Uint8Array, Cause.Done>;
  pid: number | undefined;
  /** Exit plus both output streams; the entry is dropped once all three arrive. */
  pending: number;
}

interface Launcher {
  readonly worker: NodeChildProcess.ChildProcess;
  readonly children: Map<number, HostedChild>;
  ready: boolean;
  closed: boolean;
}

const errnoReason = (code: string | undefined): PlatformError.SystemErrorTag => {
  switch (code) {
    case "ENOENT":
      return "NotFound";
    case "EACCES":
    case "EPERM":
      return "PermissionDenied";
    case "EEXIST":
      return "AlreadyExists";
    case "EISDIR":
    case "ENOTDIR":
    case "ELOOP":
      return "BadResource";
    case "EBUSY":
      return "Busy";
    default:
      return "Unknown";
  }
};

const displayCommand = (command: ChildProcess.StandardCommand) =>
  CommandLine.display([command.command, ...command.args]);

// Same shape as the native spawner's errors, so callers keep matching on `reason._tag`.
const toPlatformError = (
  command: ChildProcess.StandardCommand,
  method: string,
  cause: Partial<NodeJS.ErrnoException>,
) =>
  PlatformError.systemError({
    _tag: errnoReason(cause.code),
    module: "ChildProcess",
    method,
    pathOrDescriptor: displayCommand(command),
    syscall: cause.syscall,
    cause,
  });

const toSpawnFailure = (command: ChildProcess.StandardCommand, failure: LauncherSpawnFailure) => {
  const cause = Object.assign(new Error(failure.message), {
    code: failure.code,
    errno: failure.errno,
    syscall: failure.syscall,
    path: failure.path,
  });
  return failure.method === "access"
    ? PlatformError.systemError({
        _tag: errnoReason(failure.code),
        module: "FileSystem",
        method: "access",
        pathOrDescriptor: failure.path,
        syscall: failure.syscall,
        cause,
      })
    : toPlatformError(command, "spawn", cause);
};

const resolveEnvironment = (options: ChildProcess.CommandOptions): NodeJS.ProcessEnv => {
  if (options.env === undefined) return process.env;
  const env: NodeJS.ProcessEnv = options.extendEnv === true ? { ...process.env } : {};
  for (const [key, value] of Object.entries(options.env)) {
    if (value === undefined) delete env[key];
    else env[key] = Redacted.isRedacted(value) ? Redacted.value(value) : value;
  }
  return env;
};

const launcherArguments = Effect.fn("ProcessLauncher.launcherArguments")(function* () {
  // A single executable has no sibling script, so it hosts the launcher as a hidden subcommand.
  if (yield* HostProcess.IsExecutable) return ["__process-launcher"];
  const path = yield* Path.Path;
  const fromSource = import.meta.url.endsWith(".ts");
  return [
    ...(fromSource ? ["--experimental-strip-types"] : []),
    yield* path
      .fromFileUrl(
        new URL(fromSource ? "../process-launcher.ts" : "./process-launcher.mjs", import.meta.url),
      )
      .pipe(Effect.orDie),
  ];
});

// On Linux, libuv forks the whole server for every spawn and blocks the event loop while the
// kernel copies its page tables, so commands are launched by a small long-lived helper instead.
const make = Effect.fn("ProcessLauncher.make")(function* () {
  const fallback = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((yield* HostProcess.Platform) !== "linux") return fallback;

  const path = yield* Path.Path;
  const executablePath = yield* HostProcess.ExecutablePath;
  const args = yield* launcherArguments();
  let current: Launcher | undefined;
  // A launcher that never starts will not start next time either; stop forking for it.
  let unavailable = false;
  let nextId = 0;

  const syncRef = (launcher: Launcher) => {
    if (launcher.children.size > 0) launcher.worker.channel?.ref();
    else launcher.worker.channel?.unref();
  };

  const settle = (launcher: Launcher, id: number, child: HostedChild) => {
    child.pending -= 1;
    if (child.pending > 0) return;
    launcher.children.delete(id);
    syncRef(launcher);
  };

  const close = (launcher: Launcher) => {
    if (launcher.closed) return;
    launcher.closed = true;
    if (current === launcher) current = undefined;
    if (!launcher.ready) unavailable = true;
    for (const child of launcher.children.values()) {
      if (child.pid === undefined) {
        Deferred.doneUnsafe(
          child.started,
          Exit.fail(
            launcher.ready
              ? toPlatformError(child.command, "spawn", new Error("The process launcher exited."))
              : new LauncherUnavailable(),
          ),
        );
        continue;
      }
      if (!Deferred.isDoneUnsafe(child.exited)) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
        Deferred.doneUnsafe(child.exited, Exit.succeed([null, "SIGKILL"] as const));
      }
      Queue.endUnsafe(child.stdout);
      Queue.endUnsafe(child.stderr);
    }
    launcher.children.clear();
    if (launcher.worker.connected) launcher.worker.disconnect();
  };

  const onEvent = (launcher: Launcher, event: LauncherEvent) => {
    if (event.type === "ready") {
      launcher.ready = true;
      return;
    }
    const child = launcher.children.get(event.id);
    if (!child) return;
    switch (event.type) {
      case "spawned":
        child.pid = event.pid;
        Deferred.doneUnsafe(child.started, Exit.succeed(event.pid));
        break;
      case "failed":
        launcher.children.delete(event.id);
        syncRef(launcher);
        Deferred.doneUnsafe(child.started, Exit.fail(toSpawnFailure(child.command, event.failure)));
        break;
      case "output":
        Queue.offerUnsafe(child[event.stream], event.chunk);
        break;
      case "outputEnd":
        Queue.endUnsafe(child[event.stream]);
        settle(launcher, event.id, child);
        break;
      case "exit":
        Deferred.doneUnsafe(child.exited, Exit.succeed([event.code, event.signal] as const));
        settle(launcher, event.id, child);
        break;
    }
  };

  const launch = (): Launcher | undefined => {
    if (unavailable) return undefined;
    if (current !== undefined) return current;
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.NODE_OPTIONS;
    // `node --watch` children would report their imports over the launcher's IPC channel.
    delete env.WATCH_REPORT_DEPENDENCIES;
    const worker = NodeChildProcess.spawn(executablePath, args, {
      cwd: "/",
      env,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      serialization: "advanced",
    });
    const launcher: Launcher = { worker, children: new Map(), ready: false, closed: false };
    worker.unref();
    worker.channel?.unref();
    worker.on("message", (event: LauncherEvent) => onEvent(launcher, event));
    worker.on("error", () => close(launcher));
    worker.once("disconnect", () => close(launcher));
    worker.once("exit", () => close(launcher));
    current = launcher;
    return launcher;
  };

  const send = (launcher: Launcher, request: LauncherRequest) => {
    if (launcher.closed) return;
    launcher.worker.send(request, (error) => {
      if (error) close(launcher);
    });
  };

  const spawnHosted = Effect.fnUntraced(function* (
    launcher: Launcher,
    command: ChildProcess.StandardCommand,
  ) {
    const id = ++nextId;
    const child: HostedChild = {
      command,
      started: Deferred.makeUnsafe(),
      exited: Deferred.makeUnsafe(),
      stdout: yield* Queue.unbounded<Uint8Array, Cause.Done>(),
      stderr: yield* Queue.unbounded<Uint8Array, Cause.Done>(),
      pid: undefined,
      pending: 3,
    };
    launcher.children.set(id, child);
    syncRef(launcher);
    send(launcher, {
      type: "spawn",
      id,
      command: command.command,
      args: command.args.map((arg) => (Redacted.isRedacted(arg) ? Redacted.value(arg) : arg)),
      cwd: command.options.cwd === undefined ? undefined : path.resolve(command.options.cwd),
      env: resolveEnvironment(command.options),
      shell: command.options.shell,
    });

    const signalGroup = (pid: number, signal: ChildProcess.Signal) =>
      Effect.try({
        try: () => {
          try {
            process.kill(-pid, signal);
          } catch {
            process.kill(pid, signal);
          }
        },
        catch: (cause) => toPlatformError(command, "kill", cause as NodeJS.ErrnoException),
      });

    const terminate = Effect.fnUntraced(function* (
      pid: number,
      options: ChildProcess.KillOptions | undefined,
    ) {
      yield* signalGroup(pid, options?.killSignal ?? "SIGTERM");
      if (options?.forceKillAfter !== undefined) {
        yield* Deferred.await(child.exited).pipe(Effect.timeoutOption(options.forceKillAfter));
        if (!Deferred.isDoneUnsafe(child.exited)) yield* signalGroup(pid, "SIGKILL");
      }
      yield* Deferred.await(child.exited);
    });

    const pid = yield* Effect.acquireRelease(Deferred.await(child.started), (pid) =>
      Deferred.isDoneUnsafe(child.exited)
        ? // Like the native spawner, clean up descendants left in the exited leader's group.
          Effect.sync(() => {
            try {
              process.kill(-pid, command.options.killSignal ?? "SIGTERM");
            } catch {
              // The group is already gone.
            }
          })
        : Effect.ignore(terminate(pid, command.options)),
    );

    const stdout = Stream.fromQueue(child.stdout);
    const stderr = Stream.fromQueue(child.stderr);
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(pid),
      exitCode: Effect.flatMap(Deferred.await(child.exited), ([code, signal]) =>
        code !== null
          ? Effect.succeed(ChildProcessSpawner.ExitCode(code))
          : Effect.fail(
              toPlatformError(
                command,
                "exitCode",
                new Error(`Process interrupted due to receipt of signal: '${signal}'`),
              ),
            ),
      ),
      isRunning: Effect.map(Deferred.isDone(child.exited), (done) => !done),
      kill: (options) => terminate(pid, options),
      unref: Effect.succeed(Effect.void),
      stdin: Sink.forEach((chunk: Uint8Array) =>
        Effect.sync(() => send(launcher, { type: "stdin", id, chunk })),
      ).pipe(Sink.mapEffect(() => Effect.sync(() => send(launcher, { type: "stdinEnd", id })))),
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  });

  // Untraced like the native spawner; ProcessRunner owns the span for each command.
  const spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"] = (command) => {
    const launcher = command._tag === "StandardCommand" ? launch() : undefined;
    if (launcher === undefined || command._tag !== "StandardCommand") {
      return fallback.spawn(command);
    }
    return spawnHosted(launcher, command).pipe(
      Effect.catchTags({ LauncherUnavailable: () => fallback.spawn(command) }),
    );
  };

  yield* Effect.addFinalizer(() => Effect.sync(() => current && close(current)));
  // Start while the server is still small; the launcher's own fork is the last full-size one.
  launch();
  return ChildProcessSpawner.make(spawn);
});

/** Replaces the ChildProcessSpawner in context, which stays the fallback when the launcher cannot start. */
export const layer = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, make());
