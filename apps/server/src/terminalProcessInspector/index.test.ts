import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { defaultSubprocessInspector } from "./index";

interface StartedProcess {
  process: ChildProcessWithoutNullStreams;
  port: number;
}

async function waitForPort(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for listener port"));
    }, 3_000);

    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/PORT:(\d+)/);
      if (!match?.[1]) return;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port <= 0) return;
      cleanup();
      resolve(port);
    };

    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Listener process exited before reporting port (code=${String(code)}): ${stderr.trim()}`,
        ),
      );
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function startListenerProcess(): Promise<StartedProcess> {
  const script = [
    "const { createServer } = require('node:http');",
    "const server = createServer((_req, res) => {",
    "  res.statusCode = 200;",
    "  res.end('ok');",
    "});",
    "server.listen(0, '127.0.0.1', () => {",
    "  const address = server.address();",
    "  if (typeof address !== 'object' || !address) process.exit(1);",
    "  console.log(`PORT:${address.port}`);",
    "});",
    "const shutdown = () => server.close(() => process.exit(0));",
    "process.on('SIGTERM', shutdown);",
    "process.on('SIGINT', shutdown);",
    "setInterval(() => {}, 10_000);",
  ].join("");

  const process = spawn("node", ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await waitForPort(process);
  return { process, port };
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("defaultSubprocessInspector", () => {
  const spawned: ChildProcessWithoutNullStreams[] = [];

  afterEach(async () => {
    await Promise.all(spawned.splice(0, spawned.length).map((child) => stopProcess(child)));
  });

  it("detects listening ports when the terminal root PID is the listener", async () => {
    const listener = await startListenerProcess();
    spawned.push(listener.process);

    const activity = await defaultSubprocessInspector(listener.process.pid);

    expect(activity.hasRunningSubprocess).toBe(true);
    expect(activity.runningPorts).toContain(listener.port);
  });

  it("returns idle activity when root process has no children and no listening ports", async () => {
    const idle = spawn("node", ["-e", "setInterval(() => {}, 10_000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    spawned.push(idle);

    const activity = await defaultSubprocessInspector(idle.pid);

    expect(activity.hasRunningSubprocess).toBe(false);
    expect(activity.runningPorts).toEqual([]);
  });
});
