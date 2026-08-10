import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const isWindows = process.platform === "win32";

async function waitForFile(filePath, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test(
  "Windows atomic replacement survives a temporarily exclusive target handle",
  { skip: !isWindows },
  async () => {
    const [Effect, FileSystem, NodeServices, retryModule] = await Promise.all([
      import("effect/Effect"),
      import("effect/FileSystem"),
      import("@effect/platform-node/NodeServices"),
      import("../packages/shared/src/windowsFileRetry.ts"),
    ]);
    const root = await mkdtemp(path.join(os.tmpdir(), "t3-persist-Ω-"));
    const target = path.join(root, "state José", "desktop-settings.json");
    const temporary = `${target}.next.tmp`;
    const ready = path.join(root, "lock-ready.txt");
    const ps1 = path.join(root, "hold-lock.ps1");
    await writeFile(target, "before\n", { recursive: false }).catch(async (error) => {
      if (error?.code !== "ENOENT") throw error;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "before\n");
    });
    await writeFile(temporary, "after\n");
    await writeFile(
      ps1,
      [
        "param([string]$Target, [string]$Ready)",
        "$stream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)",
        "try {",
        "  [System.IO.File]::WriteAllText($Ready, 'ready')",
        "  Start-Sleep -Milliseconds 700",
        "} finally {",
        "  $stream.Dispose()",
        "}",
      ].join("\r\n"),
    );

    const locker = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, target, ready],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    locker.stderr.setEncoding("utf8");
    locker.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    try {
      await waitForFile(ready);
      let attempts = 0;
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* retryModule.retryWindowsFileSystemOperation(
            Effect.suspend(() => {
              attempts += 1;
              return fs.rename(temporary, target);
            }),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      const exitCode = await new Promise((resolve, reject) => {
        locker.once("error", reject);
        locker.once("exit", resolve);
      });
      assert.equal(exitCode, 0, stderr);
      assert.ok(attempts > 1, `expected a Windows sharing violation retry, attempts=${attempts}`);
      assert.equal(await readFile(target, "utf8"), "after\n");
    } finally {
      if (locker.exitCode === null) locker.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
);
