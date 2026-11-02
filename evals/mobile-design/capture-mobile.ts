// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator automation uses Node subprocess and timing APIs directly.

import type * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import sharp from "sharp";

import {
  buildIos,
  buildShowcasePairingUrl,
  ensureIosFullScreenAppsMode,
  IOS_APP_PATH,
  issuePairingCredential,
  reserveAvailablePort,
  startShowcaseEnvironments,
  startShowcaseMetro,
  stopProcess,
  waitForPort,
} from "../../scripts/mobile-showcase.ts";
import {
  SHOWCASE_ENVIRONMENTS,
  SHOWCASE_PROJECTS,
} from "../../scripts/mobile-showcase-environment.ts";
import { FLOWS, SCENES, type Flow, type Pose, type SceneId } from "./cases.ts";
import { delay, linkTargets, type LinkTargets, run, Simulator } from "./ios.ts";

/** One screenshot of the run, as `captures/captures.json` records it. */
export interface MobileShot {
  readonly pose: string;
  readonly scene: SceneId;
  readonly file: string;
  /** Set when the scene did not reach its ready state; the screenshot shows where it stopped. */
  readonly problem?: string;
}

export interface FlowResult {
  readonly flow: string;
  readonly taps: number;
  readonly screens: number;
  readonly frames: ReadonlyArray<{ readonly file: string; readonly action: string }>;
  readonly problem?: string;
}

const THREAD_LIST = /^Plan offline mode/;
const LONG_PROMPT = `Rework the handoff from desktop to phone so it feels like one continuous session.

1. When I pick up the phone, open the thread I last touched on the desktop, scrolled to the same message, with the composer draft carried over.
2. Keep the terminal attached: same buffer, same scroll position, and the cursor where I left it.
3. If the desktop is mid-turn, show the live stream instead of a spinner, and let me stop or steer from the phone.
4. Never lose a draft. If both devices edit the same draft, keep both and ask which one wins.

Measure the time from unlock to a usable thread and keep it under 300ms on a warm start. Add a test for each rule.`;

/** Pre-fills the long-prompt and attachment drafts before launch; the app reads them at start. */
async function seedComposerDrafts(simulator: Simulator, targets: LinkTargets) {
  const documents = NodePath.join(await simulator.dataContainer(), "Documents");
  const images = NodePath.join(documents, "design-eval");
  await NodeFSP.mkdir(images, { recursive: true });
  const attachments = await Promise.all(
    SHOWCASE_PROJECTS.slice(0, 2).map(async (project, index) => {
      const file = NodePath.join(images, `${project.id}-mock.png`);
      const png = await sharp(Buffer.from(project.favicon)).resize(900, 900).png().toBuffer();
      await NodeFSP.writeFile(file, png);
      return {
        id: `design-eval-image-${index}`,
        type: "image",
        name: `${project.id}-mock.png`,
        mimeType: "image/png",
        sizeBytes: png.byteLength,
        fileUri: `file://${file}`,
        previewUri: `file://${file}`,
      };
    }),
  );
  const key = (id: string) => {
    const thread = targets.get(id);
    if (!thread) throw new Error(`Unknown draft thread ${id}.`);
    return `${thread.environmentId}:${thread.threadId}`;
  };
  await NodeFSP.mkdir(NodePath.join(documents, "composer-drafts"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(documents, "composer-drafts", "drafts.json"),
    JSON.stringify({
      schemaVersion: 1,
      drafts: {
        [key("pocket-command-center")]: { text: LONG_PROMPT, attachments: [] },
        [key("handoff-haptics")]: {
          text: "Match the haptic to these two frames of the handoff.",
          attachments,
        },
      },
    }),
  );
}

/** Keeps every cause when a capture fails for more than one reason. */
const joinProblems = (earlier: string | undefined, next: string) =>
  earlier ? `${earlier}; ${next}` : next;

async function captureScene(
  simulator: Simulator,
  pose: Pose,
  sceneId: SceneId,
  targets: LinkTargets,
  outDirectory: string,
  poseProblem: string | undefined,
): Promise<MobileShot> {
  const scene = SCENES.find((candidate) => candidate.id === sceneId)!;
  const file = NodePath.join("captures", pose.id, `${scene.id}.png`);
  let problem = poseProblem;
  try {
    await ("fresh" in scene ? simulator.relaunch(THREAD_LIST) : simulator.home(THREAD_LIST));
    await simulator.withUsableTaps(async () => {
      for (const step of scene.steps) await simulator.perform(step, targets);
    });
    if ("ready" in scene) await simulator.waitFor(new RegExp(scene.ready), scene.title);
  } catch (error) {
    problem = joinProblems(problem, error instanceof Error ? error.message : String(error));
  }
  // Screenshot a failed scene too: where it stopped is the diagnosis.
  await delay(1_500);
  await simulator.screenshot(NodePath.join(outDirectory, file), pose).catch((error: unknown) => {
    problem = joinProblems(
      problem,
      `screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if ("reset" in scene) {
    for (const step of scene.reset) await simulator.perform(step, targets).catch(() => undefined);
  }
  return { pose: pose.id, scene: scene.id, file, ...(problem ? { problem } : {}) };
}

function scenesFor(pose: Pose, only: ReadonlySet<SceneId> | null): ReadonlyArray<SceneId> {
  return (pose.scenes ?? SCENES.map((scene) => scene.id)).filter(
    (scene) => only === null || only.has(scene),
  );
}

/** A screen is its title: the text in the top band, where the navigation bar or a sheet header sits. */
async function screenSignature(simulator: Simulator): Promise<string> {
  const snapshot = await simulator.snapshot();
  const top = snapshot.viewport.height * 0.16;
  return snapshot.nodes
    .filter((node) => node.kind === "text" && node.label && (node.rect?.y ?? Infinity) < top)
    .map((node) => node.label)
    .join("|");
}

async function captureFlow(
  simulator: Simulator,
  pose: Pose,
  flow: Flow,
  targets: LinkTargets,
  outDirectory: string,
  poseProblem: string | undefined,
): Promise<FlowResult> {
  const frames: Array<{ file: string; action: string }> = [];
  const signatures = new Set<string>();
  let problem = poseProblem;
  const frame = async (action: string) => {
    const file = NodePath.join("captures", "flows", flow.id, `${frames.length}.png`);
    await delay(1_200);
    await simulator.screenshot(NodePath.join(outDirectory, file), pose);
    // A failed snapshot says nothing about the screen, so it adds no signature.
    const signature = await screenSignature(simulator).catch(() => null);
    if (signature !== null) signatures.add(signature);
    frames.push({ file, action });
  };
  try {
    await simulator.home(THREAD_LIST);
    await frame("Start");
    for (const step of flow.steps) {
      const tapped = await simulator.perform(step, targets);
      if (tapped === null) continue;
      // The label actually tapped, so the filmstrip names what this build shows.
      const action =
        "tap" in step
          ? `Tap ${tapped}`
          : "type" in step
            ? `Type "${step.type}"`
            : "focus" in step
              ? "Tap the composer"
              : "clear" in step
                ? "Clear the composer"
                : "link" in step
                  ? `Open ${step.link}`
                  : `Scroll ${step.scroll}`;
      await frame(action);
    }
  } catch (error) {
    problem = joinProblems(problem, error instanceof Error ? error.message : String(error));
  }
  return {
    flow: flow.id,
    // Count what was done, so a flow that stopped early does not claim its planned taps.
    taps: frames.filter((frame) => frame.action.startsWith("Tap")).length,
    screens: signatures.size,
    frames,
    ...(problem ? { problem } : {}),
  };
}

/**
 * Captures every pose on macOS: boots the fixture environments with live threads, a Metro for the
 * showcase build, and one dedicated simulator per device class, deleted afterwards.
 */
export async function captureMobile(input: {
  readonly outDirectory: string;
  readonly poses: ReadonlyArray<Pose>;
  readonly scenes: ReadonlySet<SceneId> | null;
  readonly flows: boolean;
  readonly skipBuild: boolean;
  readonly log: (message: string) => void;
}): Promise<{
  readonly shots: ReadonlyArray<MobileShot>;
  readonly flows: ReadonlyArray<FlowResult>;
}> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- A host CLI with no Effect runtime.
  if (process.platform !== "darwin") throw new Error("Mobile capture needs macOS with Xcode.");
  const appPath = input.skipBuild ? IOS_APP_PATH : await buildIos();
  await NodeFSP.access(appPath).catch(() => {
    throw new Error(`No showcase build at ${appPath}. Run without --skip-build.`);
  });
  const runId = Date.now().toString(36);
  const rootDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-design-"));
  const servers: NodeChildProcess.ChildProcess[] = [];
  let metro: NodeChildProcess.ChildProcess | null = null;
  const shots: MobileShot[] = [];
  const flows: FlowResult[] = [];
  try {
    input.log("starting the fixture environments");
    const environments = await startShowcaseEnvironments(
      rootDir,
      (server) => servers.push(server),
      SHOWCASE_ENVIRONMENTS,
      { liveThreads: true },
    );
    const targets = linkTargets(environments);
    const metroPort = await reserveAvailablePort();
    metro = startShowcaseMetro(metroPort, { showcase: false });
    await waitForPort(metroPort, "Metro", 120_000);
    input.log("bundling");
    // Warm the exact bundle the dev client asks for; a cold build can outlast its load timeout.
    const manifest = await run("curl", [
      "-sf",
      "-H",
      "expo-platform: ios",
      "-H",
      "accept: application/expo+json,application/json",
      `http://127.0.0.1:${metroPort}`,
    ]);
    const bundleUrl = (JSON.parse(manifest.stdout) as { launchAsset: { url: string } }).launchAsset
      .url;
    await run("curl", ["-sf", "-o", "/dev/null", bundleUrl], { timeoutMs: 900_000 });

    // The flows answer the question and stop background work on the shared servers, so the
    // iPhone, which runs them, goes last.
    const devices = [...new Set(input.poses.map((pose) => pose.device))].toSorted(
      (a, b) => Number(a === "iphone") - Number(b === "iphone"),
    );
    for (const device of devices) {
      input.log(`${device}: creating the simulator`);
      let simulator: Simulator | null = null;
      try {
        simulator = await Simulator.create(device, runId);
        // iPadOS windowing keeps full-screen apps portrait unless it is off.
        if (device === "ipad") await ensureIosFullScreenAppsMode(simulator.udid);
        await simulator.install(appPath);
        await seedComposerDrafts(simulator, targets);
        input.log(`${device}: launching`);
        await simulator.launch(`http://127.0.0.1:${metroPort}`);
        const pairings = await Promise.all(
          environments.map(async (environment) => ({
            url: buildShowcasePairingUrl(
              "127.0.0.1",
              environment.port,
              await issuePairingCredential(environment.baseDir),
            ),
            label: environment.label,
          })),
        );
        await simulator.pair(pairings);
        for (const pose of input.poses.filter((candidate) => candidate.device === device)) {
          input.log(`${pose.id}: capturing`);
          // One failed XCTest call marks this pose's shots; it should not cost the other poses.
          const poseProblem = await simulator
            .applyPose(pose)
            .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
          if (poseProblem) input.log(`${pose.id}: ${poseProblem}`);
          const scenes = scenesFor(pose, input.scenes);
          for (const scene of scenes) {
            const shot = await captureScene(
              simulator,
              pose,
              scene,
              targets,
              input.outDirectory,
              poseProblem,
            );
            if (shot.problem) input.log(`${pose.id}/${scene}: ${shot.problem}`);
            shots.push(shot);
          }
        }
        const flowPose = input.poses.find((pose) => pose.id === "iphone-dark");
        if (input.flows && device === "iphone" && flowPose) {
          const flowProblem = await simulator
            .applyPose(flowPose)
            .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
          if (flowProblem) input.log(`flows: ${flowProblem}`);
          for (const flow of FLOWS) {
            input.log(`flow ${flow.id}`);
            const result = await captureFlow(
              simulator,
              flowPose,
              flow,
              targets,
              input.outDirectory,
              flowProblem,
            );
            if (result.problem) input.log(`flow ${flow.id}: ${result.problem}`);
            flows.push(result);
          }
        }
      } catch (error) {
        // One device failing should not cost the others their captures. Its missing scenes are
        // recorded as failed, so a reused run directory cannot pack their older screenshots.
        const problem = `${device} stopped: ${error instanceof Error ? error.message : String(error)}`;
        input.log(problem);
        for (const pose of input.poses.filter((candidate) => candidate.device === device)) {
          for (const scene of scenesFor(pose, input.scenes)) {
            if (shots.some((shot) => shot.pose === pose.id && shot.scene === scene)) continue;
            shots.push({
              pose: pose.id,
              scene,
              file: NodePath.join("captures", pose.id, `${scene}.png`),
              problem,
            });
          }
        }
        if (input.flows && device === "iphone") {
          for (const flow of FLOWS) {
            if (flows.some((result) => result.flow === flow.id)) continue;
            flows.push({ flow: flow.id, taps: 0, screens: 0, frames: [], problem });
          }
        }
      } finally {
        await simulator?.delete();
      }
    }
  } finally {
    await Promise.all([...(metro ? [stopProcess(metro)] : []), ...servers.map(stopProcess)]);
    await NodeFSP.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return { shots, flows };
}
