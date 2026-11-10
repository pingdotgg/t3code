#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Host-side device automation uses Node subprocess and filesystem APIs directly.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { Device, type Pool, poolError, run } from "./mobile-e2e/device.ts";
import { runJourney, type StepResult } from "./mobile-e2e/journey.ts";
import { POSES, type Pose } from "./mobile-e2e/poses.ts";
import {
  failedChecks,
  poolBlocked,
  poseFailed,
  type PoseResult,
  renderReport,
} from "./mobile-e2e/report.ts";
import { reviewPose } from "./mobile-e2e/review.ts";
import {
  reserveAvailablePort,
  startShowcaseEnvironments,
  stopProcess,
  waitForPort,
} from "./mobile-showcase.ts";
import { SHOWCASE_ENVIRONMENTS } from "./mobile-showcase-environment.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const log = (scope: string, message: string) => NodeProcess.stderr.write(`[${scope}] ${message}\n`);

/** This machine's Tailscale address (100.64.0.0/10), which pool devices reach it on. */
function tailnetAddress(): string {
  for (const addresses of Object.values(NodeOS.networkInterfaces())) {
    for (const address of addresses ?? []) {
      const [first, second] = address.address.split(".").map(Number);
      if (address.family === "IPv4" && first === 100 && second! >= 64 && second! < 128)
        return address.address;
    }
  }
  throw new Error("No Tailscale IPv4 address: pool devices reach Metro and the fixture over it.");
}

async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]!);
      }
    }),
  );
  return results;
}

async function issuePairUrl(
  environment: { readonly baseDir: string; readonly port: number },
  host: string,
) {
  const { stdout } = await run(
    NodeProcess.execPath,
    [
      "apps/server/src/bin.ts",
      "auth",
      "pairing",
      "create",
      "--base-dir",
      environment.baseDir,
      "--base-url",
      `http://${host}:${environment.port}`,
      "--ttl",
      "15m",
      "--json",
    ],
    { cwd: REPO_ROOT },
  );
  const { pairUrl } = JSON.parse(
    stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1),
  ) as {
    pairUrl?: string;
  };
  if (!pairUrl) throw new Error("The pairing command returned no pairUrl.");
  return pairUrl;
}

async function runPose(
  pose: Pose,
  pool: Pool,
  runId: string,
  outputDirectory: string,
  metroUrl: string,
  pair: () => Promise<string>,
): Promise<PoseResult> {
  const directory = NodePath.join(outputDirectory, pose.id);
  await NodeFSP.mkdir(directory, { recursive: true });
  const steps: StepResult[] = [];
  let device: Device | null = null;
  try {
    log(pose.id, `leasing ${pose.device}`);
    device = await Device.lease(pose, pool, runId);
    log(pose.id, "installing the dev client");
    await device.install();
    await device.prepare();
    await device.launch(metroUrl);
    log(pose.id, "pairing and walking the app");
    await runJourney(device, directory, pair, steps);
    return { pose, steps };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!device) return { pose, steps, error: message };
    // What the device showed when the journey stopped is usually the whole diagnosis.
    const stopped = NodePath.join(directory, "stopped.png");
    const shot = await device.screenshot(stopped).then(
      () => stopped,
      () => undefined,
    );
    const labels = await device.snapshot().then(
      (snapshot) =>
        snapshot.nodes
          .map((node) => node.label)
          .filter(Boolean)
          .slice(0, 12)
          .join(" | "),
      () => "",
    );
    return {
      pose,
      steps,
      error: labels ? `${message} (screen: ${labels})` : message,
      ...(shot ? { stopped: shot } : {}),
    };
  } finally {
    await device?.release();
  }
}

async function main() {
  const args = NodeProcess.argv.slice(2);
  if (args.includes("--list")) {
    for (const pose of POSES)
      NodeProcess.stdout.write(
        `${pose.id}\t${pose.device}${pose.pending ? `\t(pending: ${pose.pending})` : ""}\n`,
      );
    return;
  }
  const values = (flag: string) =>
    args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
  const selected = values("--pose");
  const unknown = selected.filter((id) => !POSES.some((pose) => pose.id === id));
  if (unknown.length) throw new Error(`Unknown pose ${unknown.join(", ")}. Run with --list.`);
  const platforms = values("--platform");
  const poses = POSES.filter(
    (pose) =>
      (selected.length === 0 ? !pose.pending : selected.includes(pose.id)) &&
      (platforms.length === 0 || platforms.includes(pose.platform)),
  );
  const concurrencyFlag = values("--concurrency")[0];
  const concurrency = concurrencyFlag ? Number(concurrencyFlag) : undefined;
  const review = !args.includes("--no-review");

  const agentDeviceUrl = NodeProcess.env.SIMLOCK_AGENT_DEVICE_URL;
  const token = NodeProcess.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  if (!agentDeviceUrl || !token)
    throw new Error(
      "Set SIMLOCK_AGENT_DEVICE_URL (<gateway>/v1/agent-device) and AGENT_DEVICE_DAEMON_AUTH_TOKEN (a Simlock agent token) to run on the device pool.",
    );
  const host = tailnetAddress();

  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const outputDirectory = NodePath.join(REPO_ROOT, "artifacts/mobile-e2e", runId);
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  const rootDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mobile-e2e-"));
  const workspace = await NodeFSP.realpath(outputDirectory);
  const config = NodePath.join(rootDir, "agent-device.json");
  await NodeFSP.writeFile(
    config,
    JSON.stringify({
      daemonBaseUrl: agentDeviceUrl,
      daemonAuthToken: token,
      stateDir: NodePath.join(rootDir, "agent-device"),
    }),
    { mode: 0o600 },
  );
  const pool: Pool = {
    repoRoot: REPO_ROOT,
    agentDevice: NodePath.join(REPO_ROOT, "scripts/node_modules/agent-device/bin/agent-device.mjs"),
    agentDeviceUrl,
    workspace,
    env: { ...NodeProcess.env, AGENT_DEVICE_CONFIG: config, PWD: workspace },
  };

  const servers: NodeChildProcess.ChildProcess[] = [];
  let metro: NodeChildProcess.ChildProcess | null = null;
  try {
    log("e2e", "starting the fixture server");
    const [environment] = await startShowcaseEnvironments(
      rootDir,
      (server) => servers.push(server),
      SHOWCASE_ENVIRONMENTS.slice(0, 1),
    );
    if (!environment) throw new Error("The fixture server did not start.");
    const metroPort = await reserveAvailablePort();
    metro = NodeChildProcess.spawn(
      "vp",
      [
        "exec",
        "expo",
        "start",
        "--dev-client",
        "--scheme",
        "t3code-dev",
        "--lan",
        "--port",
        String(metroPort),
      ],
      {
        cwd: NodePath.join(REPO_ROOT, "apps/mobile"),
        // Lazily fetched chunks (dynamic import()) sometimes arrive broken on the pool's Android
        // emulators and throw SyntaxErrors; release builds have no lazy chunks either.
        env: { ...NodeProcess.env, APP_VARIANT: "development", CI: "1", EXPO_NO_METRO_LAZY: "1" },
        // The app's console output arrives through Metro; keep it with the run.
        stdio: [
          "ignore",
          NodeFS.openSync(NodePath.join(outputDirectory, "metro.log"), "w"),
          "inherit",
        ],
        // Its own group, so stopping it also stops the expo child that owns the port.
        detached: true,
      },
    );
    await waitForPort(metroPort, "Metro", 120_000);
    // Warm each platform's bundle once, instead of on every device at once, and have its dev
    // client cached before any lease: a cache miss builds, which can outlast a lease.
    for (const platform of new Set(poses.map((pose) => pose.platform))) {
      log("e2e", `preparing the ${platform} dev client`);
      await run(
        NodeProcess.execPath,
        ["scripts/mobile-native-client.ts", "ensure", platform, "--prepare"],
        { cwd: REPO_ROOT, timeoutMs: 1_800_000 },
      );
      log("e2e", `bundling for ${platform}`);
      await run("curl", [
        "-sf",
        "-o",
        "/dev/null",
        `http://127.0.0.1:${metroPort}/apps/mobile/index.bundle?platform=${platform}&dev=true&minify=false`,
      ]);
    }

    const attempt = (pose: Pose, session: string) =>
      runPose(pose, pool, session, outputDirectory, `http://${host}:${metroPort}`, () =>
        issuePairUrl(environment, host),
      );
    const runOne = async (pose: Pose) => {
      let result = await attempt(pose, runId);
      // A pose that failed before its first screen usually met the pool, not the app.
      for (
        let retry = 1;
        retry <= 2 && result.error && (result.steps.length === 0 || poolError(result.error));
        retry++
      ) {
        log(pose.id, `retrying after: ${result.error.split("\n")[0]}`);
        result = await attempt(pose, `${runId}-retry${retry}`);
      }
      return result;
    };
    // Each platform has its own workers, so each gets its own limit; one Mac runs every
    // iOS simulator, and recording several at once on a shared pool times it out.
    const byPlatform = await Promise.all(
      (["ios", "android"] as const).map((platform) =>
        mapConcurrent(
          poses.filter((pose) => pose.platform === platform),
          concurrency ?? (platform === "ios" ? 2 : 3),
          runOne,
        ),
      ),
    );
    const results = poses.map((pose) => byPlatform.flat().find((result) => result.pose === pose)!);

    const reviewed = review
      ? await mapConcurrent(results, 4, async (result) => {
          log(result.pose.id, "agent review");
          const findings = await reviewPose(result, outputDirectory).catch((error) => {
            log(result.pose.id, `review failed: ${error instanceof Error ? error.message : error}`);
            return [];
          });
          return { ...result, findings };
        })
      : results;

    const report = NodePath.join(outputDirectory, "index.html");
    await NodeFSP.writeFile(report, renderReport(reviewed, outputDirectory));
    await NodeFSP.writeFile(
      NodePath.join(outputDirectory, "report.json"),
      JSON.stringify(reviewed, null, 2),
    );
    for (const result of reviewed) {
      const failures = failedChecks(result).map(
        (item) => `${item.step}: ${item.name} (${item.detail})`,
      );
      log(
        result.pose.id,
        [poolBlocked(result) ? `blocked by the pool: ${result.error}` : result.error, ...failures]
          .filter(Boolean)
          .join("; ") ||
          `passed${result.findings?.length ? `, ${result.findings.length} review findings` : ""}`,
      );
    }
    const failed = reviewed.filter((result) => poseFailed(result) && !poolBlocked(result)).length;
    const blocked = reviewed.filter(poolBlocked).length;
    NodeProcess.stdout.write(
      `${JSON.stringify({
        report,
        poses: reviewed.length,
        failed,
        blocked,
        findings: reviewed.reduce((count, result) => count + (result.findings?.length ?? 0), 0),
      })}\n`,
    );
    // A pose the pool blocked was not tested, so it fails the run too.
    process.exitCode = failed || blocked ? 1 : 0;
  } finally {
    if (metro?.pid) {
      try {
        NodeProcess.kill(-metro.pid, "SIGTERM");
      } catch {}
      await stopProcess(metro);
    }
    await Promise.all(servers.map((server) => stopProcess(server)));
    await NodeFSP.rm(rootDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
