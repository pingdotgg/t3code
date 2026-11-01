// @effect-diagnostics nodeBuiltinImport:off - Host-side capture uses Node subprocess and filesystem APIs directly.

import type * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  issuePairingCredential,
  startShowcaseEnvironments,
  stopProcess,
} from "../../scripts/mobile-showcase.ts";
import { SHOWCASE_ENVIRONMENTS } from "../../scripts/mobile-showcase-environment.ts";
import { SCENES, type SceneId } from "./cases.ts";
import { expandPath, linkTargets, run } from "./ios.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const WEB_ROOT = NodePath.join(REPO_ROOT, "apps/web");
const VIEWPORT = "1440x900";
// Dark mode is the primary look; the web app reads it from these keys before it renders.
const DARK_MODE = [
  ["t3code:theme", "dark"],
  ["t3code:theme-appearance-mode", "dark"],
  ["t3code:theme-follow-system", "false"],
]
  .map(([key, value]) => `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
  .join("; ");

export interface DesktopShot {
  readonly scene: SceneId;
  readonly file: string;
  readonly problem?: string;
}

/** The shot skill's CLI; set SHOT or pass --shot when it lives elsewhere. */
export async function findShot(explicit: string | undefined): Promise<string | null> {
  const home = NodeOS.homedir();
  const candidates = [
    explicit,
    process.env.SHOT,
    NodePath.join(home, ".claude/skills/shot/scripts/shot"),
    NodePath.join(home, ".codex/skills/shot/scripts/shot"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (
      await NodeFSP.access(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return null;
}

/**
 * Captures the desktop half of each "conforms to desktop" pair: the built web client, served by
 * the same seeded environments the phone uses, at a desktop window size.
 */
export async function captureDesktop(input: {
  readonly outDirectory: string;
  readonly shot: string;
  readonly scenes: ReadonlySet<SceneId> | null;
  readonly skipBuild: boolean;
  readonly log: (message: string) => void;
}): Promise<ReadonlyArray<DesktopShot>> {
  const built = await NodeFSP.access(NodePath.join(WEB_ROOT, "dist/index.html")).then(
    () => true,
    () => false,
  );
  if (!input.skipBuild || !built) {
    input.log("building the web client");
    await run("vp", ["build"], { cwd: WEB_ROOT, timeoutMs: 900_000 });
  }
  const rootDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-design-web-"));
  const servers: NodeChildProcess.ChildProcess[] = [];
  const shots: DesktopShot[] = [];
  try {
    input.log("starting the fixture environments");
    const environments = await startShowcaseEnvironments(
      rootDir,
      (server) => servers.push(server),
      SHOWCASE_ENVIRONMENTS,
      { liveThreads: true },
    );
    const targets = linkTargets(environments);
    for (const scene of SCENES) {
      if (!("desktop" in scene) || (input.scenes && !input.scenes.has(scene.id))) continue;
      // A thread opens on the environment that owns it; other pages use the first one.
      const threadId = /\{thread:([^}]+)\}/.exec(scene.desktop.path)?.[1];
      const owner = threadId ? targets.get(threadId)?.environmentId : undefined;
      const environment =
        environments.find((candidate) => candidate.environmentId === owner) ?? environments[0]!;
      const path = `/${expandPath(scene.desktop.path.slice(1), targets)}`;
      const credential = await issuePairingCredential(environment.baseDir);
      const file = NodePath.join("captures", "desktop", `${scene.id}.png`);
      await NodeFSP.mkdir(NodePath.join(input.outDirectory, "captures", "desktop"), {
        recursive: true,
      });
      const result = await run(
        input.shot,
        [
          `http://127.0.0.1:${environment.port}/pair#token=${credential}`,
          "--size",
          VIEWPORT,
          "--sleep",
          "2500",
          "--eval",
          `${DARK_MODE}; location.assign(${JSON.stringify(path)})`,
          "--sleep",
          "4000",
          ...("click" in scene.desktop ? ["--click", scene.desktop.click, "--sleep", "1500"] : []),
          "--out",
          NodePath.join(input.outDirectory, file),
        ],
        { allowFailure: true, timeoutMs: 120_000 },
      );
      const problem =
        result.code === 0
          ? undefined
          : result.stderr.trim().split("\n")[0] || `shot exited with code ${result.code}`;
      if (problem) input.log(`desktop/${scene.id}: ${problem}`);
      shots.push({ scene: scene.id, file, ...(problem ? { problem } : {}) });
    }
  } finally {
    await Promise.all(servers.map(stopProcess));
    await NodeFSP.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return shots;
}
