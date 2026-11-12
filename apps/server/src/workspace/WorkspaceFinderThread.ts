// @effect-diagnostics nodeBuiltinImport:off -- fff's native calls block their thread, so each finder owns a Node worker.
import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";

import type { FileFinder, InitOptions, Result } from "@ff-labs/fff-node";
import * as Context from "effect/Context";

type FinderMethod =
  | "destroy"
  | "directorySearch"
  | "fileSearch"
  | "grep"
  | "isScanning"
  | "mixedSearch"
  | "scanFiles"
  | "waitForIndexReady";

export interface ThreadedFinder {
  readonly call: <M extends FinderMethod>(
    method: M,
    ...args: Parameters<FileFinder[M]>
  ) => Promise<Awaited<ReturnType<FileFinder[M]>>>;
  /** Stops the thread once any native call in flight returns; call `destroy` first. */
  readonly close: () => Promise<void>;
}

export type OpenFinder = (options: InitOptions) => Promise<Result<ThreadedFinder>>;

// An inline worker needs no extra build entry, so src, dist, the single executable and Electron all load it.
// Eval workers define a global `__dirname` of ".", which fff-node would use to look for its native library.
const FINDER_WORKER_SOURCE = `
delete globalThis.__dirname;
delete globalThis.__filename;
const { parentPort, workerData } = require("node:worker_threads");
const { FileFinder } = require(workerData.fffEntryPath);
const created = FileFinder.create(workerData.options);
parentPort.postMessage({ created: created.ok ? { ok: true } : created });
if (created.ok) {
  const finder = created.value;
  parentPort.on("message", async ({ id, method, args }) => {
    try {
      parentPort.postMessage({ id, value: await finder[method](...args) });
    } catch (cause) {
      parentPort.postMessage({ id, failed: true, cause });
    }
  });
}
`;

// Node's watch mode posts its own `watch:require` messages on the same port, so every reply is tagged.
type WorkerMessage =
  | { readonly created: Result<undefined> }
  | { readonly id: number; readonly value: unknown }
  | { readonly id: number; readonly failed: true; readonly cause: unknown };

// fff-node's native library stays external; single-executables require disk packages instead of importing them.
const requireForFff = NodeModule.createRequire(import.meta.url);
const fffEntryPath = requireForFff.resolve("@ff-labs/fff-node");
// ffi-rs crashes the process when the first thread that loaded it exits, so the main thread loads it first.
requireForFff(fffEntryPath);

const openWorkerFinder: OpenFinder = (options) =>
  new Promise((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(FINDER_WORKER_SOURCE, {
      eval: true,
      workerData: { fffEntryPath, options },
    });
    worker.unref();
    const pending = new Map<
      number,
      { readonly resolve: (value: never) => void; readonly reject: (cause: unknown) => void }
    >();
    let nextId = 0;
    let failure: unknown;
    const fail = (cause: unknown) => {
      failure ??= cause;
      reject(failure);
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`The fff worker exited with code ${code}.`)));

    const call: ThreadedFinder["call"] = (method, ...args) =>
      new Promise((resolveCall, rejectCall) => {
        if (failure !== undefined) {
          rejectCall(failure);
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        worker.postMessage({ id, method, args });
      });

    worker.on("message", (message: WorkerMessage) => {
      if ("created" in message) {
        resolve(
          message.created.ok
            ? { ok: true, value: { call, close: () => worker.terminate().then(() => undefined) } }
            : message.created,
        );
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if ("failed" in message) request.reject(message.cause);
      else request.resolve(message.value as never);
    });
  });

/** Opens fff finders off the server's event loop, where a native call can block for as long as a file read. */
export const WorkspaceFinderOpener = Context.Reference<OpenFinder>(
  "t3/workspace/WorkspaceFinderThread/WorkspaceFinderOpener",
  { defaultValue: () => openWorkerFinder },
);
