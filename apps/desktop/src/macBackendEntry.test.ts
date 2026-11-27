// @effect-diagnostics nodeBuiltinImport:off - Runs the backend entry in a real child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

const entry = NodeURL.fileURLToPath(new URL("./macBackendEntry.ts", import.meta.url));

// A stand-in for the server's bin.mjs, which starts only when import.meta.main is true. It
// reports how it was started, then starts a worker thread and a fork.
const serverCode = `
  import { fork } from "node:child_process";
  import { once } from "node:events";
  import { Worker } from "node:worker_threads";
  const worker = new Worker(
    'require("node:worker_threads").parentPort.postMessage(process.execArgv)',
    { eval: true },
  );
  // Listen for both at once: the exit can land before a later once() is attached.
  const [[workerExecArgv], [workerExit]] = await Promise.all([
    once(worker, "message"),
    once(worker, "exit"),
  ]);
  const child = fork(process.argv[2], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const [[forkExecArgv], [forkExit]] = await Promise.all([
    once(child, "message"),
    once(child, "exit"),
  ]);
  process.stdout.write(JSON.stringify({
    main: import.meta.main,
    args: process.argv.slice(1),
    workerExecArgv, workerExit, forkExecArgv, forkExit,
  }));
`;

describe.runIf(NodeProcess.platform !== "win32")("macOS backend entry", () => {
  // Off macOS the re-exec fails and falls back, so this checks the entry in its final process.
  it("runs the server entry as main, and nothing it starts inherits the entry", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-backend-entry-"));
    try {
      const server = NodePath.join(directory, "bin.mjs");
      const forked = NodePath.join(directory, "fork.cjs");
      await NodeFSP.writeFile(server, serverCode);
      await NodeFSP.writeFile(forked, "process.send(process.execArgv, () => process.exit(0));");
      const backend = NodeChildProcess.spawn(NodeProcess.execPath, [entry, server, forked], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let output = "";
      backend.stdout.on("data", (chunk) => (output += chunk));
      const [code] = await NodeEvents.EventEmitter.once(backend, "close");
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(output), {
        main: true,
        args: [server, forked],
        workerExecArgv: [],
        workerExit: 0,
        forkExecArgv: [],
        forkExit: 0,
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
