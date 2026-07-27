#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off - This script intentionally measures a child process with host APIs.

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";

const args = process.argv.slice(2);
const readArg = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const homeDir = NodePath.resolve(readArg("--home-dir") ?? ".t3/startup-profile");
const outputDir = NodePath.resolve(readArg("--output-dir") ?? NodePath.join(homeDir, "profile"));
const command = readArg("--command") ?? "dev";
const stopAfter = readArg("--stop-after") ?? "pairing-url-emitted";
const timeoutMs = Number(readArg("--timeout-ms") ?? "30000");
const hostPlatform = Effect.runSync(HostProcessPlatform);
const startedAtEpochMs = Date.now();
const startedAt = NodePerfHooks.performance.now();

interface Milestone {
  readonly name: string;
  readonly elapsedMs: number;
  readonly [detail: string]: unknown;
}

const milestones: Array<Milestone> = [];
const seenMilestones = new Set<string>();
const outputBuffers = { stdout: "", stderr: "" };
let serverPort: number | undefined;
let webPort: number | undefined;
let pairingUrl: string | undefined;
let finishing = false;

await NodeFSP.mkdir(outputDir, { recursive: true });

const elapsedMs = (): number => Number((NodePerfHooks.performance.now() - startedAt).toFixed(3));

const redact = (text: string): string =>
  text
    .replace(/(https?:\/\/\S+\/pair#token=)\S+/gi, "$1[REDACTED]")
    .replace(/("?(?:token|credential)"?\s*[:=]\s*"?)[^\s",}]+/gi, "$1[REDACTED]");

function mark(name: string, detail: Record<string, unknown> = {}): void {
  if (seenMilestones.has(name)) return;
  seenMilestones.add(name);
  const milestone = { name, elapsedMs: elapsedMs(), ...detail };
  milestones.push(milestone);
  process.stdout.write(`[profile +${milestone.elapsedMs.toFixed(3)}ms] ${name}\n`);
  if (name === stopAfter) queueMicrotask(() => void finish(`milestone:${name}`));
}

async function probeHttp(name: string, url: string): Promise<void> {
  while (true) {
    if (finishing || seenMilestones.has(name)) return;
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(250),
      });
      mark(name, { status: response.status });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function inspectLine(stream: keyof typeof outputBuffers, line: string): void {
  const runner = line.match(/\[dev-runner\].*serverPort=(\d+).*webPort=(\d+).*baseDir=(.+?)\s*$/);
  if (runner && webPort === undefined) {
    serverPort = Number(runner[1]);
    webPort = Number(runner[2]);
    mark("runner-config-resolved", { serverPort, webPort });
    void probeHttp("web-http-ready", `http://localhost:${webPort}/`);
    void probeHttp(
      "environment-descriptor-ready",
      `http://localhost:${serverPort}/.well-known/t3/environment`,
    );
  }

  if (/apps\/web\$.*vp dev/.test(line)) mark("web-task-started");
  if (/apps\/server\$.*node --watch/.test(line)) mark("server-task-started");
  if (/Local:\s+https?:\/\//.test(line) || /ready in \d+ ?ms/i.test(line)) {
    mark("vite-ready");
  }

  const pairingMatch = line.match(
    /pairingUrl\s*[:=]\s*["']?(https?:\/\/\S+\/pair#token=[^\s"'}]+)/i,
  );
  if (pairingMatch?.[1]) {
    pairingUrl = pairingMatch[1];
  }
  if (/Authentication required\./.test(line)) mark("pairing-url-emitted");

  process.stdout.write(`[${stream} +${elapsedMs().toFixed(3)}ms] ${redact(line)}\n`);
}

function consume(stream: keyof typeof outputBuffers, chunk: Buffer): void {
  outputBuffers[stream] += chunk.toString("utf8");
  const lines = outputBuffers[stream].split(/\r?\n/);
  outputBuffers[stream] = lines.pop() ?? "";
  for (const line of lines) inspectLine(stream, line);
}

const child = NodeChildProcess.spawn(
  NodePath.resolve("node_modules/.bin/vp"),
  ["run", command, "--home-dir", homeDir],
  {
    cwd: process.cwd(),
    detached: hostPlatform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));

mark("process-spawned", { pid: child.pid ?? null });
child.stdout.on("data", (chunk) => consume("stdout", chunk));
child.stderr.on("data", (chunk) => consume("stderr", chunk));

async function writeResults(reason: string): Promise<void> {
  await NodeFSP.writeFile(
    NodePath.join(outputDir, "startup-profile.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        command: `vp run ${command} --home-dir <isolated>`,
        startedAtEpochMs,
        stoppedAtEpochMs: Date.now(),
        reason,
        stopAfter,
        serverPort,
        webPort,
        milestones,
        browserMilestoneNames: [
          "navigation.start",
          "entry.loaded",
          "auth.gate.resolved",
          "pairing.exchanged",
          "ws.open",
          "config.received",
          "react.usable",
          "shell.live",
        ],
      },
      null,
      2,
    )}\n`,
  );

  if (pairingUrl) {
    await NodeFSP.writeFile(NodePath.join(outputDir, "pairing-url.secret"), `${pairingUrl}\n`, {
      mode: 0o600,
    });
  }
  process.stdout.write(`[profile] results=${NodePath.join(outputDir, "startup-profile.json")}\n`);
}

async function finish(reason: string): Promise<void> {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  signalChild("SIGINT");
  const forceKill = setTimeout(() => signalChild("SIGTERM"), 3_000);
  await childClosed;
  clearTimeout(forceKill);
  await writeResults(reason);
}

function signalChild(signal: NodeJS.Signals): void {
  if (hostPlatform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already be gone; fall back to the direct child.
    }
  }
  child.kill(signal);
}

const timeout = setTimeout(() => void finish("timeout"), timeoutMs);
process.once("SIGINT", () => void finish("SIGINT"));
process.once("SIGTERM", () => void finish("SIGTERM"));
child.once("error", (error) => {
  process.stderr.write(`[profile] spawn failed: ${error.message}\n`);
  void finish("spawn-error");
});
child.once("exit", (code, signal) => {
  if (!finishing) void finish(signal ?? `exit-${code ?? "unknown"}`);
});
