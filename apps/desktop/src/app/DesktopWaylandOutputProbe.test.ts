// @effect-diagnostics nodeBuiltinImport:off - tests serve a fake Wayland compositor over real IPC.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  probeWaylandOutputCount,
  readProbeResult,
  resolveWaylandSocketPath,
} from "./DesktopWaylandOutputProbe.ts";

// The probe blocks the calling thread, so the compositor must answer from another thread.
const FAKE_COMPOSITOR_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const net = require("node:net");
const message = (objectId, opcode, body) => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(objectId, 0);
  header.writeUInt32LE(((8 + body.length) << 16) | opcode, 4);
  return Buffer.concat([header, body]);
};
const global = (name, iface) => {
  const padded = Math.ceil((iface.length + 1) / 4) * 4;
  const body = Buffer.alloc(12 + padded);
  body.writeUInt32LE(name, 0);
  body.writeUInt32LE(iface.length + 1, 4);
  body.write(iface, 8, "latin1");
  body.writeUInt32LE(1, 8 + padded);
  return message(2, 0, body);
};
const server = net.createServer((socket) => {
  socket.on("error", () => undefined);
  socket.once("data", () => {
    if (workerData.silent) return;
    const events = workerData.globals.map((iface, index) => global(index + 1, iface));
    const done = Buffer.alloc(4);
    events.push(message(3, 0, done));
    // Split mid-message to exercise reassembly.
    const stream = Buffer.concat(events);
    socket.write(stream.subarray(0, 10));
    setTimeout(() => socket.write(stream.subarray(10)), 5);
  });
});
server.listen(workerData.socketPath, () => parentPort.postMessage("listening"));
parentPort.on("message", () => server.close(() => process.exit(0)));
`;

const withFakeCompositor = async (
  options: { readonly globals?: ReadonlyArray<string>; readonly silent?: boolean },
  run: (socketPath: string) => void,
) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wayland-"));
  const socketPath =
    HostProcess.Platform.defaultValue() === "win32"
      ? "\\\\.\\pipe\\" + NodePath.basename(directory)
      : NodePath.join(directory, "wayland-1");
  const worker = new NodeWorkerThreads.Worker(FAKE_COMPOSITOR_SOURCE, {
    eval: true,
    workerData: { socketPath, globals: options.globals ?? [], silent: options.silent ?? false },
  });
  try {
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    run(socketPath);
  } finally {
    await worker.terminate();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

describe("DesktopWaylandOutputProbe", () => {
  it.each([
    { label: "no outputs", globals: ["wl_compositor", "xdg_wm_base"], expected: 0 },
    {
      label: "two outputs",
      globals: ["wl_compositor", "wl_output", "zxdg_output_manager_v1", "wl_output"],
      expected: 2,
    },
  ])("counts wl_output globals for $label", async ({ globals, expected }) => {
    await withFakeCompositor({ globals }, (socketPath) => {
      assert.equal(probeWaylandOutputCount(socketPath, 5000), expected);
    });
  });

  it("reports unknown when the compositor does not answer", async () => {
    await withFakeCompositor({ silent: true }, (socketPath) => {
      assert.isNull(probeWaylandOutputCount(socketPath, 50));
    });
  });

  it("never pairs a late completion flag with the count read before it", () => {
    // The worker publishes its count and flag right after the main thread's first read.
    const state = [0, 0];
    let reads = 0;
    const result = readProbeResult((index) => {
      const value = state[index]!;
      if (reads++ === 0) state.splice(0, 2, 1, 1);
      return value;
    });
    assert.isNull(result);
  });

  it("reports unknown when the socket does not exist", () => {
    assert.isNull(probeWaylandOutputCount("/nonexistent/t3-wayland-socket", 5000));
  });

  it.each([
    {
      env: { WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/1000" },
      expected: "/run/user/1000/wayland-1",
    },
    { env: { XDG_RUNTIME_DIR: "/run/user/1000" }, expected: "/run/user/1000/wayland-0" },
    { env: { WAYLAND_DISPLAY: "/tmp/custom-wayland" }, expected: "/tmp/custom-wayland" },
    { env: { WAYLAND_DISPLAY: "wayland-1" }, expected: null },
    { env: { WAYLAND_SOCKET: "3", XDG_RUNTIME_DIR: "/run/user/1000" }, expected: null },
  ])("resolves the socket path for $env", ({ env, expected }) => {
    assert.equal(resolveWaylandSocketPath(env), expected);
  });
});
