// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
// shared fixtures for PortScanner (never imports the test file)
// @effect-diagnostics nodeBuiltinImport:off -- the stop test drives real server processes.
import * as NodeChildProcess from "node:child_process";

import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import * as ProcessGroup from "@t3tools/provider-core/server/processGroup";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";
import { FetchHttpClient } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";

export const processProbeFailure: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: input.command,
      argumentCount: input.args.length,
      cwd: input.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "PowerShell is not installed in the test environment",
      }),
    }),
  );


export const layerNoProc = FileSystem.layerNoop({});


export const layerProbeFailure = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
  fileSystem: Layer.Layer<FileSystem.FileSystem> = layerNoProc,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fileSystem,
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );


export const LSOF_TEST_PORT = 43_123;


export const processOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});


export const ownedScanner = (processIds: ReadonlyArray<number> = [1234]) =>
  Effect.tap(PortScanner.PortDiscovery, (scanner) =>
    scanner.registerTerminalProcesses({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
      processIds,
    }),
  );


export const layerLsofScanner = (input: {
  readonly pid: () => number;
  readonly fetch: typeof globalThis.fetch;
  readonly stdout?: () => string;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProc,
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: input.stdout?.() ?? `p${input.pid()}\ncnode\nn*:${LSOF_TEST_PORT}\n`,
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );

export const AGENT_SERVER_SCRIPT = `
const server = require("node:http").createServer((_, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<html></html>");
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(process.pid + " " + server.address().port + "\\n");
});
`;


export const agentServer = () =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly child: NodeChildProcess.ChildProcess;
      readonly pid: number;
      readonly port: number;
      readonly exited: Promise<void>;
    }>((resume) => {
      const env = { ...process.env, [PortScanner.AGENT_THREAD_ENV]: "thread-live" };
      // dash ignores `set -m` without a terminal; bash, like agent tool shells, honors it.
      const child = NodeChildProcess.spawn(
        "bash",
        ["-c", 'set -m; "$0" -e "$1" & wait', process.execPath, AGENT_SERVER_SCRIPT],
        { detached: true, env, stdio: ["ignore", "pipe", "ignore"] },
      );
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.once("error", (error) => resume(Effect.die(error)));
      child.stdout?.once("data", (chunk) => {
        const [pid, port] = String(chunk).trim().split(" ").map(Number);
        resume(Effect.succeed({ child, pid: pid!, port: port!, exited }));
      });
    }),
    ({ child, pid }) =>
      Effect.sync(() => {
        for (const target of [pid, child.pid]) {
          try {
            if (target !== undefined) process.kill(target, "SIGKILL");
          } catch {}
        }
      }),
  );


export const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
