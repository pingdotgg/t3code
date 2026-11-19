// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off extendsNativeError:off - Plain-TypeScript game bridge core (sockets, files, vendor HTTP), unit-tested without an Effect runtime; GameDevService wraps it.
import * as NodePath from "node:path";

import type { GameEngineInstall, GameEngineId, GameInstallTarget, GameProject } from "@t3tools/contracts";
import {
  BRIDGE_PROJECT_PATHS,
  blenderExecutableCandidates,
  compareEngineVersions,
  engineForProjectFiles,
  parseBlenderVersionOutput,
  parseLauncherInstalled,
  parseUnityHubSecondaryPath,
  parseUnityProjectVersion,
  parseUnrealBuildVersion,
  parseUnrealInstallIni,
  parseUProject,
  robloxStudioRoots,
  unityEditorExecutable,
  unityHubConfigDir,
  unityHubEditorRoots,
  unityHubExecutableCandidates,
  unrealDefaultRoots,
  unrealEditorExecutable,
  unrealLauncherDataFile,
  type HostPaths,
  type HostPlatform,
} from "@t3tools/shared/gameDevCatalog";

import { exists, listDir, readText, run } from "./gameDevFiles.ts";

export interface DetectionHost {
  readonly platform: HostPlatform;
  readonly paths: HostPaths;
  /** Continuum's own tools folder, where it unpacks portable builds such as Blender. */
  readonly toolsDir: string;
  readonly pathDirs: ReadonlyArray<string>;
}

export interface LocatedInstall {
  readonly target: GameInstallTarget;
  readonly path: string;
  readonly version: string;
}

const pathJoin = (platform: HostPlatform, ...parts: string[]) =>
  platform === "win32" ? NodePath.win32.join(...parts) : NodePath.posix.join(...parts);

async function unityInstalls(host: DetectionHost): Promise<GameEngineInstall[]> {
  const roots = [...unityHubEditorRoots(host.platform, host.paths)];
  const secondary = parseUnityHubSecondaryPath(
    (await readText(pathJoin(host.platform, unityHubConfigDir(host.platform, host.paths), "secondaryInstallPath.json"))) ?? "",
  );
  if (secondary) roots.push(secondary);
  const installs: GameEngineInstall[] = [];
  for (const root of roots) {
    for (const entry of await listDir(root)) {
      if (!entry.isDirectory() || !/^\d+\.\d+\.\d+[abfp]\d+/.test(entry.name)) continue;
      const executable = unityEditorExecutable(host.platform, pathJoin(host.platform, root, entry.name));
      if (await exists(executable)) {
        installs.push({ target: "unity", version: entry.name, path: executable, source: "detected" });
      }
    }
  }
  return installs;
}

async function firstExisting(candidates: ReadonlyArray<string>): Promise<string | null> {
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

async function onPath(host: DetectionHost, names: ReadonlyArray<string>): Promise<string | null> {
  for (const dir of host.pathDirs) {
    for (const name of names) {
      const candidate = pathJoin(host.platform, dir, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

async function unityHub(host: DetectionHost): Promise<GameEngineInstall | null> {
  const path =
    (await firstExisting(unityHubExecutableCandidates(host.platform, host.paths))) ??
    (await onPath(host, host.platform === "win32" ? ["Unity Hub.exe"] : ["unityhub"]));
  return path ? { target: "unity-hub", version: "installed", path, source: "detected" } : null;
}

async function unrealRoot(host: DetectionHost, root: string): Promise<GameEngineInstall | null> {
  const executable = unrealEditorExecutable(host.platform, root);
  if (!(await exists(executable))) return null;
  const version =
    parseUnrealBuildVersion((await readText(pathJoin(host.platform, root, "Engine", "Build", "Build.version"))) ?? "") ??
    "unknown";
  return { target: "unreal", version, path: executable, source: "detected" };
}

async function unrealInstalls(host: DetectionHost): Promise<GameEngineInstall[]> {
  const roots = new Set<string>();
  const launcherFile = unrealLauncherDataFile(host.platform, host.paths);
  if (launcherFile) {
    for (const entry of parseLauncherInstalled((await readText(launcherFile)) ?? "")) roots.add(entry.location);
  }
  if (host.platform === "linux") {
    for (const path of parseUnrealInstallIni((await readText(`${host.paths.home}/.config/Epic/UnrealEngine/Install.ini`)) ?? "")) {
      roots.add(path);
    }
  }
  for (const base of unrealDefaultRoots(host.platform, host.paths)) {
    if (await exists(pathJoin(host.platform, base, "Engine"))) roots.add(base);
    for (const entry of await listDir(base)) {
      if (entry.isDirectory() && /^UE_\d/.test(entry.name)) roots.add(pathJoin(host.platform, base, entry.name));
    }
  }
  const installs: GameEngineInstall[] = [];
  for (const root of roots) {
    const install = await unrealRoot(host, root);
    if (install) installs.push(install);
  }
  return installs;
}

async function epicLauncher(host: DetectionHost): Promise<GameEngineInstall | null> {
  const candidates =
    host.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe",
          "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win32\\EpicGamesLauncher.exe",
          "C:\\Program Files\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe",
        ]
      : host.platform === "darwin"
        ? ["/Applications/Epic Games Launcher.app"]
        : [];
  const path = await firstExisting(candidates);
  return path ? { target: "epic-launcher", version: "installed", path, source: "detected" } : null;
}

async function robloxInstalls(host: DetectionHost): Promise<GameEngineInstall[]> {
  const installs: GameEngineInstall[] = [];
  for (const root of robloxStudioRoots(host.platform, host.paths)) {
    if (host.platform === "darwin") {
      if (!(await exists(root))) continue;
      const plist = (await readText(`${root}/Contents/Info.plist`)) ?? "";
      const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? "installed";
      installs.push({ target: "roblox", version, path: `${root}/Contents/MacOS/RobloxStudio`, source: "detected" });
      continue;
    }
    for (const entry of await listDir(root)) {
      if (!entry.isDirectory() || !entry.name.startsWith("version-")) continue;
      const executable = pathJoin(host.platform, root, entry.name, "RobloxStudioBeta.exe");
      if (await exists(executable)) installs.push({ target: "roblox", version: entry.name, path: executable, source: "detected" });
    }
  }
  return installs;
}

const blenderVersionCache = new Map<string, string>();

export async function blenderVersion(path: string): Promise<string | null> {
  const cached = blenderVersionCache.get(path);
  if (cached) return cached;
  const result = await run(path, ["--version"], { timeoutMs: 20_000 });
  const version = parseBlenderVersionOutput(result.stdout);
  if (version) blenderVersionCache.set(path, version);
  return version;
}

async function blenderInstall(host: DetectionHost): Promise<GameEngineInstall | null> {
  const managedRoot = pathJoin(host.platform, host.toolsDir, "blender");
  for (const entry of await listDir(managedRoot)) {
    if (!entry.isDirectory()) continue;
    const executable = pathJoin(host.platform, managedRoot, entry.name, host.platform === "win32" ? "blender.exe" : "blender");
    if (await exists(executable)) {
      return { target: "blender", version: (await blenderVersion(executable)) ?? entry.name, path: executable, source: "managed" };
    }
  }
  const candidates = [...blenderExecutableCandidates(host.platform, host.paths)];
  if (host.platform === "win32") {
    const foundation = candidates[0]!;
    candidates.length = 0;
    for (const entry of (await listDir(foundation)).filter((item) => item.isDirectory()).reverse()) {
      candidates.push(pathJoin(host.platform, foundation, entry.name, "blender.exe"));
    }
  }
  const path = (await firstExisting(candidates)) ?? (await onPath(host, host.platform === "win32" ? ["blender.exe"] : ["blender"]));
  if (!path) return null;
  return { target: "blender", version: (await blenderVersion(path)) ?? "installed", path, source: "detected" };
}

export interface DetectedInstalls {
  readonly unity: ReadonlyArray<GameEngineInstall>;
  readonly unityHub: GameEngineInstall | null;
  readonly unreal: ReadonlyArray<GameEngineInstall>;
  readonly epicLauncher: GameEngineInstall | null;
  readonly roblox: ReadonlyArray<GameEngineInstall>;
  readonly blender: GameEngineInstall | null;
}

const byVersionDesc = (left: GameEngineInstall, right: GameEngineInstall) => compareEngineVersions(right.version, left.version);

export async function detectInstalls(host: DetectionHost, located: ReadonlyArray<LocatedInstall>): Promise<DetectedInstalls> {
  const [unity, hub, unreal, launcher, roblox, blender] = await Promise.all([
    unityInstalls(host),
    unityHub(host),
    unrealInstalls(host),
    epicLauncher(host),
    robloxInstalls(host),
    blenderInstall(host),
  ]);
  const extra = (target: GameInstallTarget) =>
    located
      .filter((entry) => entry.target === target)
      .map((entry): GameEngineInstall => ({ target, version: entry.version, path: entry.path, source: "located" }));
  const merge = (detected: ReadonlyArray<GameEngineInstall>, target: GameInstallTarget) => {
    const all = [...detected, ...extra(target)];
    return all.filter((install, index) => all.findIndex((other) => other.path === install.path) === index).sort(byVersionDesc);
  };
  return {
    unity: merge(unity, "unity"),
    unityHub: extra("unity-hub")[0] ?? hub,
    unreal: merge(unreal, "unreal"),
    epicLauncher: extra("epic-launcher")[0] ?? launcher,
    roblox: merge(roblox, "roblox"),
    blender: extra("blender")[0] ?? blender,
  };
}

/** Checks a path the user picked and works out its version. */
export async function inspectLocated(host: DetectionHost, target: GameInstallTarget, path: string): Promise<LocatedInstall | null> {
  if (!(await exists(path))) return null;
  switch (target) {
    case "unreal": {
      const root = path.replace(/[\\/]Engine[\\/]Binaries[\\/].*$/, "");
      const install = await unrealRoot(host, root);
      return install ? { target, path: install.path, version: install.version } : null;
    }
    case "unity": {
      const version = /(\d+\.\d+\.\d+[abfp]\d+)/.exec(path)?.[1] ?? "unknown";
      return { target, path, version };
    }
    case "blender":
      return { target, path, version: (await blenderVersion(path)) ?? "unknown" };
    default:
      return { target, path, version: "installed" };
  }
}

/** Engine projects at `root` or one level below it. */
export async function detectProjects(root: string): Promise<GameProject[]> {
  const projects: GameProject[] = [];
  const visit = async (dir: string, depth: number) => {
    const entries = await listDir(dir);
    for (const found of engineForProjectFiles(entries.map((entry) => entry.name))) {
      projects.push(await describeProject(found.engine, dir, found.projectFile));
    }
    if (depth === 0) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !["node_modules", "Library", "Intermediate", "Saved"].includes(entry.name)) {
        await visit(NodePath.join(dir, entry.name), depth - 1);
      }
    }
  };
  await visit(root, 1);
  return projects.sort((left, right) => left.root.localeCompare(right.root) || left.engine.localeCompare(right.engine));
}

async function describeProject(engine: GameEngineId, root: string, projectFile: string): Promise<GameProject> {
  let pinnedVersion: string | null = null;
  let pinnedRevision: string | null = null;
  let name = NodePath.basename(root);
  if (engine === "unity") {
    const parsed = parseUnityProjectVersion((await readText(NodePath.join(root, "ProjectSettings", "ProjectVersion.txt"))) ?? "");
    pinnedVersion = parsed?.version ?? null;
    pinnedRevision = parsed?.revision ?? null;
  } else if (engine === "unreal") {
    pinnedVersion = parseUProject((await readText(NodePath.join(root, projectFile))) ?? "")?.engineAssociation ?? null;
    name = projectFile.replace(/\.uproject$/i, "");
  }
  const bridgePath = BRIDGE_PROJECT_PATHS[engine];
  return {
    engine,
    root,
    name,
    projectFile,
    pinnedVersion,
    pinnedRevision,
    bridgeInstalled: bridgePath === null ? await exists(NodePath.join(root, ".continuum", "bridge.json")) : await exists(NodePath.join(root, bridgePath)),
  };
}
