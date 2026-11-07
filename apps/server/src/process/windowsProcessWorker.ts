/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker ports have no browser origin. */
// @effect-diagnostics nodeBuiltinImport:off -- native creation and tree cleanup must stay off the server event loop.
import * as NodeWorkerThreads from "node:worker_threads";

interface SpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: boolean | string;
  readonly detached?: boolean | undefined;
  readonly windowsHide?: boolean | undefined;
}

interface Streams {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}

type Reply =
  | ({ readonly type: "spawned" } & Streams)
  | { readonly type: "exit"; readonly code: number | null; readonly signal: string | null }
  | { readonly type: "error"; readonly error: Error; readonly code?: string }
  | { readonly type: "released" };

// Inline source also runs in Electron, bundled CLI and single-executable builds.
const source = `
const { parentPort } = require("node:worker_threads");
const { spawn, execFile } = require("node:child_process");
const { Readable, Writable } = require("node:stream");
parentPort.on("message", ({ input, port, control, stop }) => {
  if (stop) { parentPort.close(); return; }
  const state = new Int32Array(control);
  let child;
  let disposing = false;
  let exited;
  const exit = new Promise(resolve => { exited = resolve; });
  const report = error => port.postMessage({ type: "error", error, code: error.code });
  const dispose = async () => {
    if (disposing) return;
    disposing = true;
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, error => {
          if (error && child.exitCode === null && child.signalCode === null) child.kill();
          resolve();
        });
      });
      await exit;
    }
    child?.stdin?.destroy();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    port.postMessage({ type: "released" });
    port.close();
  };
  port.on("message", () => { void dispose().catch(report); });
  try {
    child = spawn(input.command, input.args, {
      cwd: input.cwd, env: input.env, shell: input.shell, windowsHide: input.windowsHide ?? true,
      detached: input.detached,
    });
    Atomics.store(state, 0, child.pid || 0);
    child.once("exit", (code, signal) => {
      Atomics.store(state, 0, 0);
      exited();
      port.postMessage({ type: "exit", code, signal });
    });
    child.on("error", report);
    child.stdin.on("error", () => {});
    child.once("spawn", () => {
      if (Atomics.load(state, 1)) { void dispose().catch(report); return; }
      const options = { strategy: { highWaterMark: 65536, size: chunk => chunk.byteLength } };
      const stdout = Readable.toWeb(child.stdout, options);
      const stderr = Readable.toWeb(child.stderr, options);
      const stdin = Writable.toWeb(child.stdin);
      port.postMessage({ type: "spawned", stdin, stdout, stderr }, [stdin, stdout, stderr]);
    });
  } catch (error) { report(error); }
});
`;

const cleanupSource = `
const { workerData, parentPort } = require("node:worker_threads");
const state = new Int32Array(workerData);
const pid = Atomics.load(state, 0);
if (pid) {
  require("node:child_process").execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, error => {
    parentPort.postMessage(error || null);
    parentPort.close();
  });
} else { parentPort.postMessage(null); parentPort.close(); }
`;

const cleanupOrphan = (control: SharedArrayBuffer) =>
  new Promise<void>((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(cleanupSource, { eval: true, workerData: control });
    let failure: Error | undefined;
    worker.on("message", (error: Error | null) => {
      failure = error ?? undefined;
    });
    worker.once("error", reject);
    worker.once("exit", () => (failure ? reject(failure) : resolve()));
  });

export function makePool() {
  const jobs = new Set<{ dispose: () => Promise<void> }>();
  let idle: NodeWorkerThreads.Worker | undefined;
  let closed = false;

  const stop = (worker: NodeWorkerThreads.Worker) =>
    new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
      worker.ref();
      worker.postMessage({ stop: true });
    });

  const start = (input: SpawnInput) => {
    if (closed) throw new Error("Process worker pool is closed");
    const worker = idle ?? new NodeWorkerThreads.Worker(source, { eval: true });
    if (!idle) {
      worker.on("error", () => {});
      worker.once("exit", () => {
        if (idle === worker) idle = undefined;
      });
    }
    idle = undefined;
    worker.ref();
    const { port1, port2 } = new NodeWorkerThreads.MessageChannel();
    const control = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    const state = new Int32Array(control);
    const started = Promise.withResolvers<Streams>();
    const exit = Promise.withResolvers<number>();
    const released = Promise.withResolvers<void>();
    // Failure can precede acquisition of either result by the Effect consumer.
    void started.promise.catch(() => {});
    void exit.promise.catch(() => {});
    void released.promise.catch(() => {});
    let dead = false;
    let disposal: Promise<void> | undefined;
    const fail = (error: Error) => {
      started.reject(error);
      exit.reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number) => {
      dead = true;
      fail(new Error(`Process worker exited unexpectedly (${code})`));
      void cleanupOrphan(control).then(released.resolve, released.reject);
    };
    worker.on("error", onError);
    worker.once("exit", onExit);
    port1.on("message", (reply: Reply) => {
      switch (reply.type) {
        case "spawned":
          started.resolve(reply);
          break;
        case "exit":
          if (reply.code === null) exit.reject(new Error(`Process interrupted by ${reply.signal}`));
          else exit.resolve(reply.code);
          break;
        case "error":
          fail(Object.assign(reply.error, { code: reply.code }));
          break;
        case "released":
          started.reject(new Error("Process creation cancelled"));
          released.resolve();
          break;
      }
    });
    const job = {
      started: started.promise,
      exit: exit.promise,
      dispose: () =>
        (disposal ??= new Promise<void>((resolve, reject) => {
          // Bound the caller's wait; only release can relinquish child ownership.
          // @effect-diagnostics-next-line globalTimers:off -- this Promise adapter bounds callers without cancelling worker-owned cleanup.
          const timer = setTimeout(resolve, 1_000);
          const cleanup = async () => {
            Atomics.store(state, 1, 1);
            port1.postMessage("dispose");
            await released.promise;
            port1.close();
            worker.off("error", onError);
            worker.off("exit", onExit);
            jobs.delete(job);
            if (dead) return;
            if (closed || idle) {
              await stop(worker);
            } else {
              idle = worker;
              worker.unref();
            }
          };
          void cleanup().then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (error) => {
              clearTimeout(timer);
              reject(error);
            },
          );
        })),
    };
    jobs.add(job);
    worker.postMessage({ input, port: port2, control }, [port2]);
    return job;
  };

  return {
    start,
    close: async () => {
      closed = true;
      await Promise.all([...jobs].map((job) => job.dispose()));
      if (idle) {
        await stop(idle);
        idle = undefined;
      }
    },
  };
}
