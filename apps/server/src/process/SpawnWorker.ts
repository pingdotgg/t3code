// @effect-diagnostics nodeBuiltinImport:off - worker threads and Node streams implement the platform spawner boundary.
import * as NodeEvents from "node:events";
import type * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";

// Windows runs CreateProcess synchronously on the calling thread, and antivirus or a busy disk can
// hold it for seconds. Workers own the children, so only the worker waits.
const MAX_WORKERS = 4;
const MAX_IDLE_WORKERS = 1;

type ToWorker =
  | {
      readonly type: "spawn";
      readonly id: number;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: NodeChildProcess.SpawnOptions;
    }
  | { readonly type: "write"; readonly id: number; readonly fd: number; readonly data: Uint8Array }
  | { readonly type: "end"; readonly id: number; readonly fd: number }
  | { readonly type: "flow"; readonly id: number; readonly fd: number; readonly paused: boolean }
  | { readonly type: "destroy"; readonly id: number; readonly fd: number }
  | { readonly type: "kill"; readonly id: number; readonly signal: NodeJS.Signals | number };

interface SerializedError {
  readonly message: string;
  readonly [key: string]: unknown;
}

type FromWorker =
  | { readonly type: "spawn"; readonly id: number; readonly pid: number | undefined }
  | { readonly type: "error"; readonly id: number; readonly error: SerializedError }
  | { readonly type: "data"; readonly id: number; readonly fd: number; readonly data: Uint8Array }
  | {
      readonly type: "written";
      readonly id: number;
      readonly fd: number;
      readonly error?: SerializedError;
    }
  | { readonly type: "eof"; readonly id: number; readonly fd: number }
  | { readonly type: "finished"; readonly id: number; readonly fd: number }
  | {
      readonly type: "stream-error";
      readonly id: number;
      readonly fd: number;
      readonly error: SerializedError;
    }
  | {
      readonly type: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly type: "close"; readonly id: number };

// Inline source runs from bundles, asar archives and single-executable builds without module files.
const workerSource = `
const { parentPort } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const children = new Map();
const post = (message, transfer) => parentPort.postMessage(message, transfer);
const serialize = (error) => {
  const out = { message: String(error && error.message) };
  for (const key of ["code", "errno", "syscall", "path", "spawnargs"]) {
    if (error && error[key] !== undefined) out[key] = error[key];
  }
  return out;
};
parentPort.on("message", (request) => {
  const { id } = request;
  if (request.type === "spawn") {
    let child;
    try {
      child = spawn(request.command, request.args, request.options);
    } catch (error) {
      post({ type: "error", id, error: serialize(error) });
      return;
    }
    children.set(id, child);
    child.on("spawn", () => post({ type: "spawn", id, pid: child.pid }));
    child.on("error", (error) => post({ type: "error", id, error: serialize(error) }));
    child.on("exit", (code, signal) => post({ type: "exit", id, code, signal }));
    // Output can still arrive after exit; close follows the last of it.
    child.on("close", () => {
      children.delete(id);
      post({ type: "close", id });
    });
    child.stdio?.forEach((stream, fd) => {
      if (!stream) return;
      stream.on("error", (error) => post({ type: "stream-error", id, fd, error: serialize(error) }));
      if (fd === 0) return;
      // Cloning a Buffer copies its whole backing store; copy the bytes once and transfer them.
      stream.on("data", (chunk) => {
        const data = new Uint8Array(chunk);
        post({ type: "data", id, fd, data }, [data.buffer]);
      });
      stream.on("end", () => post({ type: "eof", id, fd }));
    });
    return;
  }
  const child = children.get(id);
  if (child === undefined) {
    if (request.type === "write") post({ type: "written", id, fd: request.fd, error: { message: "write after exit", code: "EPIPE" } });
    if (request.type === "end") post({ type: "finished", id, fd: request.fd });
    return;
  }
  const stream = child.stdio?.[request.fd];
  switch (request.type) {
    case "write":
      if (!stream || stream.destroyed) {
        post({ type: "written", id, fd: request.fd, error: { message: "write after end", code: "EPIPE" } });
        return;
      }
      try {
        stream.write(request.data, (error) => post({ type: "written", id, fd: request.fd, error: error ? serialize(error) : undefined }));
      } catch (error) {
        post({ type: "written", id, fd: request.fd, error: serialize(error) });
      }
      return;
    case "end":
      if (!stream || stream.destroyed || stream.writableFinished) post({ type: "finished", id, fd: request.fd });
      else stream.end(() => post({ type: "finished", id, fd: request.fd }));
      return;
    case "flow":
      if (request.paused) stream?.pause();
      else stream?.resume();
      return;
    case "destroy":
      stream?.destroy();
      return;
    case "kill":
      try {
        child.kill(request.signal);
      } catch {}
      return;
  }
});
`;

const toError = (serialized: SerializedError) =>
  Object.assign(new Error(serialized.message), serialized);

const toBuffer = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

class WorkerChild
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
  spawned = false;
  exited = false;
  readonly #writes = new Map<number, Array<(error?: Error | null) => void>>();
  readonly #finals = new Map<number, (error?: Error | null) => void>();
  readonly #paused = new Set<number>();

  readonly worker: SpawnWorker;
  readonly id: number;

  constructor(worker: SpawnWorker, id: number, stdio: ReadonlyArray<unknown>) {
    super();
    this.worker = worker;
    this.id = id;
    stdio.forEach((option, fd) => {
      if (option !== "pipe" && option !== "overlapped") return;
      const stream = this.#relay(fd);
      this.stdio[fd] = stream;
      if (fd === 0) this.stdin = stream as NodeStream.Writable;
      else if (fd === 1) this.stdout = stream as NodeStream.Readable;
      else if (fd === 2) this.stderr = stream as NodeStream.Readable;
    });
  }

  #relay(fd: number): NodeStream.Readable | NodeStream.Writable {
    const read = () => {
      if (this.#paused.delete(fd))
        this.worker.post({ type: "flow", id: this.id, fd, paused: false });
    };
    const write = (
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) => {
      if (this.worker.closed) {
        callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        return;
      }
      const pending = this.#writes.get(fd) ?? [];
      pending.push(callback);
      this.#writes.set(fd, pending);
      const data = new Uint8Array(chunk);
      this.worker.post({ type: "write", id: this.id, fd, data }, [data.buffer]);
    };
    const final = (callback: (error?: Error | null) => void) => {
      this.#finals.set(fd, callback);
      this.worker.post({ type: "end", id: this.id, fd });
    };
    // A caller that destroys its end closes the child pipe, as it would with a real pipe.
    const destroy = (error: Error | null, callback: (error?: Error | null) => void) => {
      if (!this.exited) this.worker.post({ type: "destroy", id: this.id, fd });
      callback(error);
    };
    if (fd === 0) return new NodeStream.Writable({ write, final, destroy });
    if (fd <= 2) return new NodeStream.Readable({ read, destroy });
    return new NodeStream.Duplex({ read, write, final, destroy, allowHalfOpen: true });
  }

  onData(fd: number, data: Uint8Array): void {
    const stream = this.stdio[fd];
    if (!stream || !("push" in stream)) return;
    if (!stream.push(toBuffer(data)) && !this.#paused.has(fd)) {
      this.#paused.add(fd);
      this.worker.post({ type: "flow", id: this.id, fd, paused: true });
    }
  }

  onEof(fd: number): void {
    const stream = this.stdio[fd];
    if (stream && "push" in stream) stream.push(null);
  }

  onFinished(fd: number): void {
    const callback = this.#finals.get(fd);
    this.#finals.delete(fd);
    callback?.();
  }

  onWritten(fd: number, error: SerializedError | undefined): void {
    const callback = this.#writes.get(fd)?.shift();
    callback?.(error === undefined ? null : toError(error));
  }

  onStreamError(fd: number, error: SerializedError): void {
    this.stdio[fd]?.destroy(toError(error));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exited) return false;
    this.worker.post({ type: "kill", id: this.id, signal });
    return true;
  }

  ref(): void {
    this.referenced = true;
    this.worker.syncRef();
  }

  unref(): void {
    this.referenced = false;
    this.worker.syncRef();
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    // Node destroys stdin on exit; the Effect sink may already have removed its error listener.
    this.stdin?.on("error", () => {});
    this.stdin?.destroy();
    this.emit("exit", code, signal);
  }

  /** The worker is gone: end output so readers finish, and let the exit report the kill. */
  abandon(): void {
    // Not destroy(error): Effect leaves an unread stderr's pipe without an error listener.
    for (const stream of this.stdio) {
      if (stream && "push" in stream && !stream.readableEnded) stream.push(null);
      else if (stream && !("push" in stream)) stream.destroy();
    }
  }
}

class SpawnWorker {
  readonly worker: NodeWorkerThreads.Worker;
  readonly children = new Map<number, WorkerChild>();
  readonly pool: SpawnWorkerPool;
  /** Launches sent but not yet answered; the worker is inside CreateProcess for one of them. */
  launching = 0;
  closed = false;

  constructor(pool: SpawnWorkerPool) {
    this.pool = pool;
    this.worker = new NodeWorkerThreads.Worker(workerSource, { eval: true });
    this.worker.on("message", (message: FromWorker) => this.onMessage(message));
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", () => this.fail(new Error("The process launcher thread exited.")));
    this.worker.unref();
  }

  post(message: ToWorker, transfer?: ReadonlyArray<ArrayBuffer>): void {
    if (!this.closed) this.worker.postMessage(message, transfer);
  }

  spawn(
    id: number,
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ): WorkerChild {
    const io = options.stdio;
    const stdio =
      typeof io === "string" || io === undefined ? [io ?? "pipe", io ?? "pipe", io ?? "pipe"] : io;
    const child = new WorkerChild(this, id, stdio);
    this.children.set(id, child);
    this.launching++;
    this.syncRef();
    this.post({
      type: "spawn",
      id,
      command,
      args: [...args],
      // A worker's process.env is a copy from when it started; children get the server's current one.
      options: { ...options, stdio, env: options.env ?? { ...process.env } },
    });
    return child;
  }

  syncRef(): void {
    if (this.closed) return;
    const referenced =
      this.launching > 0 || [...this.children.values()].some((child) => child.referenced);
    if (referenced) this.worker.ref();
    else this.worker.unref();
  }

  onMessage(message: FromWorker): void {
    const child = this.children.get(message.id);
    if (child === undefined) return;
    switch (message.type) {
      case "spawn":
        this.launching--;
        child.spawned = true;
        child.pid = message.pid;
        child.emit("spawn");
        break;
      case "error":
        if (!child.spawned) {
          this.launching--;
          child.exited = true;
          this.release(child);
        }
        child.emit("error", toError(message.error));
        break;
      case "data":
        child.onData(message.fd, message.data);
        break;
      case "written":
        child.onWritten(message.fd, message.error);
        break;
      case "eof":
        child.onEof(message.fd);
        break;
      case "finished":
        child.onFinished(message.fd);
        break;
      case "stream-error":
        child.onStreamError(message.fd, message.error);
        break;
      case "exit":
        child.exit(message.code, message.signal);
        break;
      case "close":
        child.emit("close", child.exitCode, child.signalCode);
        this.release(child);
        break;
    }
  }

  release(child: WorkerChild): void {
    this.children.delete(child.id);
    this.syncRef();
    this.pool.release(this);
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.close();
    for (const child of this.children.values()) {
      if (child.exited) {
        child.abandon();
        continue;
      }
      if (!child.spawned) {
        child.exited = true;
        child.emit("error", error);
        continue;
      }
      // The worker owned the only handle, so try to end the whole tree before reporting the exit.
      const finish = () => {
        child.exit(null, "SIGKILL");
        child.abandon();
      };
      if (child.pid === undefined) finish();
      else this.pool.killTree(child.pid, finish);
    }
    this.children.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pool.workers.delete(this);
    void this.worker.terminate();
  }
}

class SpawnWorkerPool {
  readonly workers = new Set<SpawnWorker>();
  readonly platform: NodeJS.Platform;
  #nextId = 0;

  constructor(platform: NodeJS.Platform) {
    this.platform = platform;
  }

  readonly spawn = (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => {
    const workers = [...this.workers];
    // A worker inside CreateProcess cannot start another launch until it returns.
    const worker =
      workers.find((candidate) => candidate.launching === 0) ??
      (workers.length < MAX_WORKERS
        ? this.#add()
        : workers.reduce((best, candidate) =>
            candidate.launching < best.launching ? candidate : best,
          ));
    return worker.spawn(++this.#nextId, command, args, options);
  };

  killTree(pid: number, done: () => void): void {
    const killPid = () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    };
    if (this.platform !== "win32") {
      killPid();
      done();
      return;
    }
    let settled = false;
    const finish = (killed: boolean) => {
      if (settled) return;
      settled = true;
      // As Effect's own kill does when taskkill fails, end at least the direct child.
      if (!killed) killPid();
      done();
    };
    this.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
      .on("error", () => finish(false))
      .on("exit", (code) => finish(code === 0));
  }

  #add(): SpawnWorker {
    const worker = new SpawnWorker(this);
    this.workers.add(worker);
    return worker;
  }

  release(worker: SpawnWorker): void {
    if (worker.children.size > 0 || worker.launching > 0) return;
    const idle = [...this.workers].filter(
      (candidate) => candidate.children.size === 0 && candidate.launching === 0,
    );
    if (idle.length > MAX_IDLE_WORKERS) worker.close();
  }

  close(): void {
    for (const worker of this.workers) worker.close();
  }
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new SpawnWorkerPool(platform)),
      (pool) => Effect.sync(() => pool.close()),
    );
    return NodeChildProcessSpawner.layerWithSpawn(pool.spawn);
  }),
);

/** Only Windows creates processes slowly enough on the calling thread to need workers. */
export const layerServer = Layer.unwrap(
  Effect.map(HostProcess.Platform, (platform) =>
    platform === "win32" ? layer : NodeChildProcessSpawner.layer,
  ),
);
