/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker ports have no browser origin. */
// @effect-diagnostics nodeBuiltinImport:off -- gates native termination in an isolated worker with real children.
import * as NodeModule from "node:module";
import * as NodeTest from "node:test";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

const { mode, descendant } = NodeWorkerThreads.workerData as {
  mode: "normal" | "taskkill" | "child-exit";
  descendant: string;
};
const parent = NodeWorkerThreads.parentPort!;
const require = NodeModule.createRequire(import.meta.url);
const workers = require("node:worker_threads") as typeof NodeWorkerThreads;
const Worker = workers.Worker;
const MessageChannel = workers.MessageChannel;
const owners: NodeWorkerThreads.Worker[] = [];
const gates: NodeWorkerThreads.MessagePort[] = [];
const channels: NodeWorkerThreads.MessagePort[] = [];
const blocked = Promise.withResolvers<void>();
void blocked.promise.catch(() => {});
const prelude = `{
  const cp = require("node:child_process");
  const { parentPort, workerData } = require("node:worker_threads");
  const spawn = cp.spawn, execFile = cp.execFile;
  let held, pid;
  cp.spawn = function(command, args, options) {
    const child = spawn(command, args, options);
    if (args.includes("t3-25245-cleanup-gate")) {
      pid = child.pid;
      if (workerData.mode === "child-exit") child.kill = () => {
        parentPort.postMessage("blocked");
        return false;
      };
    }
    return child;
  };
  cp.execFile = function(command, args, options, callback) {
    if (command !== "taskkill" || args[1] !== String(pid) || workerData.mode === "normal")
      return execFile(command, args, options, callback);
    held = () => execFile(command, args, options, workerData.mode === "taskkill" ? callback : () => {});
    if (workerData.mode === "taskkill") parentPort.postMessage("blocked");
    else callback(new Error("Fixture taskkill failed"));
  };
  workerData.cleanupControl.on("message", () => { const release = held; held = undefined; release?.(); });
  workerData.cleanupControl.unref();
}`;
workers.Worker = class extends Worker {
  constructor(filename: string | URL, options?: NodeWorkerThreads.WorkerOptions) {
    const { port1, port2 } = new MessageChannel();
    super(typeof filename === "string" && options?.eval ? prelude + filename : filename, {
      ...options,
      workerData: { ...options?.workerData, mode, cleanupControl: port2 },
      transferList: [...(options?.transferList ?? []), port2],
    });
    gates.push(port1);
    port1.unref();
    owners.push(this);
    this.on("message", (message: unknown) => {
      if (message === "blocked") blocked.resolve();
    });
    this.once("error", blocked.reject);
    this.once("exit", () => blocked.reject(new Error("Cleanup owner exited before termination")));
  }
};
workers.MessageChannel = class extends MessageChannel {
  constructor() {
    super();
    channels.push(this.port1);
  }
};
NodeModule.syncBuiltinESMExports();

const { makePool } = await import("./windowsProcessWorker.ts");
const pool = makePool();
const input = { command: process.execPath, env: process.env, shell: false };
const job = pool.start({
  ...input,
  args: [
    "-e",
    `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true}); process.stdin.resume();`,
    "t3-25245-cleanup-gate",
  ],
});
const owner = owners[0]!;
const released = new Promise<void>((resolve) => channels[0]!.once("close", () => resolve()));
const ownerStopped = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
let exited = false;
void job.exit.then(
  () => {
    exited = true;
  },
  () => {
    exited = true;
  },
);
let other: ReturnType<typeof pool.start> | undefined;
try {
  await job.started;
  parent.postMessage({ type: "started" });
  await new Promise<void>((resolve) => parent.once("message", () => resolve()));
  const acquired = Promise.withResolvers<void>();
  const running = Effect.runFork(
    Effect.acquireRelease(
      Effect.sync(() => {
        acquired.resolve();
        return job;
      }),
      (job) => Effect.promise(() => job.dispose()),
    ).pipe(Effect.andThen(Effect.never), Effect.scoped),
  );
  await acquired.promise;
  NodeTest.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const disposal = Effect.runPromise(Fiber.interrupt(running)).then(() => {
    settled = true;
  });
  if (mode === "normal") await disposal;
  else {
    await blocked.promise;
    NodeTest.mock.timers.runAll();
  }
  NodeTest.mock.timers.reset();
  other = pool.start({ ...input, args: ["-e", "process.stdin.resume()"] });
  await other.started;
  const separateOwner = owners.length === 2;
  let closed = false;
  if (mode === "child-exit" && settled) {
    await pool.close();
    closed = true;
  }
  parent.postMessage({
    type: "disposed",
    settled,
    exited,
    separateOwner,
    live: owner.threadId !== -1,
    closed,
  });
  await new Promise<void>((resolve) => parent.once("message", () => resolve()));
  if (mode !== "normal") gates[0]!.postMessage("release");
  await released;
  await disposal;
  let reused = false;
  if (mode === "taskkill") {
    const count = owners.length;
    const next = pool.start({ ...input, args: ["-e", ""] });
    await next.started;
    await next.exit;
    reused = owners.length === count;
    await next.dispose();
  }
  await other.dispose();
  await pool.close();
  await ownerStopped;
  parent.postMessage({ type: "cleaned", reused });
} finally {
  NodeTest.mock.timers.reset();
  if (mode !== "normal") gates[0]!.postMessage("release");
  await other?.dispose();
  await job.dispose();
  await pool.close();
  for (const gate of gates) gate.close();
  parent.close();
}
