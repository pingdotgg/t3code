// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off extendsNativeError:off - Plain-TypeScript game bridge core (sockets, files, vendor HTTP), unit-tested without an Effect runtime; GameDevService wraps it.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_GAME_DEV_SETTINGS,
  type GameAsset,
  type GameAssetBrief,
  type GameAssetCheck,
  type GameAssetKind,
  type GameBridgeSession,
  type GameDevCapture,
  type GameDevCommandResult,
  type GameDevInstallInput,
  type GameDevOpenProjectInput,
  type GameDevOpenProjectResult,
  type GameDevOverview,
  type GameDevSettings,
  type GameDevSettingsPatch,
  type GameDevWorkspace,
  type GameEngineId,
  type GameEngineInstall,
  type GameEngineStatus,
  type GameInstallEvent,
  type GameInstallTarget,
  type GameInstallerPlan,
  type GameProject,
} from "@t3tools/contracts";
import {
  BLENDER_RELEASES,
  BRIDGE_PLUGIN_VERSION,
  GAME_ENGINES,
  UNITY_RELEASES_API,
  blenderAssetName,
  engineAvailability,
  findSha256,
  installerPlan,
  operationNeedsApproval,
  parseBlenderFolderVersion,
  parseBlenderReleaseIndex,
  parseOsRelease,
  parseUnityLtsRelease,
  platformLabel,
  robloxPluginsDir,
  sameEngineLine,
  unrealBuildScript,
  versionRelation,
  type HostPaths,
  type LinuxDistro,
} from "@t3tools/shared/gameDevCatalog";

import { GAME_BRIDGE_FILES } from "./bridgeAssets.generated.ts";
import {
  FORGEGUI_PAID_TOOLS,
  FORGEGUI_PUBLISH_TOOLS,
  ForgeGuiClient,
  previewUrlOf,
  publicationStatus,
  reportedCredits,
} from "./forgeGuiClient.ts";
import {
  addRevision,
  assetDir,
  ensureAsset,
  getAsset,
  importChecks,
  listAssets,
  recordImport,
  recordPublication,
  revisionOf,
  runBlender,
  workBlend,
} from "./gameAssets.ts";
import { listenBridge, type BridgeListener } from "./gameBridgeHttp.ts";
import { GameBridgeRegistry, sameOrInside } from "./gameBridgeRegistry.ts";
import { createCheckpoint, diffCheckpoint, listCheckpoints, readRobloxSnapshot, restoreCheckpoint } from "./gameCheckpoints.ts";
import { detectInstalls, detectProjects, inspectLocated, type DetectedInstalls, type LocatedInstall } from "./gameEngineDetection.ts";
import { downloadResumable, exists, launchDetached, listDir, openWithSystem, readText, run, writeJsonAtomic } from "./gameDevFiles.ts";

export class GameDevFailure extends Error {}
const fail = (message: string): never => {
  throw new GameDevFailure(message);
};

interface PersistedState {
  readonly settings: GameDevSettings;
  readonly bridgeToken: string;
  readonly located: ReadonlyArray<LocatedInstall>;
  /** Roblox `placeId:name` → project root, so a place reconnects to its project. */
  readonly placeBindings: Readonly<Record<string, string>>;
}

export interface GameDevHost {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly platform: string;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getSecret: (name: string) => Promise<string | null>;
  readonly setSecret: (name: string, value: string | null) => Promise<void>;
  readonly now: () => Date;
}

const FORGEGUI_SECRET = "game-dev-forgegui-api-key";
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 90_000;
const LONG_OPERATIONS: Readonly<Record<string, number>> = {
  "tests.run": 15 * 60_000,
  "build.compile": 30 * 60_000,
  "asset.import": 5 * 60_000,
  "viewport.capture": 60_000,
  "snapshot.capture": 120_000,
};

export class GameDevCore {
  readonly registry: GameBridgeRegistry;
  #state: PersistedState;
  #listener: BridgeListener | null = null;
  #listenError: string | null = null;
  #detected: { readonly at: number; readonly value: DetectedInstalls } | null = null;
  #distro: LinuxDistro | null = null;
  #sweep: ReturnType<typeof setInterval> | null = null;
  #installs = new Set<GameInstallTarget>();

  private readonly host: GameDevHost;

  private constructor(host: GameDevHost, state: PersistedState) {
    this.host = host;
    this.#state = state;
    this.registry = new GameBridgeRegistry(() => this.#state.bridgeToken, {
      resolvePlace: (placeKey) => this.#state.placeBindings[placeKey] ?? null,
    });
  }

  static async start(host: GameDevHost): Promise<GameDevCore> {
    const statePath = NodePath.join(host.stateDir, "game-dev.json");
    const stored = JSON.parse((await readText(statePath)) ?? "{}") as Partial<PersistedState>;
    const state: PersistedState = {
      settings: { ...DEFAULT_GAME_DEV_SETTINGS, ...stored.settings },
      bridgeToken: typeof stored.bridgeToken === "string" && stored.bridgeToken.length >= 32 ? stored.bridgeToken : NodeCrypto.randomBytes(24).toString("hex"),
      located: Array.isArray(stored.located) ? stored.located : [],
      placeBindings: stored.placeBindings ?? {},
    };
    const core = new GameDevCore(host, state);
    await core.#save();
    if (host.platform === "linux") core.#distro = parseOsRelease((await readText("/etc/os-release")) ?? "");
    await core.#listen();
    core.#sweep = setInterval(() => core.registry.sweep(), 10_000);
    core.#sweep.unref?.();
    return core;
  }

  async stop() {
    if (this.#sweep) clearInterval(this.#sweep);
    await this.#listener?.close();
  }

  async #save() {
    await writeJsonAtomic(NodePath.join(this.host.stateDir, "game-dev.json"), this.#state);
  }

  async #listen() {
    await this.#listener?.close();
    this.#listener = null;
    try {
      this.#listener = await listenBridge(this.registry, this.#state.settings.bridgePort);
      this.#listenError = null;
    } catch (error) {
      this.#listenError = `Port ${this.#state.settings.bridgePort} is in use (${error instanceof Error ? error.message : String(error)}). Choose another bridge port.`;
    }
  }

  get bridgeUrl() {
    return `http://127.0.0.1:${this.#listener?.port ?? this.#state.settings.bridgePort}`;
  }

  get settings(): GameDevSettings {
    return this.#state.settings;
  }

  #paths(): HostPaths {
    const env = this.host.env;
    return {
      home: NodeOS.homedir(),
      localAppData: env.LOCALAPPDATA,
      appData: env.APPDATA,
      programFiles: env.ProgramFiles ?? env.PROGRAMFILES,
      programData: env.ProgramData ?? env.PROGRAMDATA,
    };
  }

  async #installs_(force = false): Promise<DetectedInstalls> {
    if (!force && this.#detected && Date.now() - this.#detected.at < 15_000) return this.#detected.value;
    const value = await detectInstalls(
      {
        platform: this.host.platform,
        paths: this.#paths(),
        toolsDir: NodePath.join(this.host.baseDir, "tools"),
        pathDirs: (this.host.env.PATH ?? this.host.env.Path ?? "").split(this.host.platform === "win32" ? ";" : ":").filter(Boolean),
      },
      this.#state.located,
    );
    this.#detected = { at: Date.now(), value };
    return value;
  }

  #plan(target: GameInstallTarget, version: string | null = null, sha256: string | null = null): GameInstallerPlan {
    return installerPlan(target, { platform: this.host.platform, arch: this.host.arch, distro: this.#distro, version, sha256 });
  }

  #hostLabel() {
    return this.host.platform === "linux" ? (this.#distro?.prettyName ?? "Linux") : `${platformLabel(this.host.platform)} (${this.host.arch})`;
  }

  async overview(): Promise<GameDevOverview> {
    const installs = await this.#installs_();
    const sessions = this.registry.sessions();
    const engine = (id: GameEngineId): GameEngineStatus => {
      const spec = GAME_ENGINES[id];
      const availability = engineAvailability(id, this.host.platform, this.host.arch);
      const list = id === "unity" ? installs.unity : id === "unreal" ? installs.unreal : installs.roblox;
      const launcher = id === "unity" ? installs.unityHub : id === "unreal" ? installs.epicLauncher : null;
      return {
        engine: id,
        displayName: spec.displayName,
        availability: availability.availability,
        availabilityReason: availability.reason,
        installs: list,
        launcher,
        recommendedVersion: id === "roblox" ? "Latest (Studio updates itself)" : (list[0]?.version ?? null),
        recommendedVersionSource:
          id === "unity"
            ? "The project's pinned version; otherwise the newest LTS from Unity's release API when you install"
            : id === "unreal"
              ? "The project's EngineAssociation; otherwise the newest 5.x in the Epic Games Launcher"
              : "Roblox ships one current Studio",
        installer: this.#plan(id === "unity" ? "unity" : id),
        launcherInstaller: id === "unity" ? this.#plan("unity-hub") : id === "unreal" ? this.#plan("epic-launcher") : null,
        controls: [...spec.controls],
        surface: availability.availability === "local" ? "managed-window" : "remote-machine",
        sessions: sessions.filter((session) => session.engine === id),
      };
    };
    const forgeKey = await this.host.getSecret(FORGEGUI_SECRET);
    return {
      host: { platform: this.host.platform, arch: this.host.arch, label: this.#hostLabel() },
      bridge: { port: this.#listener?.port ?? this.#state.settings.bridgePort, listening: this.#listener !== null, error: this.#listenError },
      engines: [engine("roblox"), engine("unity"), engine("unreal")],
      tools: [
        {
          tool: "blender",
          displayName: "Blender",
          installed: installs.blender,
          installer: installs.blender ? null : this.#plan("blender"),
          configured: installs.blender !== null,
          detail: installs.blender
            ? `Blender ${installs.blender.version} runs in the background for agents: scenes, meshes, materials, previews, and exports for Roblox, Unity, Unreal, or glTF.`
            : "Install Blender to let agents build and edit 3D assets for any project, with or without an engine.",
        },
        {
          tool: "forgegui",
          displayName: "ForgeGUI",
          installed: null,
          installer: null,
          configured: forgeKey !== null,
          detail: forgeKey
            ? "Agents can search ForgeGUI's library and, with your approval, generate artwork (uses ForgeGUI credits) and upload it to Roblox."
            : "Add a ForgeGUI API key (forgegui.com → Profile → MCP API keys) to let agents generate HUDs, panels, icons, and backgrounds for Roblox.",
        },
      ],
      approvals: this.registry.approvals(),
      settings: this.#state.settings,
    };
  }

  async updateSettings(patch: GameDevSettingsPatch): Promise<GameDevOverview> {
    const portChanged = patch.bridgePort !== undefined && patch.bridgePort !== this.#state.settings.bridgePort;
    this.#state = { ...this.#state, settings: { ...this.#state.settings, ...patch } };
    await this.#save();
    if (portChanged) await this.#listen();
    return this.overview();
  }

  async locate(target: GameInstallTarget, path: string): Promise<GameDevOverview> {
    const located = await inspectLocated({ platform: this.host.platform, paths: this.#paths(), toolsDir: NodePath.join(this.host.baseDir, "tools"), pathDirs: [] }, target, path);
    if (located === null) fail(`Nothing usable at ${path}. Pick the editor program, such as UnrealEditor or Unity.exe.`);
    this.#state = { ...this.#state, located: [...this.#state.located.filter((entry) => entry.path !== located!.path), located!] };
    await this.#save();
    await this.#installs_(true);
    return this.overview();
  }

  // Installs ----------------------------------------------------------------------------------

  async #resolvedPlan(input: GameDevInstallInput): Promise<GameInstallerPlan> {
    if (input.target === "blender") {
      const index = await (await fetch(`${BLENDER_RELEASES}/`)).text();
      const series = parseBlenderReleaseIndex(index) ?? fail("Could not read Blender's release list.");
      const folder = await (await fetch(`${BLENDER_RELEASES}/Blender${series}/`)).text();
      const version = parseBlenderFolderVersion(folder) ?? fail(`No Blender ${series} build is listed yet.`);
      const file = blenderAssetName(version, this.host.platform, this.host.arch);
      const sums = await (await fetch(`${BLENDER_RELEASES}/Blender${series}/blender-${version}.sha256`)).text();
      return this.#plan("blender", version, file ? findSha256(sums, file) : null);
    }
    if (input.target === "unity") {
      if (input.version) return this.#plan("unity", input.version, input.revision ?? null);
      const latest = parseUnityLtsRelease(await (await fetch(UNITY_RELEASES_API)).json());
      return this.#plan("unity", latest?.version ?? null, latest?.revision ?? null);
    }
    return this.#plan(input.target);
  }

  async install(input: GameDevInstallInput, report: (event: GameInstallEvent) => void): Promise<void> {
    if (this.#installs.has(input.target)) fail("That install is already running.");
    this.#installs.add(input.target);
    try {
      const plan = await this.#resolvedPlan(input);
      report({ type: "plan", plan });
      const downloads = NodePath.join(this.host.baseDir, "downloads");
      const fetchInstaller = async () => {
        if (plan.url === null || plan.fileName === null) fail("This installer has no download.");
        const result = await downloadResumable({
          url: plan.url!,
          destination: NodePath.join(downloads, plan.fileName!),
          sha256: plan.sha256,
          onProgress: (progress) => report({ type: "progress", stage: "downloading", completedBytes: progress.completed, totalBytes: progress.total, resumed: progress.resumed }),
        });
        return result.path;
      };
      switch (plan.kind) {
        case "unavailable":
          return fail(plan.note ?? `${plan.title} is not available on ${this.#hostLabel()}.`);
        case "download-and-run":
        case "download-and-open": {
          const file = await fetchInstaller();
          report({ type: "progress", stage: "starting", completedBytes: null, totalBytes: null, resumed: false });
          await openWithSystem(file, this.host.platform);
          report({ type: "handoff", message: `${plan.title} is open. ${plan.steps.join(" ")} Then choose Refresh.`, url: null });
          break;
        }
        case "download-and-extract": {
          const file = await fetchInstaller();
          report({ type: "progress", stage: "extracting", completedBytes: null, totalBytes: null, resumed: false });
          const target = NodePath.join(this.host.baseDir, "tools", "blender", plan.version ?? "current");
          await NodeFSP.rm(target, { recursive: true, force: true });
          await NodeFSP.mkdir(target, { recursive: true });
          const args = file.endsWith(".zip") ? ["-xf", file, "-C", target, "--strip-components=1"] : ["-xJf", file, "-C", target, "--strip-components=1"];
          const result = await run("tar", args, { timeoutMs: 10 * 60_000 });
          if (result.code !== 0) fail(`Could not unpack ${plan.fileName}: ${result.stderr.slice(-400)}`);
          await this.#installs_(true);
          report({ type: "complete", message: `${plan.title} is ready in Continuum's tools folder.` });
          break;
        }
        case "package-manager":
          report({ type: "handoff", message: `Run these commands in a terminal (they need sudo), then choose Refresh:\n${plan.commands.join("\n")}`, url: null });
          break;
        case "vendor-launcher": {
          const installs = await this.#installs_(true);
          if (input.target === "unity" && installs.unityHub && plan.version) {
            report({ type: "progress", stage: "downloading", completedBytes: null, totalBytes: null, resumed: false });
            const args = ["--", "--headless", "install", "--version", plan.version, ...(input.revision || plan.url ? ["--changeset", input.revision ?? plan.url!.split("/").at(-1)!] : [])];
            const result = await run(installs.unityHub.path, args, { timeoutMs: 3 * 60 * 60_000 });
            if (result.code !== 0) {
              // Hub refuses headless installs until someone signs in; its own window can.
              if (plan.url) await openWithSystem(plan.url, this.host.platform);
              report({ type: "handoff", message: `Unity Hub could not install ${plan.version} headlessly (${(result.stderr || result.stdout).trim().split("\n").at(-1) ?? "no output"}). Hub is open on the install page; sign in there if asked.`, url: plan.url });
              break;
            }
            await this.#installs_(true);
            report({ type: "complete", message: `Unity ${plan.version} is installed.` });
            break;
          }
          if (plan.url) await openWithSystem(plan.url, this.host.platform).catch(() => 0);
          report({ type: "handoff", message: `${plan.steps.join(" ")} Choose Refresh when it is installed.`, url: plan.url });
          break;
        }
        case "browser-handoff":
          if (plan.url) await openWithSystem(plan.url, this.host.platform).catch(() => 0);
          report({ type: "handoff", message: `${plan.steps.join(" ") || "Download it from the vendor's site."} Then choose Locate or Refresh.`, url: plan.url });
          break;
      }
    } finally {
      this.#installs.delete(input.target);
    }
  }

  // Projects ------------------------------------------------------------------------------------

  detectProjects(root: string): Promise<GameProject[]> {
    return detectProjects(root);
  }

  async #writeBridgeConfig(projectRoot: string) {
    const dir = NodePath.join(projectRoot, ".continuum");
    await NodeFSP.mkdir(dir, { recursive: true });
    await writeJsonAtomic(NodePath.join(dir, "bridge.json"), { url: this.bridgeUrl, token: this.#state.bridgeToken, pluginVersion: BRIDGE_PLUGIN_VERSION });
    const ignore = NodePath.join(dir, ".gitignore");
    if (!(await exists(ignore))) await NodeFSP.writeFile(ignore, "bridge.json\nassets/*/work*\n");
  }

  /** Writes the bridge plugin where the editor loads it and returns the paths written. */
  async installBridge(engine: GameEngineId, projectRoot: string): Promise<string[]> {
    await this.#writeBridgeConfig(projectRoot);
    const written: string[] = [NodePath.join(projectRoot, ".continuum", "bridge.json")];
    const writeAll = async (base: string, files: ReadonlyArray<{ readonly path: string; readonly contents: string }>, transform = (text: string) => text) => {
      for (const file of files) {
        const target = NodePath.join(base, ...file.path.split("/"));
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.writeFile(target, transform(file.contents));
      }
      written.push(base);
    };
    if (engine === "unity") await writeAll(NodePath.join(projectRoot, "Packages", "com.continuum.bridge"), GAME_BRIDGE_FILES.unity);
    else if (engine === "unreal") await writeAll(NodePath.join(projectRoot, "Plugins", "ContinuumBridge"), GAME_BRIDGE_FILES.unreal);
    else {
      const dir = robloxPluginsDir(this.host.platform, this.#paths()) ?? fail("Roblox Studio plugins are only available on Windows and macOS.");
      await writeAll(dir, GAME_BRIDGE_FILES.roblox, (text) =>
        text
          .replace(/url = "[^"]*", --\[\[CONTINUUM_URL\]\]/, `url = ${JSON.stringify(this.bridgeUrl)}, --[[CONTINUUM_URL]]`)
          .replace(/token = "[^"]*", --\[\[CONTINUUM_TOKEN\]\]/, `token = ${JSON.stringify(this.#state.bridgeToken)}, --[[CONTINUUM_TOKEN]]`),
      );
    }
    return written;
  }

  async openProject(input: GameDevOpenProjectInput): Promise<GameDevOpenProjectResult> {
    const project = (await detectProjects(input.projectRoot)).find((entry) => entry.engine === input.engine && sameOrInside(entry.root, input.projectRoot));
    if (!project) fail(`No ${GAME_ENGINES[input.engine].displayName} project at ${input.projectRoot}.`);
    const installs = await this.#installs_(true);
    const list = input.engine === "unity" ? installs.unity : input.engine === "unreal" ? installs.unreal : installs.roblox;
    const chosen: GameEngineInstall | undefined = input.editorPath
      ? list.find((install) => install.path === input.editorPath)
      : (project!.pinnedVersion ? list.find((install) => sameEngineLine(input.engine, install.version, project!.pinnedVersion!)) : undefined) ?? list[0];
    if (!chosen) {
      fail(`${GAME_ENGINES[input.engine].displayName}${project!.pinnedVersion ? ` ${project!.pinnedVersion}` : ""} is not installed here. Install it or choose Locate in Settings → Game Development.`);
    }
    const relation = input.engine === "roblox" ? "same" : versionRelation(input.engine, chosen!.version, project!.pinnedVersion);
    if (relation === "downgrade") {
      fail(`${project!.name} uses ${project!.pinnedVersion}; ${chosen!.version} is older and cannot open it safely. Install ${project!.pinnedVersion}.`);
    }
    if (relation === "upgrade" && input.confirmUpgrade !== true) {
      return {
        launched: false,
        editorVersion: chosen!.version,
        bridgeInstalledAt: [],
        upgradeRequired: {
          from: project!.pinnedVersion!,
          to: chosen!.version,
          message: `Opening ${project!.name} with ${chosen!.version} upgrades it from ${project!.pinnedVersion}. The editor rewrites project files and older editors may not open it again. Make a checkpoint or commit first.`,
        },
        message: "Confirm the upgrade to continue.",
      };
    }
    const bridgeInstalledAt = await this.installBridge(input.engine, project!.root);
    if (input.engine === "unity") await launchDetached(chosen!.path, ["-projectPath", project!.root]);
    else if (input.engine === "unreal") await launchDetached(chosen!.path, [NodePath.join(project!.root, project!.projectFile!)]);
    else {
      const place = project!.projectFile && /\.rbxlx?$/i.test(project!.projectFile) ? NodePath.join(project!.root, project!.projectFile) : null;
      if (this.host.platform === "darwin") await launchDetached("open", ["-a", chosen!.path.replace(/\/Contents\/MacOS\/.*$/, ""), ...(place ? [place] : [])]);
      else await launchDetached(chosen!.path, place ? [place] : []);
    }
    return {
      launched: true,
      editorVersion: chosen!.version,
      bridgeInstalledAt,
      upgradeRequired: null,
      message:
        input.engine === "roblox"
          ? "Studio is starting. When it asks whether the Continuum Bridge plugin may reach localhost, choose Allow; then bind the place to this project if asked."
          : `${GAME_ENGINES[input.engine].displayName} is starting with the Continuum bridge. It connects when the editor finishes loading.`,
    };
  }

  async bind(sessionId: string, projectRoot: string): Promise<GameDevWorkspace> {
    const session = this.registry.bind(sessionId, projectRoot) ?? fail("That editor session is gone.");
    const placeKey = this.registry.placeKey(session.sessionId);
    if (placeKey) {
      this.#state = { ...this.#state, placeBindings: { ...this.#state.placeBindings, [placeKey]: projectRoot } };
      await this.#save();
    }
    return this.workspace(projectRoot);
  }

  async workspace(projectRoot: string): Promise<GameDevWorkspace> {
    const state = this.registry.projectState(projectRoot);
    return {
      projectRoot,
      projects: await detectProjects(projectRoot),
      session: state?.session ?? null,
      unboundSessions: this.registry.sessions().filter((session) => session.projectRoot === null && session.state !== "disconnected"),
      timeline: state?.timeline ?? [],
      compileMessages: state?.compile ?? [],
      latestCaptureId: state?.latestCaptureId ?? null,
      checkpoints: await listCheckpoints(this.host.baseDir, projectRoot),
      approvals: this.registry.approvals(projectRoot),
      playtestCount: state?.playtests ?? 0,
    };
  }

  // Commands -----------------------------------------------------------------------------------

  #requireSession(projectRoot: string): GameBridgeSession {
    const session = this.registry.sessionForProject(projectRoot);
    if (!session || session.state === "disconnected") {
      fail(`No editor is connected for ${projectRoot}. Open the project from the Game Development panel (or Settings → Game Development) and wait for the bridge to connect.`);
    }
    return session!;
  }

  async command(input: {
    readonly sessionId: string | null;
    readonly projectRoot: string | null;
    readonly operation: string;
    readonly args: Record<string, unknown>;
    readonly actor: "agent" | "user";
    readonly threadId: string | null;
    readonly summary?: string;
  }): Promise<GameDevCommandResult> {
    const session =
      input.sessionId !== null
        ? (this.registry.session(input.sessionId) ?? fail("That editor session is gone."))
        : this.#requireSession(input.projectRoot ?? fail("No project."));
    if (input.projectRoot !== null && (session.projectRoot === null || !sameOrInside(session.projectRoot, input.projectRoot))) {
      fail("That editor belongs to a different project than this thread.");
    }
    if (input.operation === "viewport.focus" && input.actor === "agent" && !this.#state.settings.allowCameraControl) {
      fail("Camera control is off in Settings → Game Development.");
    }
    const summary = input.summary ?? `${input.operation} ${summarizeArgs(input.args)}`.trim();
    if (input.actor === "agent" && operationNeedsApproval(input.operation)) {
      const approved = await this.registry.requestApproval(
        { sessionId: session.sessionId, projectRoot: session.projectRoot, operation: input.operation, summary, threadId: input.threadId },
        APPROVAL_TIMEOUT_MS,
      );
      if (!approved) fail(`The user did not approve ${input.operation} (${summary}). Do not retry without asking them.`);
    }
    // Operations the server performs itself, because the editor plugin cannot.
    if (session.engine === "unreal" && input.operation === "build.compile") return this.#buildUnreal(session);
    if (session.engine === "roblox" && input.operation === "viewport.capture") return this.#captureWindow(session);
    const outcome = await this.registry.call(session.sessionId, input.operation, input.args, {
      timeoutMs: LONG_OPERATIONS[input.operation] ?? DEFAULT_CALL_TIMEOUT_MS,
      actor: input.actor,
      summary,
    });
    return { ok: outcome.ok, value: outcome.value, error: outcome.error, captureId: outcome.captureId };
  }

  operationsFor(session: GameBridgeSession): string[] {
    const extra: string[] = [];
    if (session.engine === "unreal" && !session.operations.includes("build.compile")) extra.push("build.compile");
    if (session.engine === "roblox" && (this.host.platform === "win32" || this.host.platform === "darwin")) extra.push("viewport.capture");
    return [...session.operations, ...extra];
  }

  async #buildUnreal(session: GameBridgeSession): Promise<GameDevCommandResult> {
    const project = (await detectProjects(session.projectRoot!)).find((entry) => entry.engine === "unreal");
    if (!project) fail("The connected Unreal project was not found on disk.");
    const installs = await this.#installs_();
    const install = installs.unreal.find((entry) => project!.pinnedVersion && sameEngineLine("unreal", entry.version, project!.pinnedVersion)) ?? installs.unreal[0] ?? fail("No Unreal Engine install found to build with.");
    const engineRoot = install.path.replace(/[\\/]Engine[\\/]Binaries[\\/].*$/, "");
    const platform = this.host.platform === "win32" ? "Win64" : this.host.platform === "darwin" ? "Mac" : "Linux";
    const uproject = NodePath.join(project!.root, project!.projectFile!);
    const result = await run(unrealBuildScript(this.host.platform, engineRoot), [`${project!.name}Editor`, platform, "Development", `-Project=${uproject}`, "-WaitMutex", "-NoHotReloadFromIDE"], { timeoutMs: 30 * 60_000, cwd: engineRoot });
    const messages = parseCompilerOutput(`${result.stdout}\n${result.stderr}`);
    this.registry.events(session.sessionId, [{ type: "compile", messages }]);
    const errors = messages.filter((message) => message.severity === "error");
    return {
      ok: result.code === 0,
      value: { exitCode: result.code, errors: errors.length, warnings: messages.length - errors.length, messages: messages.slice(0, 50), tail: result.stdout.split("\n").slice(-15).join("\n") },
      error: result.code === 0 ? null : `UnrealBuildTool failed with ${errors.length} error${errors.length === 1 ? "" : "s"}${errors[0] ? `: ${errors[0].message}` : ""}. If the editor has Live Coding on, close it or use Live Coding.`,
      captureId: null,
    };
  }

  /** Roblox plugins cannot read pixels, so Continuum captures Studio's window on this computer. */
  async #captureWindow(session: GameBridgeSession): Promise<GameDevCommandResult> {
    const output = NodePath.join(this.host.baseDir, "game-captures", `window-${Date.now()}.png`);
    await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
    let result;
    if (this.host.platform === "win32") {
      const script = `Add-Type -AssemblyName System.Drawing; Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); public struct R { public int L, T, Rt, B; } }
"@; $p = Get-Process RobloxStudioBeta -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; $r = New-Object W+R; [W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 300; [W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null; $b = New-Object System.Drawing.Bitmap ($r.Rt - $r.L), ($r.B - $r.T); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size); $b.Save('${output.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
      result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 30_000 });
    } else if (this.host.platform === "darwin") {
      const bounds = await run("osascript", ["-e", 'tell application "System Events" to tell (first process whose name contains "RobloxStudio") to get {position, size} of front window'], { timeoutMs: 15_000 });
      const numbers = bounds.stdout.match(/-?\d+/g)?.map(Number) ?? [];
      if (numbers.length < 4) fail("Could not find Studio's window. Allow Continuum in System Settings → Privacy & Security → Accessibility.");
      result = await run("screencapture", ["-x", `-R${numbers[0]},${numbers[1]},${numbers[2]},${numbers[3]}`, output], { timeoutMs: 15_000 });
    } else {
      fail("Window capture of Roblox Studio needs Windows or macOS.");
    }
    if (result!.code !== 0 || !(await exists(output))) {
      fail(`Window capture failed: ${(result!.stderr || result!.stdout).trim().slice(-300) || "no output"}. On macOS allow Screen Recording for Continuum.`);
    }
    const data = await NodeFSP.readFile(output);
    await NodeFSP.rm(output, { force: true });
    const captureId = this.registry.storeCapture({ mimeType: "image/png", dataBase64: data.toString("base64"), width: null, height: null, source: "window", projectRoot: session.projectRoot });
    if (session.projectRoot) this.registry.note(session.projectRoot, "capture", "Captured the Studio window.", captureId);
    return { ok: true, value: { source: "window", note: "Captured Studio's whole window, including panels." }, error: null, captureId };
  }

  capture(captureId: string): GameDevCapture {
    const capture = this.registry.capture(captureId) ?? fail("That capture is no longer kept.");
    return { captureId, mimeType: capture.mimeType, dataBase64: capture.dataBase64, width: capture.width, height: capture.height, at: capture.at, source: capture.source };
  }

  /** Saves a capture where the agent can open it as an image. */
  async captureToFile(captureId: string): Promise<string> {
    const capture = this.capture(captureId);
    const dir = NodePath.join(this.host.baseDir, "game-captures");
    await NodeFSP.mkdir(dir, { recursive: true });
    const path = NodePath.join(dir, `${captureId}.${capture.mimeType === "image/jpeg" ? "jpg" : "png"}`);
    await NodeFSP.writeFile(path, Buffer.from(capture.dataBase64, "base64"));
    const files = (await listDir(dir)).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - 200))) await NodeFSP.rm(NodePath.join(dir, stale), { force: true });
    return path;
  }

  resolveApproval(approvalId: string, approve: boolean) {
    return { resolved: this.registry.resolveApproval(approvalId, approve) };
  }

  // Checkpoints -------------------------------------------------------------------------------

  async checkpointCreate(input: { readonly projectRoot: string; readonly label: string; readonly paths?: ReadonlyArray<string>; readonly createdBy: "agent" | "user" }) {
    const project = (await detectProjects(input.projectRoot))[0] ?? fail(`No engine project at ${input.projectRoot}.`);
    let snapshot: unknown = null;
    const session = this.registry.sessionForProject(input.projectRoot);
    if (project.engine === "roblox" && session && session.state !== "disconnected" && session.operations.includes("snapshot.capture")) {
      const outcome = await this.registry.call(session.sessionId, "snapshot.capture", {}, { timeoutMs: 120_000, actor: input.createdBy, summary: "Snapshot for checkpoint" });
      if (outcome.ok) snapshot = outcome.value;
    }
    const checkpoint = await createCheckpoint({ baseDir: this.host.baseDir, projectRoot: project.root, engine: project.engine, label: input.label, paths: input.paths, createdBy: input.createdBy, robloxSnapshot: snapshot, now: this.host.now() });
    this.registry.note(project.root, "checkpoint", `Checkpoint "${checkpoint.label}": ${checkpoint.fileCount} files${checkpoint.instanceCount ? `, ${checkpoint.instanceCount} instances` : ""}.`);
    return checkpoint;
  }

  checkpointDiff(projectRoot: string, checkpointId: string) {
    return this.#checkpointCall(projectRoot, (root) => diffCheckpoint(this.host.baseDir, root, checkpointId));
  }

  async checkpointRestore(projectRoot: string, checkpointId: string, actor: "agent" | "user", threadId: string | null) {
    if (actor === "agent") {
      const approved = await this.registry.requestApproval({ sessionId: null, projectRoot, operation: "checkpoint.restore", summary: `Restore checkpoint ${checkpointId}`, threadId }, APPROVAL_TIMEOUT_MS);
      if (!approved) fail("The user did not approve restoring the checkpoint.");
    }
    return this.#checkpointCall(projectRoot, async (root) => {
      const result = await restoreCheckpoint(this.host.baseDir, root, checkpointId);
      const session = this.registry.sessionForProject(root);
      const snapshot = await readRobloxSnapshot(this.host.baseDir, root, checkpointId);
      if (session && session.state !== "disconnected" && snapshot !== null && session.operations.includes("snapshot.restore")) {
        await this.registry.call(session.sessionId, "snapshot.restore", snapshot as Record<string, unknown>, { timeoutMs: 120_000, actor, summary: "Restore checkpoint snapshot" });
      }
      this.registry.note(root, "checkpoint", `Restored "${result.checkpoint.label}" (${result.changes.length} files changed back).`);
      return result;
    });
  }

  async #checkpointCall<T>(projectRoot: string, run_: (root: string) => Promise<T>): Promise<T> {
    const roots = [projectRoot, ...(await detectProjects(projectRoot)).map((project) => project.root)];
    let lastError: unknown = null;
    for (const root of roots) {
      try {
        return await run_(root);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new GameDevFailure("Unknown checkpoint.");
  }

  // Assets ---------------------------------------------------------------------------------------

  listAssets(projectRoot: string): Promise<GameAsset[]> {
    return listAssets(projectRoot);
  }

  async assetPreview(projectRoot: string, assetId: string, revision: number): Promise<GameDevCapture> {
    const asset = (await getAsset(projectRoot, assetId)) ?? fail(`No asset ${assetId}.`);
    const entry = revisionOf(asset, revision);
    if (!entry.previewPath) fail("That revision has no preview.");
    const data = await NodeFSP.readFile(NodePath.join(projectRoot, entry.previewPath!));
    return { captureId: `${assetId}@${revision}`, mimeType: entry.previewPath!.endsWith(".jpg") ? "image/jpeg" : "image/png", dataBase64: data.toString("base64"), width: null, height: null, at: entry.createdAt, source: entry.tool === "forgegui" ? "forgegui" : "blender" };
  }

  async #blenderPath(): Promise<string> {
    const installs = await this.#installs_();
    return installs.blender?.path ?? fail("Blender is not installed. Install it from Settings → Game Development → Blender.");
  }

  async #blenderScript(): Promise<string> {
    const path = NodePath.join(this.host.baseDir, "tools", "continuum-blender", `continuum_blender-${BRIDGE_PLUGIN_VERSION}.py`);
    const contents = GAME_BRIDGE_FILES.blender.find((file) => file.path === "continuum_blender.py")!.contents;
    if ((await readText(path)) !== contents) {
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.writeFile(path, contents);
    }
    return path;
  }

  /** One Blender operation on an asset's working .blend. */
  async blender(input: { readonly projectRoot: string; readonly assetId: string; readonly name?: string; readonly kind?: GameAssetKind; readonly operation: string; readonly args: Record<string, unknown>; readonly fresh?: boolean }) {
    const asset = await ensureAsset(input.projectRoot, { assetId: input.assetId, name: input.name ?? input.assetId, kind: input.kind ?? "model" });
    const blend = workBlend(input.projectRoot, asset.assetId);
    const scratch = NodePath.join(assetDir(input.projectRoot, asset.assetId), "work-scratch");
    const args = { ...input.args };
    for (const key of ["output", "path"] as const) {
      if (typeof args[key] === "string" && !NodePath.isAbsolute(args[key] as string)) args[key] = NodePath.join(assetDir(input.projectRoot, asset.assetId), "work-out", args[key] as string);
    }
    const result = await runBlender({
      executable: await this.#blenderPath(),
      script: await this.#blenderScript(),
      blend: input.fresh ? null : blend,
      saveTo: blend,
      operation: input.operation,
      args,
      reset: input.fresh === true || !(await exists(blend)),
      scratchDir: scratch,
    });
    if (!result.ok) fail(`Blender ${input.operation} failed: ${result.error}`);
    let captureId: string | null = null;
    if (input.operation === "render_preview" && typeof args.output === "string") {
      const data = await NodeFSP.readFile(args.output);
      captureId = this.registry.storeCapture({ mimeType: "image/png", dataBase64: data.toString("base64"), width: null, height: null, source: "blender", projectRoot: input.projectRoot });
      this.registry.note(input.projectRoot, "capture", `Blender preview of ${asset.name}.`, captureId);
    }
    return { assetId: asset.assetId, blend, value: result.value, blenderVersion: result.blenderVersion, captureId, previewPath: captureId ? (args.output as string) : null };
  }

  /** Freezes the working .blend into a revision: source, export, preview, and checks against the brief. */
  async saveBlenderRevision(input: { readonly projectRoot: string; readonly assetId: string; readonly target: "unity" | "unreal" | "roblox" | "generic"; readonly format?: string; readonly note: string; readonly brief: GameAssetBrief | null; readonly createdBy: "agent" | "user" }) {
    const asset = (await getAsset(input.projectRoot, input.assetId)) ?? fail(`No asset ${input.assetId}. Create it with a Blender operation first.`);
    const blend = workBlend(input.projectRoot, asset.assetId);
    if (!(await exists(blend))) fail("The asset has no working .blend yet.");
    const out = NodePath.join(assetDir(input.projectRoot, asset.assetId), "work-out");
    const extension = input.format ?? (input.target === "generic" ? "glb" : "fbx");
    const exportPath = NodePath.join(out, `${asset.assetId}.${extension}`);
    const exported = await this.blender({ projectRoot: input.projectRoot, assetId: asset.assetId, operation: "export", args: { target: input.target, path: exportPath, format: extension } });
    const preview = await this.blender({ projectRoot: input.projectRoot, assetId: asset.assetId, operation: "render_preview", args: { output: NodePath.join(out, "preview.png"), width: 640, height: 640, samples: 24 } });
    const brief = input.brief ?? asset.revisions.at(-1)?.brief ?? null;
    const checked = await this.blender({ projectRoot: input.projectRoot, assetId: asset.assetId, operation: "check", args: { polygonBudget: brief?.polygonBudget ?? null, textureResolution: brief?.textureResolution ?? null, dimensions: brief?.dimensions ?? null } });
    const exportValue = exported.value as { triangles: number; materials: string[]; missingImages: string[]; blenderDimensions: { x: number; y: number; z: number; units: string } | null; expectedEngineDimensions: unknown };
    const checks = ((checked.value as { checks: GameAssetCheck[] }).checks ?? []).slice();
    const result = await addRevision(input.projectRoot, asset.assetId, {
      createdBy: input.createdBy,
      tool: "blender",
      note: input.note,
      files: [
        { role: "source", source: blend },
        { role: "export", source: exportPath },
      ],
      preview: preview.previewPath,
      stats: {
        triangles: exportValue.triangles,
        materials: exportValue.materials.length,
        missingTextures: exportValue.missingImages.length,
        textureMaxSize: null,
        dimensions: exportValue.blenderDimensions,
      },
      checks,
      brief,
      forgeGui: null,
      now: this.host.now(),
    });
    // The expected engine size travels with the export for the import check.
    await NodeFSP.writeFile(NodePath.join(input.projectRoot, result.revision.files.find((file) => file.role === "export")!.path + ".continuum.json"), JSON.stringify({ target: input.target, expectedEngineDimensions: exportValue.expectedEngineDimensions }));
    this.registry.note(input.projectRoot, "asset", `${asset.name} revision ${result.revision.revision} saved (${exportValue.triangles} triangles).`, preview.captureId);
    return result;
  }

  /** Imports a chosen revision into the connected editor and checks what the editor reports. */
  async assetImport(input: { readonly projectRoot: string; readonly assetId: string; readonly revision: number; readonly confirmReplace: boolean; readonly actor: "agent" | "user"; readonly threadId: string | null; readonly place?: Record<string, unknown> | null }) {
    const asset = (await getAsset(input.projectRoot, input.assetId)) ?? fail(`No asset ${input.assetId}.`);
    const revision = revisionOf(asset, input.revision);
    if (asset.activeRevision !== null && asset.activeRevision !== input.revision && !input.confirmReplace) {
      if (input.actor === "agent") {
        const approved = await this.registry.requestApproval(
          { sessionId: null, projectRoot: input.projectRoot, operation: "asset.replace", summary: `Replace ${asset.name} revision ${asset.activeRevision} with revision ${input.revision} (preview in the Assets view)`, threadId: input.threadId },
          APPROVAL_TIMEOUT_MS,
        );
        if (!approved) fail("The user kept the current revision.");
      } else {
        return { asset, import: null, replaceRequired: `Revision ${asset.activeRevision} is in the project. Review revision ${input.revision}'s preview, then confirm to replace it.` };
      }
    }
    const session = this.#requireSession(input.projectRoot);
    const exported = revision.files.find((file) => file.role === "export") ?? revision.files.find((file) => file.role === "texture" || file.role === "preview");
    const now = this.host.now().toISOString();
    if (session.engine === "roblox") {
      const publication = revision.publication;
      if (!publication?.robloxAssetId || publication.status !== "ready") {
        const entry = { revision: input.revision, engine: session.engine, at: now, location: "", status: publication ? ("awaiting-moderation" as const) : ("awaiting-approval" as const), checks: [] };
        const updated = await recordImport(input.projectRoot, asset.assetId, entry);
        return { asset: updated, import: entry, replaceRequired: publication ? null : "Roblox needs the asset uploaded first. Publish it through ForgeGUI (Continuum asks before uploading), then import." };
      }
      const outcome = await this.command({ sessionId: session.sessionId, projectRoot: input.projectRoot, operation: "asset.import", args: { assetId: publication.robloxAssetId, kind: asset.kind === "model" ? "mesh" : "image", name: asset.name, ...(input.place ?? {}) }, actor: input.actor, threadId: input.threadId });
      return this.#finishImport(input, asset, revision, session.engine, outcome, now);
    }
    if (!exported) fail("That revision has no file to import.");
    const source = NodePath.join(input.projectRoot, exported!.path);
    const sidecar = JSON.parse((await readText(`${source}.continuum.json`)) ?? "{}") as { expectedEngineDimensions?: { x: number; y: number; z: number; units: string } };
    const fileName = `${asset.assetId}${NodePath.extname(source)}`;
    const args =
      session.engine === "unity"
        ? { source, destination: `Assets/Continuum/${asset.name.replace(/[^A-Za-z0-9_-]/g, "")}/${fileName}`, kind: asset.kind, scaleFactor: 1, place: input.place === null ? undefined : { name: asset.name, ...(input.place ?? {}) } }
        : { source, destination: `/Game/Continuum/${asset.assetId.replace(/-/g, "_")}`, name: asset.assetId.replace(/-/g, "_"), scaleFactor: 1, place: input.place === null ? undefined : { label: asset.name, ...(input.place ?? {}) } };
    const outcome = await this.command({ sessionId: session.sessionId, projectRoot: input.projectRoot, operation: "asset.import", args, actor: input.actor, threadId: input.threadId });
    return this.#finishImport(input, asset, revision, session.engine, outcome, now, sidecar.expectedEngineDimensions ?? null);
  }

  async #finishImport(
    input: { readonly projectRoot: string; readonly assetId: string; readonly revision: number },
    asset: GameAsset,
    revision: ReturnType<typeof revisionOf>,
    engine: GameEngineId,
    outcome: GameDevCommandResult,
    at: string,
    expected: { x: number; y: number; z: number; units: string } | null = null,
  ) {
    const value = (outcome.value ?? {}) as { bounds?: { x: number; y: number; z: number }; size?: { x: number; y: number; z: number }; materials?: number; missingTextures?: number; triangles?: number; placed?: string; path?: string; imported?: string[] };
    const checks = outcome.ok
      ? importChecks({
          expected,
          measured: value.bounds ?? value.size ?? null,
          engineUpAxis: engine === "unreal" ? "z" : "y",
          materials: typeof value.materials === "number" ? value.materials : null,
          missingTextures: typeof value.missingTextures === "number" ? value.missingTextures : null,
          triangles: typeof value.triangles === "number" ? value.triangles : null,
          polygonBudget: revision.brief?.polygonBudget ?? null,
        })
      : [{ name: "Import", status: "fail" as const, detail: outcome.error ?? "Import failed" }];
    const entry = {
      revision: input.revision,
      engine,
      at,
      location: value.placed ?? value.path ?? value.imported?.[0] ?? "",
      status: outcome.ok ? ("imported" as const) : ("failed" as const),
      checks,
    };
    const updated = await recordImport(input.projectRoot, asset.assetId, entry);
    this.registry.note(input.projectRoot, "asset", `${outcome.ok ? "Imported" : "Could not import"} ${asset.name} r${input.revision}${checks.some((check) => check.status === "fail") ? " — checks failed" : ""}.`);
    return { asset: updated, import: entry, replaceRequired: null };
  }

  // ForgeGUI ------------------------------------------------------------------------------------

  async setForgeGuiKey(apiKey: string | null) {
    if (apiKey !== null && (apiKey.trim() === "" || /\s/.test(apiKey.trim()))) fail("That does not look like a ForgeGUI API key.");
    await this.host.setSecret(FORGEGUI_SECRET, apiKey === null ? null : apiKey.trim());
    return this.overview();
  }

  async #forge(): Promise<ForgeGuiClient> {
    const key = await this.host.getSecret(FORGEGUI_SECRET);
    if (key === null) fail("Add a ForgeGUI API key in Settings → Game Development → Roblox Studio → ForgeGUI.");
    return new ForgeGuiClient(key!);
  }

  async testForgeGui() {
    try {
      const client = await this.#forge();
      const tools = await client.listTools();
      const search = tools.some((tool) => tool.name === "library_search") ? await client.callTool("library_search", { query: "button" }) : null;
      return { ok: search === null || !search.isError, message: search?.isError ? `Connected, but library_search failed: ${search.text.slice(0, 200)}` : `Connected to ForgeGUI with ${tools.length} tools. The free library search worked.`, tools: tools.map((tool) => tool.name) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), tools: [] };
    }
  }

  /** Calls a ForgeGUI tool for an agent; paid and publishing calls wait for the user's approval. */
  async forgeGui(input: { readonly projectRoot: string; readonly tool: string; readonly args: Record<string, unknown>; readonly assetId?: string; readonly assetName?: string; readonly kind?: GameAssetKind; readonly brief?: GameAssetBrief | null; readonly threadId: string | null; readonly revision?: number }) {
    const client = await this.#forge();
    if (FORGEGUI_PUBLISH_TOOLS.has(input.tool)) {
      if (!this.#state.settings.allowForgeGuiPublishing) fail("Uploading to Roblox through ForgeGUI is off. Turn it on in Settings → Game Development → ForgeGUI.");
      const approved = await this.registry.requestApproval({ sessionId: null, projectRoot: input.projectRoot, operation: "forgegui.publish", summary: `Upload ${input.assetName ?? input.assetId ?? "artwork"} to Roblox through ForgeGUI`, threadId: input.threadId }, APPROVAL_TIMEOUT_MS);
      if (!approved) fail("The user did not approve the upload to Roblox.");
    } else if (FORGEGUI_PAID_TOOLS.has(input.tool)) {
      const approved = await this.registry.requestApproval({ sessionId: null, projectRoot: input.projectRoot, operation: "forgegui.generate", summary: `Generate ${input.assetName ?? "artwork"} with ForgeGUI ${input.tool} (spends ForgeGUI credits)`, threadId: input.threadId }, APPROVAL_TIMEOUT_MS);
      if (!approved) fail("The user did not approve spending ForgeGUI credits.");
    }
    const result = await client.callTool(input.tool, input.args);
    const credits = reportedCredits(result.structured);
    const response: Record<string, unknown> = { isError: result.isError, result: result.structured ?? result.text, credits };
    const preview = previewUrlOf(result.structured);
    if (!result.isError && input.assetId && preview && (FORGEGUI_PAID_TOOLS.has(input.tool) || input.tool === "generation_status")) {
      const asset = await ensureAsset(input.projectRoot, { assetId: input.assetId, name: input.assetName ?? input.assetId, kind: input.kind ?? "ui" });
      const image = await fetch(preview);
      if (image.ok) {
        const file = NodePath.join(assetDir(input.projectRoot, asset.assetId), "work-out", `forgegui-${Date.now()}.png`);
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(file, Buffer.from(await image.arrayBuffer()));
        const jobId = String((result.structured as { job_id?: unknown } | null)?.job_id ?? "unknown");
        const saved = await addRevision(input.projectRoot, asset.assetId, {
          createdBy: "agent",
          tool: "forgegui",
          note: `ForgeGUI ${input.tool}`,
          files: [{ role: "texture", source: file }],
          preview: file,
          stats: { triangles: null, materials: null, missingTextures: null, textureMaxSize: null, dimensions: null },
          checks: [],
          brief: input.brief ?? null,
          forgeGui: { jobId, creditsCharged: credits.charged, creditsNote: credits.note },
          now: this.host.now(),
        });
        const captureId = this.registry.storeCapture({ mimeType: "image/png", dataBase64: (await NodeFSP.readFile(file)).toString("base64"), width: null, height: null, source: "forgegui", projectRoot: input.projectRoot });
        this.registry.note(input.projectRoot, "asset", `ForgeGUI artwork for ${asset.name} saved as revision ${saved.revision.revision}.`, captureId);
        response.revision = saved.revision.revision;
        response.previewPath = file;
        response.captureId = captureId;
      }
    }
    if (input.assetId && input.revision !== undefined && (FORGEGUI_PUBLISH_TOOLS.has(input.tool) || input.tool === "generation_status")) {
      const status = publicationStatus(result.structured);
      if (status.status) {
        await recordPublication(input.projectRoot, input.assetId, input.revision, { service: "forgegui", publicationId: status.publicationId, status: status.status, robloxAssetId: status.assetId, updatedAt: this.host.now().toISOString() });
        response.publication = status;
      }
    }
    return response;
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const pick = args.path ?? args.label ?? args.name ?? args.className ?? args.filter ?? args.mode;
  return typeof pick === "string" ? pick.slice(0, 120) : "";
}

/** MSVC, clang, and UnrealBuildTool error lines. */
export function parseCompilerOutput(output: string) {
  const messages: Array<{ severity: "error" | "warning"; message: string; file: string | null; line: number | null }> = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const msvc = /^(.+?)\((\d+)(?:,\d+)?\)\s*:\s*(error|warning)\s+\w+\d*:\s*(.+)$/.exec(line);
    const clang = /^(.+?):(\d+):\d+:\s*(error|warning):\s*(.+)$/.exec(line);
    const match = msvc ?? clang;
    if (match) {
      messages.push({ severity: match[3] as "error" | "warning", message: match[4]!, file: match[1]!, line: Number(match[2]) });
      continue;
    }
    const ubt = /^(?:ERROR|Error):\s*(.+)$/.exec(line);
    if (ubt) messages.push({ severity: "error", message: ubt[1]!, file: null, line: null });
  }
  return messages.slice(0, 200);
}
