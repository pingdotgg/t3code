import * as NodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, it } from "vite-plus/test";

import { bindToParentLifetime } from "./opencodeRuntime.ts";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};

const readLine = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    let buffer = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(buffer.slice(0, newline).trim());
    });
    stream.on("error", reject);
  });

const serverScript = "console.log(process.pid); setInterval(() => {}, 1e9);";

describe.skipIf(process.platform === "win32")("bindToParentLifetime", () => {
  it("stops the server when its parent dies without running cleanup", async () => {
    const wrapped = bindToParentLifetime(process.execPath, ["-e", serverScript]);
    // The intermediate parent stands in for the T3 server: it owns the stdin
    // pipe and is SIGKILLed, so no finalizer gets a chance to run.
    const parentScript = `
      const { spawn } = require("node:child_process");
      const child = spawn(${JSON.stringify(wrapped.command)}, ${JSON.stringify(wrapped.args)}, {
        detached: true,
        stdio: ["pipe", "pipe", "inherit"],
      });
      child.stdout.pipe(process.stdout);
      setInterval(() => {}, 1e9);
    `;
    const parent = spawn(process.execPath, ["-e", parentScript], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const serverPid = Number(await readLine(parent.stdout!));
    NodeAssert.ok(serverPid > 0 && isAlive(serverPid), "server should be running");

    parent.kill("SIGKILL");
    await once(parent, "exit");

    NodeAssert.ok(
      await waitFor(() => !isAlive(serverPid), 5_000),
      "server must exit once its parent is gone",
    );
  });

  it("forwards the server's stdout and exit status", async () => {
    const wrapped = bindToParentLifetime(process.execPath, [
      "-e",
      "console.log('ready'); process.exit(7);",
    ]);
    const child = spawn(wrapped.command, [...wrapped.args], {
      detached: true,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const line = readLine(child.stdout!);
    const [code] = await once(child, "exit");
    NodeAssert.equal(await line, "ready");
    NodeAssert.equal(code, 7);
  });

  it("still stops with a process-group signal from a live parent", async () => {
    const wrapped = bindToParentLifetime(process.execPath, ["-e", serverScript]);
    const child = spawn(wrapped.command, [...wrapped.args], {
      detached: true,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const serverPid = Number(await readLine(child.stdout!));
    process.kill(-child.pid!, "SIGTERM");
    NodeAssert.ok(await waitFor(() => !isAlive(serverPid), 5_000));
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Group already gone.
    }
  });
});
