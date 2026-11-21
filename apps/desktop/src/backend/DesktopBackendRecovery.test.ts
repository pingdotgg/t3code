// @effect-diagnostics nodeBuiltinImport:off - Drive actual macOS subprocesses and their file permissions.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { assert, describe, expect, it } from "@effect/vitest";

import { make } from "./DesktopBackendRecovery.ts";
import { loadMacProcessAuditToken } from "./MacProcessAuditToken.ts";

const childCode = `
  import { createServer } from "node:net";
  process.once("message", () => {
    const listener = createServer();
    listener.listen(0, "127.0.0.1", () => process.send(listener.address().port));
    setTimeout(() => listener.close(), 30_000).unref();
  });
`;

const launcherCode = `
  import { spawn } from "node:child_process";
  import { once } from "node:events";
  const [moduleUrl, appDataDirectory, stateDir, childCode] = process.argv.slice(1);
  const { make } = await import(moduleUrl);
  const recovery = make({
    appDataDirectory,
    stateDir,
    onRecovery: () => {},
    onError: (operation, error) => { throw new Error(operation, { cause: error }); },
  });
  const backend = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    detached: true,
  });
  await once(backend, "spawn");
  const forget = await recovery.track(backend.pid);
  if (!forget) throw new Error("Backend fixture was not recorded");
  const listening = once(backend, "message");
  backend.send("start");
  const [port] = await listening;
  process.send({ pid: backend.pid, port });
  await once(backend, "exit");
  await forget();
`;

async function spawnTrackedBackend(
  appDataDirectory: string,
  stateDir: string,
  cleanup: AsyncDisposableStack,
) {
  const moduleUrl = new URL("./DesktopBackendRecovery.ts", import.meta.url).href;
  const launcher = NodeChildProcess.spawn(
    NodeProcess.execPath,
    ["--input-type=module", "-e", launcherCode, moduleUrl, appDataDirectory, stateDir, childCode],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const exited = NodeEvents.EventEmitter.once(launcher, "exit");
  const stopLauncher = async () => {
    launcher.kill("SIGKILL");
    await exited;
  };
  cleanup.defer(stopLauncher);
  const backend = await Promise.race([
    NodeEvents.EventEmitter.once(launcher, "message").then(
      ([message]) => message as { pid: number; port: number },
    ),
    exited.then(() => {
      throw new Error("Fixture launcher exited before its backend was ready");
    }),
  ]);
  const native = await loadMacProcessAuditToken();
  const token = native.read(backend.pid);
  assert.isDefined(token);
  cleanup.defer(() => native.signal(token, "SIGKILL"));
  return { ...backend, token, stopLauncher };
}

async function checkPortIsFree(port: number) {
  const listener = NodeNet.createServer();
  listener.listen(port, "127.0.0.1");
  try {
    await NodeEvents.EventEmitter.once(listener, "listening");
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

describe.runIf(NodeProcess.platform === "darwin")("macOS desktop backend recovery", () => {
  it("cleans up a truncated record only after the writer releases it", async () => {
    await using cleanup = new AsyncDisposableStack();
    const stateDir = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-record-")),
    );
    cleanup.defer(() => NodeFSP.rm(stateDir, { recursive: true, force: true }));
    const directory = NodePath.join(stateDir, "t3code-backend-recovery");
    await NodeFSP.mkdir(directory, { mode: 0o700 });
    const scope = NodeCrypto.createHash("sha256")
      .update(JSON.stringify([stateDir, await NodeFSP.realpath(NodeProcess.execPath)]))
      .digest("hex");
    const path = () => NodePath.join(directory, `${scope}.${NodeCrypto.randomUUID()}.json`);
    const partial = path();
    const future = path();
    const unsafe = path();
    await NodeFSP.writeFile(future, '{"version":2}', { mode: 0o600 });
    await NodeFSP.writeFile(unsafe, "{", { mode: 0o600 });
    await NodeFSP.chmod(unsafe, 0o644);
    const errors: unknown[] = [];
    const recovered: number[] = [];
    const recovery = make({
      appDataDirectory: stateDir,
      stateDir,
      onRecovery: (pid) => recovered.push(pid),
      onError: (_, error) => errors.push(error),
    });
    {
      // Darwin O_EXLOCK keeps the record private to the writer until close or exit.
      await using writer = await NodeFSP.open(
        partial,
        NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | 0x20,
        0o600,
      );
      await writer.writeFile('{"version":');
      await recovery.recover();
      assert.equal(await NodeFSP.readFile(partial, "utf8"), '{"version":');
    }
    await recovery.recover();
    await recovery.recover();
    await expect(NodeFSP.stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
    assert.equal(await NodeFSP.readFile(future, "utf8"), '{"version":2}');
    assert.equal(await NodeFSP.readFile(unsafe, "utf8"), "{");
    assert.deepEqual(recovered, []);
    assert.deepEqual(errors, []);
  });

  it("releases a frozen orphan's port and leaves a backend with a live launcher running", async () => {
    await using cleanup = new AsyncDisposableStack();
    const appDataDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-backend-recovery-"),
    );
    cleanup.defer(() => NodeFSP.rm(appDataDirectory, { recursive: true, force: true }));
    // The first launcher records ownership before the home exists.
    const stateDir = NodePath.join(appDataDirectory, "home", "userdata");
    const orphan = await spawnTrackedBackend(appDataDirectory, stateDir, cleanup);
    await NodeFSP.mkdir(stateDir, { recursive: true });
    const live = await spawnTrackedBackend(appDataDirectory, stateDir, cleanup);
    const native = await loadMacProcessAuditToken();
    const recovered: number[] = [];
    const errors: unknown[] = [];
    const recovery = make({
      appDataDirectory,
      stateDir,
      onRecovery: (pid) => recovered.push(pid),
      onError: (_, error) => errors.push(error),
    });

    NodeProcess.kill(orphan.pid, "SIGSTOP");
    await orphan.stopLauncher();
    await expect(checkPortIsFree(orphan.port)).rejects.toMatchObject({ code: "EADDRINUSE" });

    const wrongVersion = Buffer.from(live.token, "hex");
    wrongVersion[28] = wrongVersion[28]! ^ 1;
    native.signal(wrongVersion.toString("hex"), "SIGKILL");
    assert.equal(native.read(live.pid), live.token);

    const otherHome = make({
      appDataDirectory,
      stateDir: NodePath.join(stateDir, "other"),
      onRecovery: (pid) => recovered.push(pid),
      onError: (_, error) => errors.push(error),
    });
    await otherHome.recover();
    assert.deepEqual(recovered, []);

    const records = NodePath.join(appDataDirectory, "t3code-backend-recovery");
    for (const name of await NodeFSP.readdir(records))
      await NodeFSP.chmod(NodePath.join(records, name), 0o644);
    await recovery.recover();
    assert.deepEqual(recovered, []);
    assert.equal(native.read(orphan.pid), orphan.token);
    for (const name of await NodeFSP.readdir(records))
      await NodeFSP.chmod(NodePath.join(records, name), 0o600);

    await recovery.recover();
    assert.deepEqual(errors, []);
    assert.deepEqual(recovered, [orphan.pid]);
    assert.isUndefined(native.read(orphan.pid));
    await checkPortIsFree(orphan.port);
    assert.equal(native.read(live.pid), live.token);
  });
});
