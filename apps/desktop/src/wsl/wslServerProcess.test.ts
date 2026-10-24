// @effect-diagnostics nodeBuiltinImport:off - Runs the launch and stop scripts in a real POSIX shell.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWslServerStopScript,
  initialWslServerProcessScan,
  scanWslServerStderr,
  WSL_SERVER_STOP_EXIT_CODE,
  wrapWslServerLaunch,
  type WslServerProcess,
} from "./wslServerProcess.ts";

// Each step is a separate shell, the way the desktop launches and stops the
// server through separate wsl.exe calls.
const runShell = (script: string) =>
  NodeChildProcess.spawnSync("sh", ["-s"], { input: script, encoding: "utf8" });

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const launch = (command: string): WslServerProcess => {
  const wrapped = wrapWslServerLaunch(["sh", "-c", command]).map(quote).join(" ");
  const result = runShell(
    [
      "stderr=$(mktemp)",
      `${wrapped} </dev/null >/dev/null 2>"$stderr" &`,
      'until grep -q . "$stderr"; do sleep 0.01; done',
      'cat "$stderr"',
      'rm -f "$stderr"',
    ].join("\n"),
  );
  const scan = scanWslServerStderr(
    initialWslServerProcessScan,
    new TextEncoder().encode(result.stdout),
  );
  if (scan.process === null) throw new Error(`no server process line in: ${result.stdout}`);
  return scan.process;
};

const isAlive = (pid: number) =>
  runShell(
    `s=$(cat /proc/${pid}/stat 2>/dev/null) || exit 1\ncase "\${s##*) }" in Z*) exit 1;; esac`,
  ).status === 0;

const kill = (pid: number) => runShell(`kill -KILL ${pid} 2>/dev/null`);

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "WSL server stop script (executed)",
  () => {
    it("stops the process the launch wrapper started and waits for it to exit", () => {
      const server = launch("exec sleep 30");
      try {
        expect(isAlive(server.pid)).toBe(true);

        const stop = runShell(buildWslServerStopScript(server, 2_000));

        expect(stop.status).toBe(WSL_SERVER_STOP_EXIT_CODE.exited);
        expect(isAlive(server.pid)).toBe(false);
      } finally {
        kill(server.pid);
      }
    });

    it("never signals a process whose start time does not match", () => {
      const server = launch("exec sleep 30");
      try {
        const reused = { pid: server.pid, startTime: String(Number(server.startTime) + 1) };

        const stop = runShell(buildWslServerStopScript(reused, 2_000));

        expect(stop.status).toBe(WSL_SERVER_STOP_EXIT_CODE.notRunning);
        expect(isAlive(server.pid)).toBe(true);
      } finally {
        kill(server.pid);
      }
    });

    it("gives up after the grace period when the process ignores SIGTERM", () => {
      const server = launch("trap '' TERM; while :; do sleep 0.1; done");
      try {
        const stop = runShell(buildWslServerStopScript(server, 300));

        expect(stop.status).toBe(WSL_SERVER_STOP_EXIT_CODE.timedOut);
        expect(isAlive(server.pid)).toBe(true);
      } finally {
        kill(server.pid);
      }
    });
  },
);
