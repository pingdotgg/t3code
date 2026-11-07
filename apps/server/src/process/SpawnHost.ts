// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Node process and IPC callbacks implement the platform spawner boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";

import type { SpawnHostEvent, SpawnHostSpawnRequest } from "./spawnHostProcess.ts";

// A blocked native spawn occupies its host; already-running children share available hosts.
const MAX_IDLE_HOSTS = 1;
const HOST_READY_TIMEOUT_MS = 10_000;

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
  signal: NodeJS.Signals | number | undefined;
  exited = false;

  readonly host: SpawnHost;
  readonly id: number;

  constructor(host: SpawnHost, id: number) {
    super();
    this.host = host;
    this.id = id;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exited) return false;
    if (this.pid === undefined) {
      this.signal = signal;
      return true;
    }
    try {
      process.kill(this.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  ref(): void {
    this.referenced = true;
    this.host.setReferenced(this);
  }

  unref(): void {
    this.referenced = false;
    this.host.setReferenced(this);
  }

  attach(fd: number, socket: NodeNet.Socket): void {
    this.stdio[fd] = socket;
    if (fd === 0) {
      // Node destroys stdin on exit even after the Effect sink has removed its error listener.
      socket.on("error", () => {});
      this.stdin = socket;
    } else if (fd === 1) this.stdout = socket;
    else if (fd === 2) this.stderr = socket;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdin?.destroy();
    this.emit("exit", code, signal);
    process.nextTick(() => {
      for (const stream of this.stdio) {
        if (
          stream &&
          "resume" in stream &&
          stream.listenerCount("data") === 0 &&
          stream.listenerCount("readable") === 0
        ) {
          stream.resume();
        }
      }
    });
  }
}

class SpawnHost {
  readonly process: NodeChildProcess.ChildProcess;
  readonly children = new Map<number, HostedChild>();
  ready = false;
  closed = false;
  request: SpawnHostSpawnRequest | undefined;
  #nextId = 0;
  readonly #readyTimer: NodeJS.Timeout;

  readonly pool: SpawnPool;

  constructor(pool: SpawnPool, command: string, args: ReadonlyArray<string>) {
    this.pool = pool;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    this.process = NodeChildProcess.spawn(command, [...args], {
      cwd: "/",
      env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    this.process.unref();
    this.#readyTimer = setTimeout(() => {
      this.process.kill("SIGKILL");
      this.fail(new Error("The process launcher did not start in time."));
    }, HOST_READY_TIMEOUT_MS);
    this.#readyTimer.unref();
    this.process.on("message", (event, socket) =>
      this.onEvent(event as SpawnHostEvent, socket as NodeNet.Socket | undefined),
    );
    this.process.on("error", (error) => this.fail(error));
    this.process.once("close", () =>
      this.fail(new Error("The process launcher exited unexpectedly.")),
    );
    this.process.channel?.unref();
  }

  spawn(
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ): HostedChild {
    const child = new HostedChild(this, ++this.#nextId);
    this.children.set(child.id, child);
    this.request = {
      type: "spawn",
      id: child.id,
      referenced: child.referenced,
      command,
      args,
      options: { ...options, cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env },
    };
    this.syncRef();
    if (this.ready) this.send();
    return child;
  }

  syncRef(): void {
    if ([...this.children.values()].some((child) => child.referenced)) this.process.channel?.ref();
    else this.process.channel?.unref();
  }

  setReferenced(child: HostedChild): void {
    this.syncRef();
    if (this.ready && this.children.has(child.id) && this.process.connected) {
      this.process.send({ type: "ref", id: child.id, referenced: child.referenced }, (error) => {
        if (error) this.fail(error);
      });
    }
  }

  send(): void {
    this.process.send(this.request!, (error) => {
      if (error) this.fail(error);
    });
  }

  onEvent(event: SpawnHostEvent, socket: NodeNet.Socket | undefined): void {
    if (this.closed) {
      socket?.destroy();
      return;
    }
    if (event.type === "ready") {
      clearTimeout(this.#readyTimer);
      this.ready = true;
      if (this.request) this.send();
      return;
    }
    const child = this.children.get(event.id);
    if (!child) {
      socket?.destroy();
      return;
    }
    switch (event.type) {
      case "stdio":
        if (socket) child.attach(event.fd, socket);
        break;
      case "spawn":
        this.request = undefined;
        child.pid = event.pid;
        if (child.signal !== undefined) child.kill(child.signal);
        child.emit("spawn");
        break;
      case "exit":
        child.exit(event.code, event.signal);
        this.release(child);
        break;
      case "error":
        if (child.pid === undefined) {
          child.exited = true;
          this.release(child);
        }
        child.emit("error", Object.assign(new Error(event.error.message), event.error));
        break;
    }
  }

  release(child: HostedChild): void {
    this.children.delete(child.id);
    if (this.request?.id === child.id) this.request = undefined;
    this.syncRef();
    this.pool.release(this);
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.close();
    for (const child of this.children.values()) {
      if (child.exited) continue;
      if (child.pid === undefined) {
        child.exited = true;
        child.emit("error", error);
      } else {
        child.exit(null, "SIGKILL");
      }
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.#readyTimer);
    this.pool.hosts.delete(this);
    for (const child of this.children.values()) {
      if (!child.referenced || child.pid === undefined || child.exited) continue;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    if (this.process.connected) this.process.disconnect();
  }
}

class SpawnPool {
  readonly hosts = new Set<SpawnHost>();

  readonly command: string;
  readonly args: ReadonlyArray<string>;

  constructor(command: string, args: ReadonlyArray<string>) {
    this.command = command;
    this.args = args;
  }

  readonly spawn = (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => {
    let host = [...this.hosts].find((candidate) => candidate.request === undefined);
    if (!host) {
      host = new SpawnHost(this, this.command, this.args);
      this.hosts.add(host);
    }
    return host.spawn(command, args, options);
  };

  release(host: SpawnHost): void {
    if (
      [...this.hosts].filter((candidate) => candidate.children.size === 0).length > MAX_IDLE_HOSTS
    )
      host.close();
  }

  close(): void {
    for (const host of this.hosts) host.close();
  }
}

export const layerHost = (command: string, args: ReadonlyArray<string>) =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => new SpawnPool(command, args)),
      (pool) => Effect.sync(() => pool.close()),
    ).pipe(Effect.map((pool) => NodeChildProcessSpawner.layerWithSpawn(pool.spawn))),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "linux") return NodeChildProcessSpawner.layer;
    const invocation = yield* resolveSelfInvocation();
    return layerHost(invocation.command, selfInvocationArgs(invocation, ["__spawn-host"]));
  }),
);
