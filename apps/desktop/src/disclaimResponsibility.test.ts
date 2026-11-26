// @effect-diagnostics nodeBuiltinImport:off - Runs the preload in a real child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeProcess from "node:process";
import type * as NodeStream from "node:stream";

import { assert, describe, it } from "@effect/vitest";

import { BACKEND_SETTLED_ACK_FD, BACKEND_SETTLED_LINE } from "./macHelperExec.ts";

const preload = new URL("./disclaimResponsibility.ts", import.meta.url).pathname;

// Off macOS the re-exec fails and falls back, so this exercises the handshake in its final process.
async function startBackend(ack: (input: NodeStream.Writable) => void) {
  const backend = NodeChildProcess.spawn(
    NodeProcess.execPath,
    ["--require", preload, "-e", 'process.stdout.write("server started")'],
    { stdio: ["ignore", "pipe", "ignore", "ignore", "ignore", "pipe", "ignore", "ignore", "pipe"] },
  );
  const pipes: ReadonlyArray<unknown> = backend.stdio;
  let output = "";
  backend.stdout?.on("data", (chunk) => (output += chunk));
  const exited = NodeEvents.EventEmitter.once(backend, "close");
  const [settled] = await NodeEvents.EventEmitter.once(pipes[5] as NodeStream.Readable, "data");
  assert.equal(String(settled), BACKEND_SETTLED_LINE);
  ack(pipes[BACKEND_SETTLED_ACK_FD] as NodeStream.Writable);
  const [code] = await exited;
  return { code, output };
}

describe.runIf(NodeProcess.platform !== "win32")("disclaim responsibility preload", () => {
  it("starts the server only after the desktop acknowledges the backend", async () => {
    assert.deepEqual(await startBackend((input) => input.end(Buffer.from([1]))), {
      code: 0,
      output: "server started",
    });
  });

  it("stops the backend when the desktop goes away before acknowledging it", async () => {
    assert.deepEqual(await startBackend((input) => input.end()), { code: 1, output: "" });
  });
});
