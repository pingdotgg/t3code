// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side device automation uses Node subprocess and timing APIs directly.

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import type { Snapshot } from "./checks.ts";
import type { Pose } from "./poses.ts";

export const BUNDLE_ID = "com.t3tools.t3code.dev";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function run(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowFailure?: boolean;
    readonly timeoutMs?: number;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? NodeProcess.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !options.allowFailure)
        reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How this run reaches the pool: one agent-device config, from one workspace. */
export interface Pool {
  readonly repoRoot: string;
  readonly agentDevice: string;
  /** The gateway's agent-device front, `<gateway>/v1/agent-device`. */
  readonly agentDeviceUrl: string;
  /**
   * agent-device ties a lease to the workspace it was opened from and reads it from both the
   * real cwd and $PWD, so every command runs from this real path with a matching PWD.
   */
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
}

export class AgentDeviceError extends Error {}

// A shared pool's workers drop off the gateway and stall under load for seconds at a time.
const TRANSIENT =
  /Remote daemon is unavailable|not connected to the gateway|still finishing a previous command|Invalid daemon response|Daemon request timed out/i;

export class Device {
  readonly pose: Pose;
  readonly session: string;
  readonly pool: Pool;

  private constructor(pose: Pose, session: string, pool: Pool) {
    this.pose = pose;
    this.session = session;
    this.pool = pool;
  }

  /** Leases a device for the pose; `open` waits in the pool's queue while every match is busy. */
  static async lease(pose: Pose, pool: Pool, runId: string): Promise<Device> {
    const device = new Device(pose, `t3-e2e-${runId}-${pose.id}`, pool);
    await device.agent(["connect", "proxy", "--daemon-base-url", pool.agentDeviceUrl]);
    await device.agent(
      [
        "open",
        "--platform",
        pose.platform,
        "--device",
        pose.device,
        // A real keyboard, so the layout under it is what people see.
        ...(pose.platform === "android" ? ["--no-test-ime"] : []),
      ],
      { timeoutMs: 420_000 },
    );
    return device;
  }

  async agent(
    args: ReadonlyArray<string>,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.agentOnce(args, options);
      } catch (error) {
        if (attempt >= 3 || !(error instanceof AgentDeviceError) || !TRANSIENT.test(error.message))
          throw error;
        await delay(3_000 * attempt);
      }
    }
  }

  private async agentOnce(
    args: ReadonlyArray<string>,
    options: { readonly timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const { stdout, stderr } = await run(
      NodeProcess.execPath,
      [this.pool.agentDevice, ...args, "--session", this.session, "--json"],
      {
        cwd: this.pool.workspace,
        env: this.pool.env,
        allowFailure: true,
        timeoutMs: options.timeoutMs ?? 120_000,
      },
    );
    let parsed: { success: boolean; data?: Record<string, unknown>; error?: { message: string } };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new AgentDeviceError(`agent-device ${args[0]}: ${(stderr || stdout).slice(-400)}`);
    }
    if (!parsed.success)
      throw new AgentDeviceError(`agent-device ${args.join(" ")}: ${parsed.error?.message}`);
    return parsed.data ?? {};
  }

  /** The shared-cache dev client for this checkout; the worker downloads it itself. */
  async install() {
    await run(
      NodeProcess.execPath,
      [
        NodePath.join(this.pool.repoRoot, "scripts/mobile-native-client.ts"),
        "ensure",
        this.pose.platform,
        "--session",
        this.session,
      ],
      { cwd: this.pool.workspace, env: this.pool.env, timeoutMs: 600_000 },
    );
  }

  /** Device settings that must be in place before the app starts. */
  async prepare() {
    await this.agent(["settings", "appearance", this.pose.appearance]);
    if (this.pose.textSize) await this.agent(["settings", "text-size", this.pose.textSize]);
    if (this.pose.fold) await this.agent(["fold", this.pose.fold]);
  }

  async launch(metroUrl: string) {
    const url = encodeURIComponent(metroUrl);
    await this.agent(
      [
        "open",
        BUNDLE_ID,
        `t3code-dev://expo-development-client/?url=${url}&disableOnboarding=1&disableFab=1&disableAutoLaunch=1`,
        // A real keyboard, so the layout under it is what people see.
        ...(this.pose.platform === "android" ? ["--no-test-ime"] : []),
      ],
      { timeoutMs: 180_000 },
    );
    await this.acceptOpenPrompt();
    if (this.pose.landscape) await this.agent(["orientation", "landscape-left"]);
  }

  async openUrl(url: string) {
    await this.agent(["open", BUNDLE_ID, url]);
    await this.acceptOpenPrompt();
  }

  /** iOS asks before another app opens a custom scheme, and agent-device does not always answer. */
  private async acceptOpenPrompt() {
    if (this.pose.platform !== "ios") return;
    await delay(1_500);
    await this.agent(["alert", "accept"]).catch(() => undefined);
  }

  async snapshot(): Promise<Snapshot> {
    return (await this.agent(["snapshot"])) as unknown as Snapshot;
  }

  async waitFor(predicate: (snapshot: Snapshot) => boolean, label: string, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = await this.snapshot().catch(() => null);
      if (snapshot && predicate(snapshot)) return snapshot;
      await delay(750);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async screenshot(path: string) {
    // iOS defaults to 1x points, too coarse for anyone reviewing the screenshot.
    await this.agent([
      "screenshot",
      path,
      ...(this.pose.platform === "ios" ? ["--pixel-density", "2"] : []),
    ]);
  }

  /** Runs an action while recording, so transitions can be checked frame by frame. */
  async recorded(directory: string, name: string, action: () => Promise<unknown>) {
    const video = NodePath.join(directory, `${name}.mp4`);
    await this.agent(["record", "start", video, "--hide-touches"]);
    try {
      await action();
      await delay(2_000);
    } finally {
      await this.agent(["record", "stop"], { timeoutMs: 180_000 }).catch(() => undefined);
    }
    return video;
  }

  async release() {
    await this.agent(["close"]).catch(() => undefined);
  }
}
