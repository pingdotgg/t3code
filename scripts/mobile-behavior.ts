#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Host-side device automation uses Node subprocess and filesystem APIs directly.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { CASES } from "./mobile-behavior/cases.ts";
import { blockingResults, resultsFor, summarize, type SampleRow } from "./mobile-behavior/grade.ts";
import { type Device, run } from "./mobile-e2e/device.ts";
import {
  leaseAndInstall,
  openPool,
  releaseOnCrash,
  renewWhileRunning,
  type PoolAccess,
} from "./mobile-behavior/pool.ts";
import type { Pose } from "./mobile-e2e/poses.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

/** The devices the behavior cases run on; each runs in parallel with its own server and Metro. */
const TARGETS = [
  { id: "iphone-18-pro", device: "iPhone 18 Pro", form: "phone", behaviorPose: "phone" },
  { id: "ipad-pro-13", device: "iPad Pro 13-inch (M5)", form: "tablet", behaviorPose: "ipad" },
] as const;
type Target = (typeof TARGETS)[number];

const log = (scope: string, message: string) => NodeProcess.stderr.write(`[${scope}] ${message}\n`);

interface TargetRun {
  readonly target: Target;
  readonly directory: string;
  readonly error?: string;
}

async function runTarget(
  target: Target,
  access: PoolAccess,
  runId: string,
  outputDirectory: string,
  passThrough: ReadonlyArray<string>,
): Promise<TargetRun> {
  const { pool, config } = access;
  const directory = NodePath.join(outputDirectory, target.id);
  await NodeFSP.mkdir(directory, { recursive: true });
  const pose: Pose = {
    id: target.id,
    platform: "ios",
    device: target.device,
    form: target.form,
    appearance: "light",
  };
  let device: Device;
  try {
    device = await leaseAndInstall(pose, pool, runId, (message) => log(target.id, message));
  } catch (error) {
    return { target, directory, error: error instanceof Error ? error.message : String(error) };
  }
  const stopRenewing = renewWhileRunning(access, device.session);
  const stopCrashGuard = releaseOnCrash(device, access);
  try {
    log(target.id, "running the behavior cases");
    const child = NodeChildProcess.spawn(
      NodeProcess.execPath,
      [
        "scripts/mobile-behavior/run.ts",
        "--out",
        directory,
        "--label",
        target.id,
        "--pose",
        target.behaviorPose,
        "--device-config",
        config,
        "--device-session",
        device.session,
        "--agent-device",
        pool.agentDevice,
        ...passThrough,
      ],
      { cwd: REPO_ROOT, env: NodeProcess.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const transcript = NodeFS.createWriteStream(NodePath.join(directory, "run.log"));
    // The scoreboard and any fatal error go to stdout, progress to stderr; the transcript keeps both.
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) =>
      transcript.write(`${line}\n`),
    );
    NodeReadline.createInterface({ input: child.stderr }).on("line", (line) => {
      transcript.write(`${line}\n`);
      if (/#\d+: /.test(line)) log(target.id, line);
    });
    const code = await new Promise<number>((resolve) =>
      child.on("close", (exit) => resolve(exit ?? 1)),
    );
    transcript.end();
    const hasResults = NodeFS.existsSync(NodePath.join(directory, "results.jsonl"));
    return hasResults || code === 0
      ? { target, directory }
      : { target, directory, error: `the cases stopped (exit ${code}); see ${directory}/run.log` };
  } finally {
    stopRenewing();
    stopCrashGuard();
    await device.release();
  }
}

async function main() {
  const args = NodeProcess.argv.slice(2);
  const values = (flag: string) =>
    args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
  if (args.includes("--list")) {
    for (const target of TARGETS) NodeProcess.stdout.write(`${target.id}\t${target.device}\n`);
    for (const testCase of CASES)
      NodeProcess.stdout.write(`${testCase.id}\t${testCase.kind}\t${testCase.source}\n`);
    return;
  }
  const selected = values("--device");
  const unknown = selected.filter((id) => !TARGETS.some((target) => target.id === id));
  if (unknown.length) throw new Error(`Unknown device ${unknown.join(", ")}. Run with --list.`);
  const targets = TARGETS.filter((target) => selected.length === 0 || selected.includes(target.id));
  const passThrough = [
    ...values("--samples").flatMap((value) => ["--samples", value]),
    ...values("--case").flatMap((value) => ["--case", value]),
  ];

  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const outputDirectory = NodePath.join(REPO_ROOT, "artifacts/mobile-behavior", runId);
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  const access = await openPool(REPO_ROOT, outputDirectory);
  try {
    // A cache miss builds the dev client, which can outlast a lease, so it is ready first.
    log("behavior", "preparing the ios dev client");
    await run(
      NodeProcess.execPath,
      ["scripts/mobile-native-client.ts", "ensure", "ios", "--prepare"],
      { cwd: REPO_ROOT, timeoutMs: 1_800_000 },
    );
    const runs = await Promise.all(
      targets.map((target) => runTarget(target, access, runId, outputDirectory, passThrough)),
    );

    const rows = runs.flatMap((entry) => {
      const file = NodePath.join(entry.directory, "results.jsonl");
      if (!NodeFS.existsSync(file)) return [];
      return NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SampleRow);
    });
    const results = resultsFor(rows, CASES);
    const stopped = runs.filter((entry) => entry.error);
    const summary = summarize({
      cases: CASES,
      results,
      header: [
        `# Mobile behavior · ${runId}`,
        "",
        "Cells show pass or FAIL, passed/samples, and the key metric's median. `bad` cases reproduce known bugs and are expected to fail until they are fixed.",
        ...stopped.map((entry) => `\n**${entry.target.id} did not finish:** ${entry.error}`),
      ].join("\n"),
    });
    const summaryFile = NodePath.join(outputDirectory, "summary.md");
    await NodeFSP.writeFile(summaryFile, summary);
    const blocking = blockingResults(results, CASES);
    for (const result of blocking)
      log(result.device, `${result.id}: ${result.pass === null ? "incomplete" : "FAIL"}`);
    for (const entry of stopped) log(entry.target.id, entry.error!);
    NodeProcess.stdout.write(
      `${JSON.stringify({ summary: summaryFile, cases: results.length, blocking: blocking.length, stopped: stopped.length })}\n`,
    );
    process.exitCode = blocking.length || stopped.length ? 1 : 0;
  } finally {
    await access.close();
  }
}

if (import.meta.main) {
  await main();
}
