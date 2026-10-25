#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator automation uses Node subprocess and timing APIs directly.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { startShowcaseEnvironments, stopProcess, waitForPort } from "./mobile-showcase.ts";
import { SHOWCASE_ENVIRONMENTS } from "./mobile-showcase-environment.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const AGENT_DEVICE = NodePath.join(
  REPO_ROOT,
  "scripts/node_modules/agent-device/bin/agent-device.mjs",
);
const BUNDLE_ID = "com.t3tools.t3code.dev";
const METRO_PORT = 8081;
// Persistent so the XCTest runner agent-device builds per simulator survives between runs.
const AGENT_DEVICE_STATE = NodePath.join(NodeOS.homedir(), ".cache/t3code/mobile-e2e/agent-device");

export interface E2eDevice {
  readonly id: string;
  readonly platform: "ios";
  readonly deviceType: string;
  readonly runtime: string;
}

const ios = (id: string, deviceType: string): E2eDevice => ({
  id,
  platform: "ios",
  deviceType: `com.apple.CoreSimulator.SimDeviceType.${deviceType}`,
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
});

export const DEVICES: ReadonlyArray<E2eDevice> = [
  ios("iphone-se", "iPhone-SE-3rd-generation"),
  ios("iphone-13-mini", "iPhone-13-mini"),
  ios("iphone-17", "iPhone-17"),
  ios("iphone-17-pro", "iPhone-17-Pro"),
  ios("iphone-17-pro-max", "iPhone-17-Pro-Max"),
  ios("iphone-air", "iPhone-Air"),
];

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SnapshotNode {
  readonly type?: string;
  readonly role?: string;
  readonly identifier?: string;
  readonly label?: string;
  readonly rect?: Rect;
}

export interface Snapshot {
  readonly nodes: ReadonlyArray<SnapshotNode>;
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

interface StepResult {
  readonly name: string;
  readonly checks: ReadonlyArray<Check>;
  readonly screenshot?: string | undefined;
  readonly video?: string | undefined;
  readonly contactSheet?: string | undefined;
  readonly lagFrame?: string | undefined;
  readonly samples: number;
}

interface DeviceResult {
  readonly device: E2eDevice;
  readonly label: string;
  readonly steps: ReadonlyArray<StepResult>;
  readonly error?: string;
}

const onScreen = (node: SnapshotNode, snapshot: Snapshot) =>
  node.rect !== undefined &&
  node.rect.width > 0 &&
  node.rect.height > 0 &&
  node.rect.x < snapshot.viewport.width &&
  node.rect.y < snapshot.viewport.height &&
  node.rect.x + node.rect.width > 0 &&
  node.rect.y + node.rect.height > 0;

const find = (snapshot: Snapshot, match: (node: SnapshotNode) => boolean) =>
  snapshot.nodes.filter((node) => match(node) && onScreen(node, snapshot));

export const chrome = (snapshot: Snapshot) => ({
  tabBar: find(snapshot, (node) => node.type === "TabBar")[0],
  navigationBar: find(snapshot, (node) => node.type === "NavigationBar")[0],
  backButton: find(snapshot, (node) => node.identifier === "BackButton")[0],
  send: find(snapshot, (node) => node.type === "Button" && node.label === "Send")[0],
  newChat: find(snapshot, (node) => node.type === "Button" && node.label === "New chat")[0],
  // Thread rows are full-width context-menu wrappers; the filter pills are narrow ones.
  threadRows: find(
    snapshot,
    (node) =>
      node.role === "MenuView" &&
      Boolean(node.label) &&
      (node.rect?.width ?? 0) >= snapshot.viewport.width * 0.9,
  ),
});

const check = (name: string, pass: boolean, detail: string): Check => ({ name, pass, detail });
const describeRect = (rect: Rect | undefined) =>
  rect
    ? `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}×${Math.round(rect.height)}`
    : "absent";
const inside = (rect: Rect, snapshot: Snapshot) =>
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.x + rect.width <= snapshot.viewport.width + 0.5 &&
  rect.y + rect.height <= snapshot.viewport.height + 0.5;

export function homeChecks(snapshot: Snapshot): Check[] {
  const { tabBar, newChat } = chrome(snapshot);
  return [
    check("tab bar visible", tabBar !== undefined, describeRect(tabBar?.rect)),
    check(
      "tab bar inside the screen",
      tabBar?.rect !== undefined && inside(tabBar.rect, snapshot),
      describeRect(tabBar?.rect),
    ),
    check("new chat button visible", newChat !== undefined, describeRect(newChat?.rect)),
  ];
}

export function threadChecks(snapshot: Snapshot, samples: ReadonlyArray<Snapshot>): Check[] {
  const { tabBar, backButton, send } = chrome(snapshot);
  const overlapping = samples.filter((sample) => {
    const state = chrome(sample);
    return state.backButton !== undefined && state.tabBar !== undefined;
  }).length;
  return [
    check("tab bar hidden", tabBar === undefined, describeRect(tabBar?.rect)),
    check("back button visible", backButton !== undefined, describeRect(backButton?.rect)),
    check(
      "composer inside the screen",
      send?.rect !== undefined && inside(send.rect, snapshot),
      describeRect(send?.rect),
    ),
    check(
      "no tabs over the entering thread",
      overlapping === 0,
      `${overlapping} of ${samples.length} transition samples showed tabs with a Back button`,
    ),
  ];
}

export function backChecks(snapshot: Snapshot, samples: ReadonlyArray<Snapshot>): Check[] {
  const listWithoutTabs = samples.filter((sample) => {
    const state = chrome(sample);
    return (
      state.backButton === undefined && state.newChat !== undefined && state.tabBar === undefined
    );
  }).length;
  return [
    ...homeChecks(snapshot),
    check(
      "tabs return with the list",
      listWithoutTabs === 0,
      `${listWithoutTabs} of ${samples.length} transition samples showed the list without tabs`,
    ),
  ];
}

/** Downsampled grayscale crops of one region, one per video frame (or one for a PNG). */
async function grayFrames(input: string, region: Rect, scale: number): Promise<Uint8Array[]> {
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  const [x, y, width, height] = [
    Math.round(region.x * scale),
    Math.round(region.y * scale),
    even(region.width * scale),
    even(region.height * scale),
  ];
  const [outWidth, outHeight] = [even(width / 6), even(height / 6)];
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        input,
        // One output frame per recorded frame, so indices match select=eq(n,…) for evidence.
        "-fps_mode",
        "passthrough",
        "-vf",
        `crop=${width}:${height}:${x}:${y},scale=${outWidth}:${outHeight},format=gray`,
        "-f",
        "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${stderr}`)),
    );
  });
  const size = outWidth * outHeight;
  return Array.from({ length: Math.floor(bytes.length / size) }, (_, index) =>
    bytes.subarray(index * size, (index + 1) * size),
  );
}

const distance = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += Math.abs(a[index]! - b[index]!);
  return sum / a.length;
};

/** How far a region has moved from its origin toward its destination look, 0 to 1. */
export interface FrameProgress {
  readonly nav: number;
  readonly chrome: number;
}

/**
 * A frame lags when the navigation bar is well into the transition while the tab bar region
 * still looks like the origin: tabs lingering over an entering thread, or a returned list drawn
 * before its tabs.
 */
export const chromeLags = (frame: FrameProgress) => frame.nav > 0.3 && frame.chrome < 0.4;
// One lagging frame is capture jitter; a regression lasts several.
const LAG_FRAME_LIMIT = 2;

const progress = (origin: number, destination: number) =>
  origin + destination === 0 ? 0 : origin / (origin + destination);

async function chromeLagFrames(input: {
  readonly video: string;
  readonly origin: string;
  readonly destination: string;
  readonly nav: Rect;
  readonly chrome: Rect;
  readonly scale: number;
}) {
  const [
    navFrames,
    chromeFrames,
    [navOrigin],
    [navDestination],
    [chromeOrigin],
    [chromeDestination],
  ] = await Promise.all([
    grayFrames(input.video, input.nav, input.scale),
    grayFrames(input.video, input.chrome, input.scale),
    grayFrames(input.origin, input.nav, input.scale),
    grayFrames(input.destination, input.nav, input.scale),
    grayFrames(input.origin, input.chrome, input.scale),
    grayFrames(input.destination, input.chrome, input.scale),
  ]);
  if (!navOrigin || !navDestination || !chromeOrigin || !chromeDestination)
    throw new Error("Could not read the reference screenshots.");
  const verdicts = navFrames.map((nav, index) => {
    const chrome = chromeFrames[index]!;
    return {
      nav: progress(distance(nav, navOrigin), distance(nav, navDestination)),
      chrome: progress(distance(chrome, chromeOrigin), distance(chrome, chromeDestination)),
    };
  });
  return verdicts.flatMap((verdict, index) => (chromeLags(verdict) ? [index] : []));
}

async function saveFrame(video: string, index: number, path: string) {
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    video,
    "-vf",
    `select=eq(n\\,${index})`,
    "-frames:v",
    "1",
    path,
  ]);
}

async function lagCheck(
  name: string,
  input: Parameters<typeof chromeLagFrames>[0],
  evidence: string,
): Promise<{ check: Check; frame?: string }> {
  const lagging = await chromeLagFrames(input);
  if (lagging.length < LAG_FRAME_LIMIT)
    return { check: check(name, true, `${lagging.length} lagging video frames`) };
  await saveFrame(input.video, lagging[0]!, evidence);
  return {
    check: check(name, false, `${lagging.length} video frames (first #${lagging[0]})`),
    frame: evidence,
  };
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv; readonly allowFailure?: boolean } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: REPO_ROOT,
      env: options.env ?? NodeProcess.env,
      stdio: ["ignore", "pipe", "pipe"],
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Device {
  readonly spec: E2eDevice;
  readonly udid: string;

  constructor(spec: E2eDevice, udid: string) {
    this.spec = spec;
    this.udid = udid;
  }

  async agent(args: ReadonlyArray<string>): Promise<Record<string, unknown>> {
    const { stdout } = await run(
      NodeProcess.execPath,
      [
        AGENT_DEVICE,
        ...args,
        "--platform",
        "ios",
        "--udid",
        this.udid,
        "--session",
        `t3-e2e-${this.spec.id}`,
        "--json",
      ],
      {
        env: { ...NodeProcess.env, AGENT_DEVICE_STATE_DIR: AGENT_DEVICE_STATE },
        allowFailure: true,
      },
    );
    const parsed = JSON.parse(stdout) as {
      success: boolean;
      data?: Record<string, unknown>;
      error?: { message: string };
    };
    if (!parsed.success) throw new Error(`agent-device ${args[0]}: ${parsed.error?.message}`);
    return parsed.data ?? {};
  }

  async snapshot(): Promise<Snapshot> {
    return (await this.agent(["snapshot"])) as unknown as Snapshot;
  }

  async waitFor(predicate: (snapshot: Snapshot) => boolean, label: string, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last: Snapshot | null = null;
    while (Date.now() < deadline) {
      last = await this.snapshot().catch(() => null);
      if (last && predicate(last)) return last;
      await delay(500);
    }
    throw new Error(`${this.spec.id}: timed out waiting for ${label}`);
  }

  /** Open a URL the way a user would; iOS asks before opening a custom scheme from another app. */
  async openUrl(url: string) {
    await run("xcrun", ["simctl", "openurl", this.udid, url]);
    await delay(1_500);
    await this.agent(["alert", "accept"]).catch(() => undefined);
  }

  async screenshot(path: string) {
    await run("xcrun", ["simctl", "io", this.udid, "screenshot", path]);
  }

  /** Run an action while recording and sampling the accessibility tree until the screen settles. */
  async transition(directory: string, name: string, action: () => Promise<unknown>) {
    const video = NodePath.join(directory, `${name}.mp4`);
    await this.agent(["record", "start", video, "--hide-touches"]);
    const samples: Snapshot[] = [];
    const sampling = { active: true };
    const sampler = (async () => {
      while (sampling.active) {
        const sample = await this.snapshot().catch(() => null);
        if (sample) samples.push(sample);
      }
    })();
    try {
      await action();
      await delay(2_000);
    } finally {
      sampling.active = false;
      await sampler;
      await this.agent(["record", "stop"]).catch(() => undefined);
    }
    const contactSheet = NodePath.join(directory, `${name}-frames.png`);
    const sheet = await run(
      NodeProcess.execPath,
      [AGENT_DEVICE, "record", "contact-sheet", video, "--out", contactSheet],
      {
        env: { ...NodeProcess.env, AGENT_DEVICE_STATE_DIR: AGENT_DEVICE_STATE },
        allowFailure: true,
      },
    );
    return { samples, video, contactSheet: sheet.code === 0 ? contactSheet : undefined };
  }
}

/** Screenshot pixels per snapshot point (3 on most iPhones). */
async function screenshotScale(path: string, snapshot: Snapshot): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width",
    "-of",
    "csv=p=0",
    path,
  ]);
  return Number(stdout.trim()) / snapshot.viewport.width;
}

async function ensureSimulator(spec: E2eDevice): Promise<string> {
  const name = `T3 E2E ${spec.id}`;
  const listing = JSON.parse(
    (await run("xcrun", ["simctl", "list", "devices", "available", "-j"])).stdout,
  ) as { devices: Record<string, ReadonlyArray<{ udid: string; name: string; state: string }>> };
  const existing = (listing.devices[spec.runtime] ?? []).find((device) => device.name === name);
  const udid =
    existing?.udid ??
    (await run("xcrun", ["simctl", "create", name, spec.deviceType, spec.runtime])).stdout.trim();
  if (existing?.state !== "Booted")
    await run("xcrun", ["simctl", "boot", udid], { allowFailure: true });
  await run("xcrun", ["simctl", "bootstatus", udid, "-b"]);
  await run("xcrun", ["simctl", "ui", udid, "appearance", "light"]);
  await run("xcrun", [
    "simctl",
    "status_bar",
    udid,
    "override",
    "--time",
    "9:41",
    "--batteryState",
    "charged",
    "--batteryLevel",
    "100",
  ]);
  return udid;
}

function lanAddress(): string {
  for (const addresses of Object.values(NodeOS.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254."))
        return address.address;
    }
  }
  throw new Error("No LAN IPv4 address for the simulator to reach Metro.");
}

async function runDevice(
  spec: E2eDevice,
  outputDirectory: string,
  environment: { readonly baseDir: string; readonly port: number },
  metroHost: string,
): Promise<DeviceResult> {
  const steps: StepResult[] = [];
  const directory = NodePath.join(outputDirectory, spec.id);
  await NodeFSP.mkdir(directory, { recursive: true });
  try {
    const udid = await ensureSimulator(spec);
    const device = new Device(spec, udid);
    // A fresh install drops connections paired by earlier runs; the cached client reinstalls in seconds.
    await run("xcrun", ["simctl", "uninstall", udid, BUNDLE_ID], { allowFailure: true });
    log(spec.id, "installing the dev client");
    await run(NodeProcess.execPath, ["scripts/mobile-native-client.ts", "ensure", "ios", udid], {
      env: { ...NodeProcess.env, T3_NATIVE_CLIENT_CACHE: NodeProcess.env.T3_NATIVE_CLIENT_CACHE },
    });
    const metroUrl = encodeURIComponent(`http://${metroHost}:${METRO_PORT}`);
    await device.openUrl(
      `t3code-dev://expo-development-client/?url=${metroUrl}&disableOnboarding=1&disableFab=1&disableAutoLaunch=1`,
    );
    // Snapshots read through an agent-device app session; open attaches one to the running app.
    await device.agent(["open", BUNDLE_ID]);
    // The app ignores the pairing link until its JS has loaded and shown the workspace.
    await device.waitFor(
      (snapshot) => chrome(snapshot).newChat !== undefined,
      "the app to load",
      120_000,
    );
    const paired = (snapshot: Snapshot) =>
      chrome(snapshot).tabBar !== undefined && chrome(snapshot).threadRows.length > 0;
    let home: Snapshot | null = null;
    for (let attempt = 1; attempt <= 2 && !home; attempt++) {
      log(spec.id, attempt === 1 ? "pairing" : "pairing again");
      const pairing = new URLSearchParams({
        pairingUrl: await issuePairUrl(environment),
        autoConnect: "1",
      });
      await device.openUrl(`t3code-dev://connections/new?${pairing}`);
      home = await device.waitFor(paired, "the paired thread list", 45_000).catch(() => null);
    }
    if (!home) throw new Error("The app did not show the fixture threads after pairing.");
    await delay(1_000);
    const homeShot = NodePath.join(directory, "home.png");
    await device.screenshot(homeShot);
    steps.push({ name: "home", checks: homeChecks(home), screenshot: homeShot, samples: 0 });

    log(spec.id, "opening a thread");
    const row = chrome(home).threadRows[0];
    if (!row?.label) throw new Error("No thread row to open.");
    const opened = await device.transition(directory, "open-thread", () =>
      device.agent(["press", `label=${JSON.stringify(row.label)}`]),
    );
    const thread = await device.waitFor(
      (snapshot) => chrome(snapshot).backButton !== undefined,
      "the thread screen",
    );
    const threadShot = NodePath.join(directory, "thread.png");
    await device.screenshot(threadShot);
    const { tabBar, navigationBar } = chrome(home);
    const scale = await screenshotScale(homeShot, home);
    const regions =
      tabBar?.rect && navigationBar?.rect ? { nav: navigationBar.rect, chrome: tabBar.rect } : null;
    const openLag = regions
      ? await lagCheck(
          "no tabs over the entering thread (video)",
          { video: opened.video, origin: homeShot, destination: threadShot, scale, ...regions },
          NodePath.join(directory, "open-thread-lag.png"),
        )
      : null;
    steps.push({
      name: "open thread",
      checks: [...threadChecks(thread, opened.samples), ...(openLag ? [openLag.check] : [])],
      lagFrame: openLag?.frame,
      screenshot: threadShot,
      video: opened.video,
      contactSheet: opened.contactSheet,
      samples: opened.samples.length,
    });

    log(spec.id, "going back");
    const back = await device.transition(directory, "back", () =>
      device.agent(["press", "id=BackButton"]),
    );
    const list = await device.waitFor(
      (snapshot) => chrome(snapshot).backButton === undefined,
      "the thread list",
    );
    const backShot = NodePath.join(directory, "back.png");
    await device.screenshot(backShot);
    const backLag = regions
      ? await lagCheck(
          "tabs return with the list (video)",
          { video: back.video, origin: threadShot, destination: backShot, scale, ...regions },
          NodePath.join(directory, "back-lag.png"),
        )
      : null;
    steps.push({
      name: "back",
      checks: [...backChecks(list, back.samples), ...(backLag ? [backLag.check] : [])],
      lagFrame: backLag?.frame,
      screenshot: backShot,
      video: back.video,
      contactSheet: back.contactSheet,
      samples: back.samples.length,
    });
    return { device: spec, label: spec.id, steps };
  } catch (error) {
    return {
      device: spec,
      label: spec.id,
      steps,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function issuePairUrl(environment: { readonly baseDir: string; readonly port: number }) {
  const { stdout } = await run(NodeProcess.execPath, [
    "apps/server/src/bin.ts",
    "auth",
    "pairing",
    "create",
    "--base-dir",
    environment.baseDir,
    "--base-url",
    `http://127.0.0.1:${environment.port}`,
    "--ttl",
    "15m",
    "--json",
  ]);
  const { pairUrl } = JSON.parse(
    stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1),
  ) as {
    pairUrl?: string;
  };
  if (!pairUrl) throw new Error("The pairing command returned no pairUrl.");
  return pairUrl;
}

const log = (scope: string, message: string) => NodeProcess.stderr.write(`[${scope}] ${message}\n`);

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function renderReport(results: ReadonlyArray<DeviceResult>, outputDirectory: string): string {
  const relative = (path: string | undefined) =>
    path ? escapeHtml(NodePath.relative(outputDirectory, path)) : "";
  const rows = results
    .map((result) => {
      const steps = result.steps
        .map((step) => {
          const checks = step.checks
            .map(
              (item) =>
                `<li class="${item.pass ? "pass" : "fail"}">${item.pass ? "✓" : "✗"} ${escapeHtml(item.name)} <small>${escapeHtml(item.detail)}</small></li>`,
            )
            .join("");
          const media = [
            step.screenshot
              ? `<a href="${relative(step.screenshot)}"><img src="${relative(step.screenshot)}"></a>`
              : "",
            step.lagFrame
              ? `<a href="${relative(step.lagFrame)}"><img class="lag" src="${relative(step.lagFrame)}"></a>`
              : "",
            step.contactSheet
              ? `<a href="${relative(step.contactSheet)}">transition frames</a>`
              : "",
            step.video ? `<a href="${relative(step.video)}">video</a>` : "",
          ].join(" ");
          return `<td><h3>${escapeHtml(step.name)}</h3><ul>${checks}</ul>${media}</td>`;
        })
        .join("");
      const error = result.error ? `<td class="fail">${escapeHtml(result.error)}</td>` : "";
      return `<tr><th>${escapeHtml(result.label)}</th>${steps}${error}</tr>`;
    })
    .join("");
  const failures = results.filter(
    (result) => result.error || result.steps.some((step) => step.checks.some((item) => !item.pass)),
  ).length;
  return `<!doctype html><meta charset="utf-8"><title>Mobile E2E</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px;vertical-align:top}img{width:180px;display:block;margin:6px 0}img.lag{outline:3px solid #b42318}.pass{color:#16794a}.fail{color:#b42318}ul{padding-left:16px;margin:4px 0}small{color:#666}</style>
<h1>Mobile E2E · ${failures === 0 ? "all devices passed" : `${failures} device(s) failed`}</h1>
<table>${rows}</table>`;
}

async function main() {
  const args = NodeProcess.argv.slice(2);
  if (args.includes("--list")) {
    for (const device of DEVICES) NodeProcess.stdout.write(`${device.id}\n`);
    return;
  }
  const selected = args.flatMap((arg, index) => (args[index - 1] === "--device" ? [arg] : []));
  const devices = selected.length
    ? DEVICES.filter((device) => selected.includes(device.id))
    : DEVICES;
  const unknown = selected.filter((id) => !DEVICES.some((device) => device.id === id));
  if (unknown.length) throw new Error(`Unknown device ${unknown.join(", ")}. Run with --list.`);
  const concurrencyArg = args[args.indexOf("--concurrency") + 1];
  const concurrency = args.includes("--concurrency") ? Number(concurrencyArg) : 3;

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const outputDirectory = NodePath.join(REPO_ROOT, "artifacts/mobile-e2e", stamp);
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  const rootDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mobile-e2e-"));
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
    const metroHost = lanAddress();
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
        String(METRO_PORT),
      ],
      {
        cwd: NodePath.join(REPO_ROOT, "apps/mobile"),
        env: { ...NodeProcess.env, APP_VARIANT: "development", CI: "1" },
        stdio: ["ignore", "ignore", "inherit"],
        // Its own group, so stopping it also stops the expo child that owns the port.
        detached: true,
      },
    );
    await waitForPort(METRO_PORT, "Metro", 120_000);
    await run("curl", [
      "-sf",
      "-o",
      "/dev/null",
      `http://127.0.0.1:${METRO_PORT}/apps/mobile/index.bundle?platform=ios&dev=true&minify=false`,
    ]);

    // The first install may build; later ones reuse its artifact.
    const results: DeviceResult[] = [];
    const [first, ...rest] = devices;
    if (first) results.push(await runDevice(first, outputDirectory, environment, metroHost));
    for (let index = 0; index < rest.length; index += concurrency) {
      results.push(
        ...(await Promise.all(
          rest
            .slice(index, index + concurrency)
            .map((device) => runDevice(device, outputDirectory, environment, metroHost)),
        )),
      );
    }
    const report = NodePath.join(outputDirectory, "index.html");
    await NodeFSP.writeFile(report, renderReport(results, outputDirectory));
    await NodeFSP.writeFile(
      NodePath.join(outputDirectory, "report.json"),
      JSON.stringify(results, null, 2),
    );
    const failed = results.filter(
      (result) =>
        result.error || result.steps.some((step) => step.checks.some((item) => !item.pass)),
    );
    for (const result of results) {
      const failures = result.steps.flatMap((step) =>
        step.checks
          .filter((item) => !item.pass)
          .map((item) => `${step.name}: ${item.name} (${item.detail})`),
      );
      log(result.label, result.error ?? (failures.length ? failures.join("; ") : "passed"));
    }
    NodeProcess.stdout.write(
      `${JSON.stringify({ report, devices: results.length, failed: failed.length })}\n`,
    );
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    if (metro?.pid) {
      try {
        process.kill(-metro.pid, "SIGTERM");
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
