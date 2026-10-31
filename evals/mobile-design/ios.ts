// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator automation uses Node subprocess and timing APIs directly.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  normalizeIosSimulator,
  readPngDimensions,
  suppressIosSystemFollowUps,
  type ShowcaseEnvironment,
} from "../../scripts/mobile-showcase.ts";
import {
  SHOWCASE_ENVIRONMENTS,
  SHOWCASE_THREADS,
} from "../../scripts/mobile-showcase-environment.ts";
import { SIMULATORS, type DeviceClassId, type Pose, type StepAction } from "./cases.ts";

const BUNDLE_ID = "com.t3tools.t3code";
const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const AGENT_DEVICE = NodePath.join(
  REPO_ROOT,
  "scripts/node_modules/agent-device/bin/agent-device.mjs",
);

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function run(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly allowFailure?: boolean;
    readonly timeoutMs?: number;
    readonly cwd?: string;
  } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 120_000,
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

const simctl = (...args: ReadonlyArray<string>) => run("xcrun", ["simctl", ...args]);

export interface SnapshotNode {
  readonly ref?: string;
  /** agent-device's role name, such as `button`, `text`, `text-view` or `navigation-bar`. */
  readonly kind?: string;
  readonly label?: string;
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly hittable?: boolean;
}
export interface Snapshot {
  readonly nodes: ReadonlyArray<SnapshotNode>;
  readonly viewport: { readonly width: number; readonly height: number };
}

/** Where each `{thread:<id>}` lives: seeded and live fixture threads, by environment. */
export type LinkTargets = ReadonlyMap<
  string,
  { readonly environmentId: string; readonly threadId: string }
>;

export function linkTargets(environments: ReadonlyArray<ShowcaseEnvironment>): LinkTargets {
  const threads = new Map<string, { environmentId: string; threadId: string }>();
  for (const [index, environment] of SHOWCASE_ENVIRONMENTS.entries()) {
    const started = environments[index];
    if (!started) throw new Error(`Environment ${environment.id} did not start.`);
    for (const thread of SHOWCASE_THREADS) {
      if ((environment.projectIds as ReadonlyArray<string>).includes(thread.projectId))
        threads.set(thread.id, { environmentId: started.environmentId, threadId: thread.id });
    }
    for (const [id, threadId] of started.liveThreadIds)
      threads.set(id, { environmentId: started.environmentId, threadId });
  }
  return threads;
}

export function expandPath(path: string, targets: LinkTargets): string {
  return path.replaceAll(/\{thread:([^}]+)\}/g, (_, id: string) => {
    const thread = targets.get(id);
    if (!thread) throw new Error(`Unknown thread '${id}'.`);
    return `${thread.environmentId}/${encodeURIComponent(thread.threadId)}`;
  });
}

/** One simulator this run created, driven with simctl for system state and agent-device for UI. */
export class Simulator {
  readonly device: DeviceClassId;
  readonly udid: string;
  private readonly session: string;
  private appLandscape = false;
  private metroUrl: string | null = null;

  private constructor(device: DeviceClassId, udid: string, session: string) {
    this.device = device;
    this.udid = udid;
    this.session = session;
  }

  /** Creates a dedicated simulator on the newest runtime, so runs never touch shared devices. */
  static async create(device: DeviceClassId, runId: string): Promise<Simulator> {
    const spec = SIMULATORS[device];
    const udid = (
      await simctl(
        "create",
        `${spec.name} ${runId}`,
        `com.apple.CoreSimulator.SimDeviceType.${spec.type}`,
      )
    ).stdout.trim();
    const simulator = new Simulator(device, udid, `t3-design-${device}-${runId}`);
    try {
      await suppressIosSystemFollowUps(udid);
      await simctl("boot", udid);
      await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeoutMs: 600_000 });
    } catch (error) {
      await simulator.delete();
      throw error;
    }
    return simulator;
  }

  async delete() {
    await this.agent(["close"]).catch(() => undefined);
    await simctl("shutdown", this.udid).catch(() => undefined);
    await simctl("delete", this.udid).catch(() => undefined);
  }

  async install(appPath: string) {
    await normalizeIosSimulator("dark", this.udid);
    await simctl("install", this.udid, appPath);
  }

  async dataContainer(): Promise<string> {
    return (await simctl("get_app_container", this.udid, BUNDLE_ID, "data")).stdout.trim();
  }

  /**
   * Loads the JS straight from Metro. The dev menu's preferences hide its tools button and
   * launch sheet; the same flags on --initialUrl do not reach them.
   */
  async launch(metroUrl: string, options: { readonly restart?: boolean } = {}) {
    this.metroUrl = metroUrl;
    for (const [key, value] of [
      ["EXDevMenuShowFloatingActionButton", "NO"],
      ["EXDevMenuShowsAtLaunch", "NO"],
      ["EXDevMenuIsOnboardingFinished", "YES"],
    ] as const) {
      await simctl("spawn", this.udid, "defaults", "write", BUNDLE_ID, key, "-bool", value);
    }
    const loaded = /^(Chats|Threads|Add environment|New chat|New thread|Search threads)$/;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Launch arguments only reach a fresh process, so start it before agent-device attaches.
      await simctl(
        "launch",
        ...(attempt > 0 || options.restart ? ["--terminate-running-process"] : []),
        this.udid,
        BUNDLE_ID,
        "--initialUrl",
        metroUrl,
      );
      // The first snapshot attaches the agent-device session, which can take minutes.
      await this.agent(["open", BUNDLE_ID], 600_000).catch(() => undefined);
      const snapshot = await this.waitFor(
        new RegExp(`${loaded.source}|^Reload$`),
        "the app to load",
        { timeoutMs: 180_000 },
      ).catch(() => null);
      if (snapshot && this.find(snapshot, loaded)) return;
      if (snapshot) await this.tap([/^Reload$/]).catch(() => undefined);
    }
    throw new Error("The app did not load from Metro.");
  }

  /** Pairs every environment, then checks that each one shows as paired. */
  async pair(pairings: ReadonlyArray<{ readonly url: string; readonly label: string }>) {
    for (const pairing of pairings) {
      const query = new URLSearchParams({ pairingUrl: pairing.url, autoConnect: "1" });
      // Pairing runs once per device, so it can wait out a slow host.
      await this.openUrl(`t3code://connections/new?${query}`, 180_000);
      await delay(4_000);
    }
    // The environments page lists every paired machine, however long the thread list is.
    await this.openUrl("t3code://settings/environments");
    for (const pairing of pairings) {
      await this.waitFor(new RegExp(`^${RegExp.escape(pairing.label)}`), pairing.label, {
        timeoutMs: 180_000,
      });
    }
  }

  /**
   * Opens a link. Some runtimes ask "Open in …?" first: accept that prompt, or tap its Open
   * button when the runner sees it but cannot answer. Without a prompt the link opened already.
   */
  async openUrl(url: string, timeoutMs = 60_000) {
    await simctl("openurl", this.udid, url);
    const started = Date.now();
    while (Date.now() < started + timeoutMs) {
      const accepted = await this.agent(["alert", "accept"]).then(
        () => true,
        () => false,
      );
      if (accepted) return;
      const snapshot = await this.snapshot().catch(() => null);
      const prompted = snapshot?.nodes.some((node) => /^Open in /.test(node.label ?? ""));
      const open = snapshot && prompted ? this.find(snapshot, /^Open$/) : undefined;
      if (open) {
        await this.press(open);
        return;
      }
      // A prompt shows within a second or two; a clean screen after that means none is coming.
      if (snapshot && !prompted && Date.now() - started > 4_000) return;
      await delay(500);
    }
    throw new Error(
      `the prompt to open ${url.split("?")[0]} was not answered, or the screen could not be read`,
    );
  }

  async agent(args: ReadonlyArray<string>, timeoutMs = 180_000): Promise<Record<string, unknown>> {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        AGENT_DEVICE,
        ...args,
        "--platform",
        "ios",
        "--udid",
        this.udid,
        "--session",
        this.session,
        "--json",
      ],
      { allowFailure: true, timeoutMs },
    );
    let parsed: { success?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`agent-device ${args[0]}: ${(stderr || stdout).slice(-400)}`);
    }
    if (!parsed.success)
      throw new Error(`agent-device ${args.join(" ")}: ${parsed.error?.message}`);
    return parsed.data ?? {};
  }

  async snapshot(): Promise<Snapshot> {
    // The first command of a session attaches it to the app.
    const data = await this.agent(["snapshot"]).catch(async () => {
      await this.agent(["open", BUNDLE_ID]);
      return this.agent(["snapshot"]);
    });
    return data as unknown as Snapshot;
  }

  /** The first element labelled `label`; `offScreen` also accepts rows scrolled out of view. */
  find(snapshot: Snapshot, label: RegExp, offScreen = false): SnapshotNode | undefined {
    const onScreen = (node: SnapshotNode) =>
      offScreen ||
      (node.rect !== undefined &&
        node.rect.y + node.rect.height > 0 &&
        node.rect.y < snapshot.viewport.height);
    const matches = snapshot.nodes.filter((node) => label.test(node.label ?? "") && onScreen(node));
    return matches.find((node) => node.hittable) ?? matches[0];
  }

  async waitFor(
    label: RegExp,
    what: string,
    options: { readonly timeoutMs?: number; readonly offScreen?: boolean } = {},
  ): Promise<Snapshot> {
    const { timeoutMs = 20_000, offScreen = false } = options;
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    for (;;) {
      const snapshot = await this.snapshot().catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error);
        return null;
      });
      if (snapshot && this.find(snapshot, label, offScreen)) return snapshot;
      if (Date.now() > deadline) {
        const seen = snapshot
          ? `saw: ${snapshot.nodes
              .flatMap((node) => (node.label ? [node.label] : []))
              .slice(0, 8)
              .join(" | ")}`
          : `snapshot failed: ${lastError.slice(0, 300)}`;
        throw new Error(`timed out waiting for ${what} (${seen})`);
      }
      await delay(750);
    }
  }

  async press(node: SnapshotNode) {
    if (!node.rect) throw new Error(`${node.label ?? "element"} has no frame`);
    const { x, y, width, height } = node.rect;
    // Refs can be refused when agent-device thinks the element is covered; the centre still takes a tap.
    await this.agent(["press", `@${node.ref}`]).catch(() =>
      this.agent(["press", String(Math.round(x + width / 2)), String(Math.round(y + height / 2))]),
    );
  }

  /** Taps the first element matching the first pattern that shows, and returns its label. */
  async tap(patterns: ReadonlyArray<RegExp>, timeoutMs?: number): Promise<string> {
    const any = new RegExp(patterns.map((pattern) => `(?:${pattern.source})`).join("|"));
    const snapshot = await this.waitFor(any, `'${any.source}'`, timeoutMs ? { timeoutMs } : {});
    const node = patterns
      .map((pattern) => this.find(snapshot, pattern))
      .find((candidate) => candidate !== undefined);
    if (!node) throw new Error(`nothing labelled ${any}`);
    await this.press(node);
    return (node.label ?? "").split(",")[0]!.slice(0, 40);
  }

  /** The composer is a native text view with no label: the lowest editable field on screen. */
  private async composer(): Promise<SnapshotNode> {
    const snapshot = await this.snapshot();
    const composer = snapshot.nodes
      .filter((node) => (node.kind === "text-view" || node.kind === "text-field") && node.rect)
      .toSorted((a, b) => b.rect!.y - a.rect!.y)[0];
    if (!composer) throw new Error("no composer on screen");
    return composer;
  }

  /** Performs one step; returns the tapped label for a `tap` step, or null when it was skipped. */
  async perform(step: StepAction, targets: LinkTargets): Promise<string | null | undefined> {
    let tapped: string | undefined;
    if ("link" in step) await this.openUrl(`t3code://${expandPath(step.link, targets)}`);
    else if ("tap" in step) {
      if (step.skipIf && this.find(await this.snapshot(), new RegExp(step.skipIf))) return null;
      const patterns = (typeof step.tap === "string" ? [step.tap] : step.tap).map(
        (pattern) => new RegExp(pattern),
      );
      try {
        tapped = await this.tap(patterns, step.optional ? 5_000 : undefined);
      } catch (error) {
        if (step.optional) return null;
        throw error;
      }
    } else if ("type" in step) await this.agent(["type", step.type]);
    else if ("scroll" in step) await this.agent(["scroll", step.scroll]);
    else if ("focus" in step) await this.press(await this.composer());
    else await this.agent(["fill", `@${(await this.composer()).ref}`, ""]);
    await delay(1_200);
    return tapped;
  }

  /** Backs out of sheets, pushed screens and the keyboard until the thread list shows. */
  async home(threadListLabel: RegExp) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const snapshot = await this.snapshot();
      // A thread's back button is labelled with the tab it returns to, so only count it up top.
      // The iPad sidebar footer's "Back" and a sheet's dimmed backdrop are not buttons, so accept
      // them by label alone.
      const back = snapshot.nodes.find(
        (node) =>
          (node.kind === "button" || /^(Back|dismiss popup)$/.test(node.label ?? "")) &&
          (/^(Back|Close|Done|Cancel|dismiss popup|Go to threads list|Back to chat|Return to chat)$/.test(
            node.label ?? "",
          ) ||
            // A pushed page's back button is named after the list it returns to.
            (/^(Chats|Threads)$/.test(node.label ?? "") &&
              (node.rect?.y ?? Infinity) < snapshot.viewport.height / 4)),
      );
      if (!back && this.find(snapshot, threadListLabel)) {
        await this.agent(["keyboard", "dismiss"]).catch(() => undefined);
        // Start every scene from the top of the list.
        await this.agent(["scroll", "up"]).catch(() => undefined);
        await delay(600);
        return;
      }
      // Another tab, such as Settings, shows no back button; the tab bar or side rail returns to Chats.
      const chatsTab = snapshot.nodes.find(
        (node) =>
          node.kind === "button" &&
          node.label === "Chats" &&
          (node.rect?.y ?? 0) >= snapshot.viewport.height / 4,
      );
      const target = back ?? chatsTab;
      if (target) {
        await this.withUsableTaps(async () => {
          // A turn to portrait moves the element, so find it again by its label.
          const label = new RegExp(`^${RegExp.escape(target.label ?? "")}$`);
          await this.press(this.find(await this.snapshot(), label) ?? target);
        });
      } else await this.agent(["back"]).catch(() => undefined);
      await delay(1_000);
    }
    // Some screens offer no way back that works, such as an iPad sidebar section opened by a
    // link; a fresh launch always opens on the thread list.
    if (!this.metroUrl) throw new Error("could not return to the thread list");
    const stuck = await this.snapshot().catch(() => null);
    process.stderr.write(
      `[mobile-design] ${this.device}: no way back to the thread list worked, relaunching (screen: ${stuck?.nodes
        .flatMap((node) => (node.label ? [`${node.kind}:${node.label.slice(0, 30)}`] : []))
        .slice(0, 14)
        .join(" | ")})\n`,
    );
    await this.relaunch(threadListLabel);
  }

  /** Starts the app again; it opens on the thread list with nothing selected. */
  async relaunch(threadListLabel: RegExp) {
    if (!this.metroUrl) throw new Error("the app was never launched");
    await this.launch(this.metroUrl, { restart: true });
    await this.waitFor(threadListLabel, "the thread list after a relaunch", { offScreen: true });
  }

  /**
   * Applies the pose's system settings to the running app. Returns why the app is not in the
   * pose's shape, when it is not, so its shots stay out of the pack.
   */
  async applyPose(pose: Pose): Promise<string | undefined> {
    await simctl("ui", this.udid, "appearance", pose.appearance);
    await simctl("ui", this.udid, "content_size", pose.textSize ?? "large");
    if (pose.fold) {
      // agent-device verifies a fold by a hinge-angle read, which fails when the Duo is already
      // in that pose, so check the app's shape instead.
      await this.agent(["fold", pose.fold]).catch(() => undefined);
      await delay(2_500);
      const { width, height } = (await this.snapshot()).viewport;
      this.appLandscape = width > height;
      if (this.appLandscape !== (pose.fold === "open")) return `the Duo did not ${pose.fold}`;
      return undefined;
    }
    const shape = pose.orientation ?? "portrait";
    this.appLandscape = await this.orient(shape);
    // A portrait-locked iPhone is the finding; anything else that keeps its shape is a failure.
    if (this.appLandscape !== (shape === "landscape") && this.device !== "iphone") {
      return `the ${this.device} did not rotate to ${shape}`;
    }
    return undefined;
  }

  /**
   * Runs `steps` in portrait when the iPad is in landscape, then turns back. XCTest sends taps to
   * a landscape iPad in portrait coordinates, so they land on the wrong element.
   */
  async withUsableTaps(steps: () => Promise<void>) {
    if (this.device !== "ipad" || !this.appLandscape) return steps();
    await this.orient("portrait");
    try {
      await steps();
    } finally {
      this.appLandscape = await this.orient("landscape");
    }
  }

  /** Returns whether the app now lays out in landscape. */
  private async orient(shape: "portrait" | "landscape"): Promise<boolean> {
    const isLandscape = async () => {
      const { width, height } = (await this.snapshot()).viewport;
      return width > height;
    };
    if ((await isLandscape()) === (shape === "landscape")) return shape === "landscape";
    // screenshot() turns a portrait frame by 270°, which matches landscape-left only.
    await this.agent(["orientation", shape === "landscape" ? "landscape-left" : "portrait"]);
    await delay(2_000);
    // A portrait-locked app keeps its shape when the device turns; the capture shows that.
    return isLandscape();
  }

  async screenshot(destination: string, pose: Pose) {
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await simctl(
      "io",
      this.udid,
      "screenshot",
      ...(pose.fold ? ["--display", pose.fold === "closed" ? "1" : "3"] : []),
      destination,
    );
    // Headless displays stay portrait when the app rotates.
    const { width, height } = readPngDimensions(await NodeFSP.readFile(destination));
    if (this.appLandscape && height > width) {
      await run("sips", ["--rotate", pose.fold ? "90" : "270", destination]);
    }
  }
}
