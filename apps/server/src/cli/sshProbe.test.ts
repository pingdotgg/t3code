// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

import { tryRunSshProbe } from "./sshProbe.ts";

const cliPath = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
// Reports on stderr when bin.ts falls through to the full CLI.
const preload = `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (result.url.endsWith("/binMain.ts")) process.stderr.write("CLI_LOADED\\n");
    return result;
  },
});`;

const listen = (server: NodeNet.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as NodeNet.AddressInfo).port)),
  );
const close = (server: NodeNet.Server) => new Promise((resolve) => server.close(resolve));

const runHelper = (args: ReadonlyArray<string>) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    NodeChildProcess.execFile(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        cliPath,
        "__ssh-helper",
        ...args,
      ],
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
  });

it("passes help and arguments the CLI would reject on to the CLI parser", async () => {
  assert.isFalse(await tryRunSshProbe(["runtime-port", "--help"]));
  assert.isFalse(await tryRunSshProbe(["runtime-port", "/tmp/runtime.json", "--help"]));
  assert.isFalse(await tryRunSshProbe(["wait-ready", "--help"]));
  assert.isFalse(await tryRunSshProbe(["wait-ready", "65536", "100", "100"]));
  assert.isFalse(await tryRunSshProbe(["wait-ready", "1234", "100", "-1"]));
  assert.isFalse(await tryRunSshProbe(["wait-ready", "01234", "100", "100"]));
  assert.isFalse(await tryRunSshProbe(["pick-port", "--help"]));
  assert.isFalse(await tryRunSshProbe(["pick-port", "/tmp/port", "65535", "2"]));
  assert.isFalse(await tryRunSshProbe(["home-owned", "/tmp/home"]));
});

it("answers the launch script's probes without loading the CLI", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-probe-"));
  const ready = NodeHttp.createServer((_request, response) => response.end());
  const refused = NodeNet.createServer();
  try {
    const readyPort = await listen(ready);
    const refusedPort = await listen(refused);
    await close(refused);
    const runtimeFile = NodePath.join(dir, "runtime.json");
    await NodeFSP.writeFile(
      runtimeFile,
      JSON.stringify({ pid: process.pid, port: readyPort, origin: "http://127.0.0.1" }),
    );

    const runtime = await runHelper(["runtime-port", runtimeFile]);
    assert.deepStrictEqual(runtime, {
      code: 0,
      stdout: `${process.pid} ${readyPort}`,
      stderr: "",
    });
    assert.deepStrictEqual(await runHelper(["runtime-port", NodePath.join(dir, "absent.json")]), {
      code: 1,
      stdout: "",
      stderr: "",
    });
    assert.deepStrictEqual(await runHelper(["wait-ready", String(readyPort), "5000", "1000"]), {
      code: 0,
      stdout: "",
      stderr: "",
    });
    assert.deepStrictEqual(await runHelper(["wait-ready", String(refusedPort), "200", "100"]), {
      code: 2,
      stdout: "",
      stderr: "",
    });
    const picked = await runHelper([
      "pick-port",
      NodePath.join(dir, "port"),
      String(refusedPort),
      "5",
    ]);
    assert.strictEqual(picked.code, 0);
    assert.match(picked.stdout, /^\d+$/);
    assert.strictEqual(picked.stderr, "");

    const help = await runHelper(["wait-ready", "--help"]);
    assert.strictEqual(help.code, 0);
    assert.include(help.stdout, "t3 __ssh-helper wait-ready");
    assert.include(help.stderr, "CLI_LOADED");
  } finally {
    ready.closeAllConnections();
    await close(ready);
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
