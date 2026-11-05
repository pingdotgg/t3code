// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - IPC and timer callbacks implement the spawner boundary, as in the native spawner.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { LauncherEvent, LauncherSpawnRequest } from "./processLauncherWorker.ts";

// A launcher that misses either is treated as hung; neither happens to a healthy one.
const READY_TIMEOUT = "10 seconds";
const SPAWN_REPLY_TIMEOUT_MS = 10_000;

/** A child of the launcher, presented to the native spawner as a Node ChildProcess. */
class HostedChild
  extends NodeEvents.EventEmitter
  implements NodeChildProcessSpawner.SpawnedChildProcess
{
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin: NodeStream.Writable | null = null;
  stdout: NodeStream.Readable | null = null;
  stderr: NodeStream.Readable | null = null;
  readonly stdio: Array<NodeStream.Readable | NodeStream.Writable | null | undefined> = [];
  referenced = true;
  /** No longer awaited: its spawn failed, timed out or it exited. */
  settled = false;
  readonly launcher: Launcher;

  constructor(launcher: Launcher) {
    super();
    this.launcher = launcher;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.pid === undefined || this.exitCode !== null || this.signalCode !== null) return false;
    try {
      process.kill(this.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  ref(): void {
    this.referenced = true;
    syncRef(this.launcher);
  }

  unref(): void {
    this.referenced = false;
    syncRef(this.launcher);
  }

  fail(error: Error): void {
    this.settled = true;
    this.emit("error", error);
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.settled = true;
    this.exitCode = code;
    this.signalCode = signal;
    // Node destroys stdin at exit and drains output nobody reads, so pipes never hold a child.
    this.stdin?.destroy();
    this.emit("exit", code, signal);
    process.nextTick(() => {
      for (const stream of [this.stdout, this.stderr]) {
        if (
          stream &&
          stream.listenerCount("data") === 0 &&
          stream.listenerCount("readable") === 0
        ) {
          stream.resume();
        }
      }
    });
  }
}

interface Launcher {
  readonly worker: NodeChildProcess.ChildProcess;
  readonly children: Map<number, HostedChild>;
  readonly ready: Deferred.Deferred<boolean>;
  closed: boolean;
}

const syncRef = (launcher: Launcher) => {
  if ([...launcher.children.values()].some((child) => child.referenced)) {
    launcher.worker.channel?.ref();
  } else {
    launcher.worker.channel?.unref();
  }
};

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
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
// The helper passes each child's pipes back, so the native spawner keeps all of its semantics.
const make = Effect.fn("ProcessLauncher.make")(function* () {
  const fallback = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((yield* HostProcess.Platform) !== "linux") return fallback;

  const executablePath = yield* HostProcess.ExecutablePath;
  const args = yield* launcherArguments();
  let current: Launcher | undefined;
  // A launcher that never starts will not start next time either; stop forking for it.
  let unavailable = false;
  let shutDown = false;
  let nextId = 0;

  const close = (launcher: Launcher) => {
    if (launcher.closed) return;
    launcher.closed = true;
    if (current === launcher) current = undefined;
    const ready = Deferred.isDoneUnsafe(launcher.ready);
    if (!ready) unavailable = true;
    Deferred.doneUnsafe(launcher.ready, Exit.succeed(false));
    const error = new Error("The process launcher exited.");
    for (const child of launcher.children.values()) {
      if (child.settled) continue;
      if (child.pid === undefined) {
        child.fail(error);
      } else {
        killGroup(child.pid);
        child.exit(null, "SIGKILL");
      }
    }
    launcher.children.clear();
    if (launcher.worker.connected) launcher.worker.disconnect();
    // A started launcher kills its children and exits once disconnected; one that never started may be hung.
    if (!ready) launcher.worker.kill("SIGKILL");
  };

  const onEvent = (
    launcher: Launcher,
    event: LauncherEvent,
    socket: NodeNet.Socket | undefined,
  ) => {
    if (event.type === "ready") {
      Deferred.doneUnsafe(launcher.ready, Exit.succeed(true));
      return;
    }
    const child = launcher.children.get(event.id);
    if (child === undefined) {
      socket?.destroy();
      return;
    }
    switch (event.type) {
      case "stdio":
        if (child.settled) socket?.destroy();
        else if (socket) {
          child.stdio[event.fd] = socket;
          if (event.fd === 0) {
            // Unlike Node's own stdin pipe this socket also reads, and an unread write resets it.
            socket.on("error", () => {});
            child.stdin = socket;
          } else if (event.fd === 1) child.stdout = socket;
          else if (event.fd === 2) child.stderr = socket;
        }
        break;
      case "spawn":
        child.pid = event.pid;
        // Its spawn timed out and nobody owns it any more.
        if (child.settled) killGroup(event.pid);
        else child.emit("spawn");
        break;
      case "exit":
        launcher.children.delete(event.id);
        syncRef(launcher);
        if (!child.settled) child.exit(event.code, event.signal);
        break;
      case "error":
        if (child.pid !== undefined || child.settled) break;
        launcher.children.delete(event.id);
        syncRef(launcher);
        child.fail(Object.assign(new Error(event.error.message), event.error));
        break;
    }
  };

  const launch = (): Launcher | undefined => {
    if (unavailable || shutDown) return undefined;
    if (current !== undefined) return current;
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.NODE_OPTIONS;
    // `node --watch` children would report their imports over the launcher's IPC channel.
    delete env.WATCH_REPORT_DEPENDENCIES;
    const worker = NodeChildProcess.spawn(executablePath, args, {
      cwd: "/",
      env,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const launcher: Launcher = {
      worker,
      children: new Map(),
      ready: Deferred.makeUnsafe(),
      closed: false,
    };
    worker.unref();
    worker.channel?.unref();
    worker.on("message", (event: LauncherEvent, socket: NodeNet.Socket | undefined) =>
      onEvent(launcher, event, socket),
    );
    worker.on("error", () => close(launcher));
    worker.once("disconnect", () => close(launcher));
    worker.once("exit", () => close(launcher));
    current = launcher;
    return launcher;
  };

  const spawnProcess = (
    command: string,
    commandArgs: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ): NodeChildProcessSpawner.SpawnedChildProcess => {
    const launcher = current;
    // Lost between the readiness check and the spawn; rare enough to fork for.
    if (launcher === undefined || launcher.closed) {
      return NodeChildProcess.spawn(command, [...commandArgs], options);
    }
    const id = ++nextId;
    const child = new HostedChild(launcher);
    launcher.children.set(id, child);
    syncRef(launcher);
    const request: LauncherSpawnRequest = {
      type: "spawn",
      id,
      command,
      args: commandArgs,
      // The launcher runs in `/` with its own environment; children inherit the server's.
      options: { ...options, cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env },
    };
    launcher.worker.send(request, (error) => {
      if (error) close(launcher);
    });
    // The native spawner waits for the reply uninterruptibly, so a hung launcher must not hold it.
    setTimeout(() => {
      if (child.pid !== undefined || child.settled) return;
      child.fail(new Error("The process launcher did not respond."));
    }, SPAWN_REPLY_TIMEOUT_MS).unref();
    return child;
  };

  const hosted = Context.get(
    yield* Layer.build(NodeChildProcessSpawner.layerWithSpawn(spawnProcess)),
    ChildProcessSpawner.ChildProcessSpawner,
  );

  const isReady = Effect.suspend(() => {
    const launcher = launch();
    if (launcher === undefined) return Effect.succeed(false);
    return Deferred.await(launcher.ready).pipe(
      Effect.timeoutOption(READY_TIMEOUT),
      Effect.map(Option.getOrElse(() => false)),
      Effect.tap((ready) =>
        Effect.sync(() => {
          if (!ready) close(launcher);
        }),
      ),
    );
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      shutDown = true;
      if (current) close(current);
    }),
  );
  // Start while the server is still small; the launcher's own fork is the last full-size one.
  launch();
  return ChildProcessSpawner.make((command) =>
    Effect.flatMap(isReady, (ready) => (ready ? hosted : fallback).spawn(command)),
  );
});

/** Replaces the ChildProcessSpawner in context, which stays the fallback when the launcher cannot start. */
export const layer = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, make());
