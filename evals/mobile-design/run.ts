#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A host-side CLI that drives captures and writes files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { captureDesktop, findShot, type DesktopShot } from "./capture-desktop.ts";
import { captureMobile, type FlowResult, type MobileShot } from "./capture-mobile.ts";
import {
  DEFAULT_PANEL,
  PANEL,
  POSES,
  SCENES,
  type DeviceClassId,
  type PanelMember,
  type SceneId,
} from "./cases.ts";
import { buildPack } from "./pack.ts";
import { parseReviewerReply, renderSummary, summarizeRound, type RoundSummary } from "./scores.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    capture: { type: "string", multiple: true },
    pack: { type: "boolean", default: false },
    summarize: { type: "boolean", default: false },
    baseline: { type: "string" },
    pose: { type: "string", multiple: true },
    case: { type: "string", multiple: true },
    "no-flows": { type: "boolean", default: false },
    "skip-build": { type: "boolean", default: false },
    panel: { type: "string" },
    shot: { type: "string" },
  },
});

if (!values.out) {
  throw new Error(
    "Use --out <directory>. Add --capture mobile|desktop, --pack, or --summarize [--baseline <run>].",
  );
}
const out = NodePath.resolve(values.out);
const log = (message: string) => process.stderr.write(`[mobile-design] ${message}\n`);
const capturesFile = NodePath.join(out, "captures", "captures.json");

const unknownCases = (values.case ?? []).filter((id) => !SCENES.some((scene) => scene.id === id));
if (unknownCases.length > 0) throw new Error(`Unknown case ${unknownCases.join(", ")}.`);
const scenes = values.case ? new Set(values.case as ReadonlyArray<SceneId>) : null;
const poses = POSES.filter((pose) => !values.pose || values.pose.includes(pose.id));
if (poses.length === 0)
  throw new Error(`No pose matches. Poses: ${POSES.map((pose) => pose.id).join(", ")}.`);
const panel = (values.panel?.split(",") ?? DEFAULT_PANEL).map((member) => {
  if (!(member in PANEL))
    throw new Error(`Unknown panel member ${member}. Use ${Object.keys(PANEL).join(", ")}.`);
  return member as PanelMember;
});

interface Captures {
  readonly shots: ReadonlyArray<MobileShot>;
  readonly flows: ReadonlyArray<FlowResult>;
  readonly desktop: ReadonlyArray<DesktopShot>;
}

async function readCaptures(): Promise<Captures> {
  const text = await NodeFSP.readFile(capturesFile, "utf8").catch(() => null);
  return text ? (JSON.parse(text) as Captures) : { shots: [], flows: [], desktop: [] };
}

/** Merges new captures over earlier ones, so one run can add desktop pairs or redo a pose. */
async function saveCaptures(update: Partial<Captures>) {
  const current = await readCaptures();
  const replaced = <T extends { readonly file: string }>(
    earlier: ReadonlyArray<T>,
    next: ReadonlyArray<T> | undefined,
  ) =>
    next
      ? [...earlier.filter((item) => !next.some((n) => n.file === item.file)), ...next]
      : earlier;
  const merged: Captures = {
    shots: replaced(current.shots, update.shots),
    flows: update.flows
      ? [
          ...current.flows.filter((flow) => !update.flows!.some((n) => n.flow === flow.flow)),
          ...update.flows,
        ]
      : current.flows,
    desktop: replaced(current.desktop, update.desktop),
  };
  await NodeFSP.mkdir(NodePath.dirname(capturesFile), { recursive: true });
  await NodeFSP.writeFile(capturesFile, `${JSON.stringify(merged, null, 2)}\n`);
}

/** The commit under review and how long each capture took. Kept outside the pack so reviewers stay blind. */
async function writeRunInfo(capture: string, startedAt: number) {
  const commit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const file = NodePath.join(out, "run.json");
  const earlier: { readonly minutes?: Record<string, number> } = await NodeFSP.readFile(
    file,
    "utf8",
  ).then(
    (text) => JSON.parse(text),
    () => ({}),
  );
  const minutes = {
    ...earlier.minutes,
    [capture]: Math.round((Date.now() - startedAt) / 6_000) / 10,
  };
  await NodeFSP.writeFile(file, `${JSON.stringify({ commit, minutes }, null, 2)}\n`);
}

async function summarize() {
  const directory = NodePath.join(out, "scores");
  const files = (await NodeFSP.readdir(directory).catch(() => [])).filter((name) =>
    name.endsWith(".md"),
  );
  if (files.length === 0)
    throw new Error(`Save each reviewer's reply as ${directory}/<reviewer>.md first.`);
  const reviewers = Object.fromEntries(
    await Promise.all(
      files.map(async (name) => {
        const reply = await NodeFSP.readFile(NodePath.join(directory, name), "utf8");
        try {
          return [name.replace(/\.md$/, ""), parseReviewerReply(reply)] as const;
        } catch (error) {
          throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          });
        }
      }),
    ),
  );
  const baseline: RoundSummary | null = values.baseline
    ? JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(NodePath.resolve(values.baseline), "summary.json"),
          "utf8",
        ),
      )
    : null;
  // A reply that skips a device the pack shows would quietly thin that device's median.
  const council: { readonly devices?: ReadonlyArray<DeviceClassId> } = await NodeFSP.readFile(
    NodePath.join(out, "council.json"),
    "utf8",
  ).then(
    (text) => JSON.parse(text),
    () => ({}),
  );
  for (const [name, review] of Object.entries(reviewers)) {
    const missing = (council.devices ?? []).filter((device) => !review.scores[device]);
    if (missing.length > 0) throw new Error(`${name}.md does not score ${missing.join(", ")}.`);
  }
  const round = summarizeRound(reviewers);
  await NodeFSP.writeFile(
    NodePath.join(out, "summary.json"),
    `${JSON.stringify(round, null, 2)}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(out, "summary.md"), renderSummary(round, baseline));
  log(`wrote ${NodePath.join(out, "summary.md")}`);
}

const steps = new Set(values.capture ?? []);
for (const step of steps) {
  if (step !== "mobile" && step !== "desktop")
    throw new Error(`Unknown capture ${step}. Use mobile or desktop.`);
}
if (steps.has("mobile")) {
  const startedAt = Date.now();
  const result = await captureMobile({
    outDirectory: out,
    poses,
    scenes,
    flows: !values["no-flows"],
    skipBuild: values["skip-build"],
    log,
  });
  await saveCaptures(result);
  await writeRunInfo("mobile", startedAt);
}
if (steps.has("desktop")) {
  const startedAt = Date.now();
  const shot = await findShot(values.shot);
  if (!shot)
    throw new Error("Desktop capture uses the shot skill. Install it, or pass --shot <path>.");
  await saveCaptures({
    desktop: await captureDesktop({
      outDirectory: out,
      shot,
      scenes,
      skipBuild: values["skip-build"],
      log,
    }),
  });
  await writeRunInfo("desktop", startedAt);
}
if (values.pack || steps.size > 0) {
  const captures = await readCaptures();
  const { brief } = await buildPack({
    outDirectory: out,
    ...captures,
    referencesDirectory: NodePath.join(import.meta.dirname, "references"),
    panel,
  });
  const problems = [
    ...captures.shots.filter((shot) => shot.problem).map((shot) => `${shot.pose}/${shot.scene}`),
    ...captures.flows.filter((flow) => flow.problem).map((flow) => `flow ${flow.flow}`),
    ...captures.desktop.filter((shot) => shot.problem).map((shot) => `desktop/${shot.scene}`),
  ];
  log(`pack ready: ${brief}`);
  if (problems.length > 0)
    log(`check these captures, they did not reach their ready state: ${problems.join(", ")}`);
}
if (values.summarize) await summarize();
