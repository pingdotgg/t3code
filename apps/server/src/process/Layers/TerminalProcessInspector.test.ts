import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { TerminalProcessInspector } from "../Services/TerminalProcessInspector.ts";
import { TerminalProcessInspectorLive } from "./TerminalProcessInspector.ts";

type ListenerProcess = ChildProcessByStdio<null, Readable, Readable>;

interface StartedProcess {
  readonly process: ListenerProcess;
  readonly port: number;
}

const stopProcess = (child: ChildProcess) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }

    child.kill("SIGTERM");

    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 1_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resume(Effect.void);
    });
  });

const waitForPort = (child: ListenerProcess) =>
  Effect.callback<number, Error>((resume) => {
    const timeout = setTimeout(() => {
      cleanup();
      resume(Effect.fail(new Error("Timed out waiting for listener port")));
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
      resume(Effect.succeed(port));
    };

    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };

    const onExit = (code: number | null) => {
      cleanup();
      resume(
        Effect.fail(
          new Error(
            `Listener process exited before reporting port (code=${String(code)}): ${stderr.trim()}`,
          ),
        ),
      );
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);

    return Effect.sync(cleanup);
  });

const startListenerProcess = Effect.gen(function* () {
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
  const port = yield* waitForPort(process);
  return { process, port } satisfies StartedProcess;
});

const nodeChildProcessLayer = NodeChildProcessSpawner.layer.pipe(Layer.provide(NodeServices.layer));

const testLayer = TerminalProcessInspectorLive.pipe(Layer.provide(nodeChildProcessLayer));

it.layer(testLayer)("TerminalProcessInspectorLive", (it) => {
  it.effect("detects listening ports when the terminal root pid is the listener", () =>
    Effect.acquireUseRelease(
      startListenerProcess,
      ({ process, port }) =>
        Effect.gen(function* () {
          const listenerPid = process.pid;
          if (!listenerPid) {
            return yield* Effect.fail(new Error("Listener process pid missing"));
          }

          const inspector = yield* TerminalProcessInspector;
          const activity = yield* inspector.inspect(listenerPid);

          assert.equal(activity.hasRunningSubprocess, true);
          assert.deepStrictEqual(activity.runningPorts.includes(port), true);
        }),
      ({ process }) => stopProcess(process),
    ),
  );

  it.effect("returns idle activity when root process has no children and no listening ports", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        spawn("node", ["-e", "setInterval(() => {}, 10_000)"], {
          stdio: ["ignore", "ignore", "ignore"],
        }),
      ),
      (process) =>
        Effect.gen(function* () {
          const idlePid = process.pid;
          if (!idlePid) {
            return yield* Effect.fail(new Error("Idle process pid missing"));
          }

          const inspector = yield* TerminalProcessInspector;
          const activity = yield* inspector.inspect(idlePid);

          assert.equal(activity.hasRunningSubprocess, false);
          assert.deepStrictEqual(activity.runningPorts, []);
        }),
      stopProcess,
    ),
  );
});
