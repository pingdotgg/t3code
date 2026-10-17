import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import { assert, describe, it } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Real host process table.
const hostPlatform = NodeOS.platform();
const modulePath = NodeURL.fileURLToPath(new URL("./dev-electron-parent.mjs", import.meta.url));

function isAlive(pid) {
  try {
    if (hostPlatform === "linux") {
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat[stat.lastIndexOf(")") + 2] === "Z") return false;
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

async function waitFor(read, timeoutMs = 4_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = read();
      if (value) {
        return value;
      }
    } catch {
      // The state file is written after the child starts.
    }

    await NodeTimersPromises.setTimeout(20);
  }

  throw new Error(`timed out after ${timeoutMs}ms`);
}

describe.skipIf(hostPlatform === "win32")("dev electron supervising parent", () => {
  it("exits after vp is killed even though the onSuccess shell stays alive", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-electron-parent-"));
    const statePath = NodePath.join(directory, "state.json");
    const metaPath = NodePath.join(directory, "meta.json");
    const childPath = NodePath.join(directory, "child.mjs");
    NodeFS.writeFileSync(
      childPath,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { captureSupervisingAncestors, createSupervisingParentWatch } from ${JSON.stringify(modulePath)};

const statePath = process.argv[2];
const ancestors = captureSupervisingAncestors();
let electron = null;
let restarts = 0;
let phase = "running";
const publish = () => writeFileSync(statePath, JSON.stringify({
  phase, pid: process.pid, ppid: process.ppid, electronPid: electron && electron.pid, restarts,
}));
const shutdown = () => {
  phase = "parent-gone";
  publish();
  if (electron && electron.exitCode === null && !electron.signalCode) electron.kill("SIGTERM");
  process.exit(0);
};
const watch = createSupervisingParentWatch(ancestors, shutdown, 40);
const spawnElectron = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
electron = spawnElectron();
restarts += 1;
publish();
setInterval(() => {
  if (watch.hasExited()) {
    shutdown();
    return;
  }
  if (!electron || electron.exitCode !== null || electron.signalCode) {
    electron = spawnElectron();
    restarts += 1;
    publish();
  }
}, 30);
`,
    );

    const parent = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("child_process");
const fs = require("fs");
const child = spawn(${JSON.stringify(process.execPath)} + " " + ${JSON.stringify(childPath)} + " " + ${JSON.stringify(statePath)}, [], { shell: true, stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(metaPath)}, JSON.stringify({ shellPid: child.pid }));
setInterval(() => {}, 1000);`,
      ],
      { stdio: "ignore" },
    );

    let shellPid = 0;
    let electronPid = 0;
    let supervisorPid = 0;
    try {
      const running = await waitFor(() => {
        const state = JSON.parse(NodeFS.readFileSync(statePath, "utf8"));
        return state.phase === "running" && state.restarts === 1 ? state : undefined;
      });
      electronPid = running.electronPid;
      supervisorPid = running.pid;
      shellPid = JSON.parse(NodeFS.readFileSync(metaPath, "utf8")).shellPid;
      assert.equal(running.ppid, shellPid);
      await NodeTimersPromises.setTimeout(180);
      assert.equal(isAlive(running.pid), true);
      assert.equal(JSON.parse(NodeFS.readFileSync(statePath, "utf8")).restarts, 1);

      process.kill(parent.pid, "SIGKILL");
      await waitFor(() => (isAlive(running.pid) ? undefined : true));

      const stopped = JSON.parse(NodeFS.readFileSync(statePath, "utf8"));
      assert.equal(stopped.phase, "parent-gone");
      assert.equal(stopped.restarts, 1);
      // ppid is still the onSuccess shell: it outlived vp.
      assert.equal(stopped.ppid, shellPid);
      await waitFor(() => (isAlive(electronPid) ? undefined : true));
      await NodeTimersPromises.setTimeout(200);
      assert.equal(JSON.parse(NodeFS.readFileSync(statePath, "utf8")).restarts, 1);
    } finally {
      for (const pid of [parent.pid, shellPid, electronPid, supervisorPid]) {
        if (typeof pid === "number" && pid > 1) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already exited.
          }
        }
      }
    }
  });
});
