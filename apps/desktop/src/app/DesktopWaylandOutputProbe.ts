// @effect-diagnostics nodeBuiltinImport:off - Chromium starts its UI right after the main script returns, so this probe must block synchronously before any Effect runtime.
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

// Sends wl_display.get_registry and wl_display.sync, then counts wl_output globals until the
// sync callback fires. Plain JS so the eval worker needs no bundled module.
const PROBE_WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const net = require("node:net");
const state = new Int32Array(workerData.shared);
let done = false;
let outputs = 0;
let pending = Buffer.alloc(0);
let socket;
const finish = (result) => {
  if (done) return;
  done = true;
  Atomics.store(state, 1, result);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
  socket?.destroy();
};
process.on("uncaughtException", () => finish(-1));
socket = net.createConnection(workerData.socketPath);
socket.on("connect", () => {
  const request = Buffer.alloc(24);
  request.writeUInt32LE(1, 0);
  request.writeUInt32LE((12 << 16) | 1, 4);
  request.writeUInt32LE(2, 8);
  request.writeUInt32LE(1, 12);
  request.writeUInt32LE(12 << 16, 16);
  request.writeUInt32LE(3, 20);
  socket.write(request);
});
socket.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 8) {
    const objectId = pending.readUInt32LE(0);
    const opcode = pending.readUInt32LE(4) & 0xffff;
    const size = pending.readUInt32LE(4) >>> 16;
    if (size < 8) return finish(-1);
    if (pending.length < size) return;
    if (objectId === 2 && opcode === 0 && size >= 16) {
      const length = pending.readUInt32LE(12);
      if (length > 0 && 16 + length <= size && pending.toString("latin1", 16, 15 + length) === "wl_output") outputs++;
    } else if (objectId === 3 && opcode === 0) {
      return finish(outputs);
    } else if (objectId === 1 && opcode === 0) {
      return finish(-1);
    }
    pending = pending.subarray(size);
  }
});
socket.on("error", () => finish(-1));
socket.on("close", () => finish(-1));
`;

/** libwayland's client socket lookup; null when the connection comes from WAYLAND_SOCKET or cannot be located. */
export function resolveWaylandSocketPath(env: NodeJS.ProcessEnv): string | null {
  if (env.WAYLAND_SOCKET) return null;
  const display = env.WAYLAND_DISPLAY || "wayland-0";
  if (NodePath.posix.isAbsolute(display)) return display;
  return env.XDG_RUNTIME_DIR ? NodePath.posix.join(env.XDG_RUNTIME_DIR, display) : null;
}

// The worker stores the count before the flag, so the count is only valid once the flag reads 1.
export const readProbeResult = (load: (index: 0 | 1) => number): number | null => {
  if (load(0) !== 1) return null;
  const outputs = load(1);
  return outputs >= 0 ? outputs : null;
};

/** Number of wl_output globals the compositor advertises, or null when it does not answer in time. */
export function probeWaylandOutputCount(socketPath: string, timeoutMs: number): number | null {
  const shared = new SharedArrayBuffer(8);
  const state = new Int32Array(shared);
  let worker: NodeWorkerThreads.Worker | undefined;
  try {
    worker = new NodeWorkerThreads.Worker(PROBE_WORKER_SOURCE, {
      eval: true,
      workerData: { shared, socketPath },
    });
    // An unhandled worker error would surface later as an uncaught main-process exception.
    worker.on("error", () => undefined);
    worker.unref();
    Atomics.wait(state, 0, 0, timeoutMs);
  } catch {
    return null;
  } finally {
    void worker?.terminate();
  }
  return readProbeResult((index) => Atomics.load(state, index));
}
