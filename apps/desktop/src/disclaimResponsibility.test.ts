// @effect-diagnostics nodeBuiltinImport:off - Runs the preload in a real child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import type * as NodeStream from "node:stream";

import { assert, describe, it } from "@effect/vitest";

import {
  BACKEND_PRELOAD_ENV,
  BACKEND_SETTLED_ACK_FD,
  BACKEND_SETTLED_LINE,
} from "./macHelperExec.ts";

const preload = new URL("./disclaimResponsibility.ts", import.meta.url).pathname;

// Off macOS the re-exec fails and falls back, so this exercises the handshake in its final process.
async function startBackend(script: string, ack: (input: NodeStream.Writable) => void) {
  const backend = NodeChildProcess.spawn(
    NodeProcess.execPath,
    ["--require", preload, "-e", script],
    {
      stdio: ["ignore", "pipe", "inherit", "ignore", "ignore", "pipe", "ignore", "ignore", "pipe"],
      env: { ...NodeProcess.env, [BACKEND_PRELOAD_ENV]: "1" },
    },
  );
  const pipes: ReadonlyArray<unknown> = backend.stdio;
  const controlChannel = pipes[5] as NodeStream.Readable;
  let output = "";
  let control = "";
  backend.stdout?.on("data", (chunk) => (output += chunk));
  controlChannel.on("data", (chunk) => (control += chunk));
  const exited = NodeEvents.EventEmitter.once(backend, "close");
  await NodeEvents.EventEmitter.once(controlChannel, "data");
  ack(pipes[BACKEND_SETTLED_ACK_FD] as NodeStream.Writable);
  const [code] = await exited;
  return { code, output, control };
}

const acknowledge = (input: NodeStream.Writable) => input.end(Buffer.from([1]));

describe.runIf(NodeProcess.platform !== "win32")("disclaim responsibility preload", () => {
  it("starts the server only after the desktop acknowledges the backend", async () => {
    assert.deepEqual(await startBackend('process.stdout.write("server started")', acknowledge), {
      code: 0,
      output: "server started",
      control: BACKEND_SETTLED_LINE,
    });
  });

  it("stops the backend when the desktop goes away before acknowledging it", async () => {
    assert.deepEqual(
      await startBackend('process.stdout.write("server started")', (input) => input.end()),
      { code: 1, output: "", control: BACKEND_SETTLED_LINE },
    );
  });

  it("acts once, leaving the backend's workers and forks alone", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-preload-"));
    try {
      const forked = NodePath.join(directory, "fork.cjs");
      await NodeFSP.writeFile(
        forked,
        `process.send(process.env.${BACKEND_PRELOAD_ENV} ?? null, () => process.exit(0));`,
      );
      const script = `
        const { Worker } = require("node:worker_threads");
        const { fork } = require("node:child_process");
        const { once } = require("node:events");
        (async () => {
          const worker = new Worker(
            'require("node:worker_threads").parentPort.postMessage(process.env.${BACKEND_PRELOAD_ENV} ?? null)',
            { eval: true },
          );
          const [workerMarker] = await once(worker, "message");
          const [workerExit] = await once(worker, "exit");
          const child = fork(${JSON.stringify(forked)}, { stdio: ["ignore", "ignore", "inherit", "ipc"] });
          const [forkMarker] = await once(child, "message");
          const [forkExit] = await once(child, "exit");
          process.stdout.write(JSON.stringify({
            marker: process.env.${BACKEND_PRELOAD_ENV} ?? null,
            preloaded: process.execArgv.includes(${JSON.stringify(preload)}),
            workerMarker, workerExit, forkMarker, forkExit,
          }));
        })();
      `;
      const { code, output, control } = await startBackend(script, acknowledge);
      assert.equal(code, 0);
      assert.equal(control, BACKEND_SETTLED_LINE);
      assert.deepEqual(JSON.parse(output), {
        marker: null,
        preloaded: false,
        workerMarker: null,
        workerExit: 0,
        forkMarker: null,
        forkExit: 0,
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
