import assert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import test from "node:test";

import {
  resolveTaskkillExecutable,
  terminateWindowsProcessTree,
} from "./windows-process-tree.mjs";

test("terminateWindowsProcessTree targets only the owned PID tree", () => {
  const calls = [];
  const result = terminateWindowsProcessTree(4321, {
    force: true,
    env: { SystemRoot: "C:\\Windows" },
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(
    resolveTaskkillExecutable({ SystemRoot: "C:\\Windows" }),
    "C:\\Windows\\System32\\taskkill.exe",
  );
  assert.deepEqual(calls, [
    {
      command: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "4321", "/T", "/F"],
      options: { stdio: "ignore", windowsHide: true },
    },
  ]);
  assert.deepEqual(result, { attempted: true, ok: true, status: 0 });
});

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (NodeFS.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for process exit")), timeoutMs),
    ),
  ]);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "taskkill /T /F removes real Windows descendant trees across 20 restart cycles",
  { skip: process.platform !== "win32" },
  async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 tree José "));

    try {
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const receipt = NodePath.join(root, `pids-${iteration}.json`);
        const parentScript = `
          const { spawn } = require("node:child_process");
          const fs = require("node:fs");
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ parent: process.pid, child: child.pid }));
          setInterval(() => {}, 1000);
        `;
        const parent = NodeChildProcess.spawn(process.execPath, ["-e", parentScript], {
          stdio: "ignore",
          windowsHide: true,
        });

        try {
          await waitForFile(receipt);
          const pids = JSON.parse(NodeFS.readFileSync(receipt, "utf8"));
          assert.equal(pids.parent, parent.pid);
          assert.equal(isPidAlive(pids.child), true);

          const result = terminateWindowsProcessTree(parent.pid, { force: true });
          assert.equal(result.ok, true, `taskkill failed on iteration ${iteration}`);
          await waitForExit(parent);

          const deadline = Date.now() + 3000;
          while (Date.now() < deadline && isPidAlive(pids.child)) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.equal(isPidAlive(pids.child), false, `descendant survived iteration ${iteration}`);
        } finally {
          if (parent.exitCode === null) parent.kill();
        }
      }
    } finally {
      NodeFS.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  },
);
