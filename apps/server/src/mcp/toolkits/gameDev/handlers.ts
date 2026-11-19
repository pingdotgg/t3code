// @effect-diagnostics effectFnOpportunity:off globalDate:off - Handlers delegate to the promise-based Game Dev core; the revision timestamp is user-facing.
import { OrchestratorMcpFailure, type GameAssetBrief, type GameEngineId } from "@t3tools/contracts";
import { GAME_OPERATIONS, isGameOperation } from "@t3tools/shared/gameDevCatalog";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GameDevService from "../../../gameDev/GameDevService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import { GameDevToolkit } from "./tools.ts";

/** Argument shapes per engine, shown by continuum_game_status. */
const ARGUMENTS: Record<GameEngineId, Record<string, string>> = {
  roblox: {
    "scene.tree": "{path?: 'Workspace.Model', depth?: 2}",
    "object.get": "{path: 'Workspace.Part'}",
    "object.create": "{className, parent: 'Workspace', name?, properties?: {Size:{x,y,z}, Color:'#ff8800', Anchored:true, CFrame:{position:{x,y,z}, rotation:{x,y,z}}, Material:'Enum.Material.Neon', Size (GUI):{xScale,xOffset,yScale,yOffset}}, attributes?, tags?, source?}",
    "object.update": "{path, properties?, attributes?}",
    "object.delete": "{path} (asks the user)",
    "script.read": "{path}",
    "script.write": "{path: 'ServerScriptService.Game', source, className?: 'Script'|'LocalScript'|'ModuleScript'} (creates it if missing)",
    "asset.import": "{assetId (approved Roblox upload), kind: 'image'|'decal'|'mesh'|'model', parent, name?, className?: 'ImageLabel'|'ImageButton', properties?}",
    "playtest.start": "{mode?: 'run'|'play'}",
    "viewport.focus": "{path}",
  },
  unity: {
    "scene.tree": "{depth?: 3}",
    "object.get": "{path: 'SceneName/Root/Child' or 'Root/Child'}",
    "object.create": "{name, parent?, primitive?: 'Cube'|'Sphere'|..., components?: ['Rigidbody'], position?, rotation?, scale?, properties?: {'Rigidbody.m_Mass': 2}}",
    "object.update": "{path, name?, active?, position?, rotation?, scale?, addComponents?, removeComponents?, properties?: {'Component.serializedPath': value}}",
    "object.delete": "{path} (asks the user)",
    "script.read": "{path: 'Assets/Scripts/X.cs'}",
    "script.write": "{path: 'Assets/Scripts/X.cs', source} then build.status for compiler errors",
    "asset.list": "{folder?: 'Assets', filter?: 't:Material', limit?}",
    "asset.update": "{path: 'Assets/Materials/M.mat', properties: {serializedPath: value}}",
    "build.status": "{}",
    "build.compile": "{}",
    "viewport.capture": "{view?: 'scene'|'game', width?, height?}",
  },
  unreal: {
    "scene.tree": "{limit?: 500}",
    "object.get": "{path or label, properties?: ['bHidden']}",
    "object.create": "{class?: 'StaticMeshActor'|'PointLight'|..., asset?: '/Game/Path/Mesh', label?, location?: {x,y,z}, rotation?: {pitch,yaw,roll}, scale?, properties?}",
    "object.update": "{path or label, location?, rotation?, scale?, label?, properties?}",
    "object.delete": "{path or label} (asks the user)",
    "script.write": "{path: 'Source/Game/X.cpp' or 'Content/Python/x.py', source} then build.compile for C++",
    "asset.list": "{path?: '/Game', class?: 'StaticMesh', limit?}",
    "asset.update": "{path: '/Game/Path/Asset', properties}",
    "blueprint.set_defaults": "{path: '/Game/BP_Player', properties: {MaxWalkSpeed: 900}} (compiles and reads back)",
    "build.compile": "{} (UnrealBuildTool; close the editor or turn Live Coding off for C++ changes)",
    "viewport.capture": "{width?, height?}",
  },
};

const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const threadProject = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Game Development tools");
  const {
    projection: { thread: record },
  } = yield* readThread(thread.threadId);
  const projects = yield* Project.ProjectService;
  const project = yield* projects.getById(record.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: "The thread's project was not found." });
  }
  return { threadId: thread.threadId as string, root: record.worktreePath ?? project.value.workspaceRoot };
});

const withCore = <A>(name: string, work: (core: GameDevService.GameDevService["Service"]["core"], project: { threadId: string; root: string }) => Promise<A>) =>
  Effect.gen(function* () {
    const project = yield* threadProject;
    const service = yield* GameDevService.GameDevService;
    return yield* service.run(name, (core) => work(core, project)).pipe(Effect.mapError(failure));
  });

const brief = (input: Record<string, unknown> | undefined): GameAssetBrief | null =>
  input === undefined
    ? null
    : {
        description: String(input.description ?? ""),
        style: String(input.style ?? ""),
        dimensions: (input.dimensions as GameAssetBrief["dimensions"]) ?? null,
        textureResolution: typeof input.textureResolution === "number" ? input.textureResolution : null,
        polygonBudget: typeof input.polygonBudget === "number" ? input.polygonBudget : null,
        referenceImages: Array.isArray(input.referenceImages) ? (input.referenceImages as string[]) : [],
        targetEngine: (input.targetEngine as GameEngineId | undefined) ?? null,
      };

const capturePath = async (core: GameDevService.GameDevService["Service"]["core"], captureId: string | null) =>
  captureId === null ? null : await core.captureToFile(captureId);

const handlers = {
  continuum_game_status: McpToolAccess.readsAsCaller(() =>
    withCore("agentStatus", async (core, project) => {
      const overview = await core.overview();
      const workspace = await core.workspace(project.root);
      const session = workspace.session;
      const operations = session
        ? core.operationsFor(session).map((operation) => ({
            operation,
            description: isGameOperation(operation) ? GAME_OPERATIONS[operation].description : operation,
            asksUser: isGameOperation(operation) && GAME_OPERATIONS[operation].approval,
            args: ARGUMENTS[session.engine][operation] ?? "{}",
          }))
        : [];
      return {
        projectRoot: project.root,
        projects: workspace.projects,
        editor: session
          ? {
              engine: session.engine,
              version: session.editorVersion,
              project: session.projectName,
              state: session.state,
              playState: session.playState,
              compileErrors: session.compileErrorCount,
              runsIn: "its own editor window on this computer; Continuum controls it through the bridge plugin",
            }
          : null,
        operations,
        unboundEditors: workspace.unboundSessions.map((entry) => `${entry.engine}: ${entry.projectName} (the user can bind it in the Game Development panel)`),
        compileMessages: workspace.compileMessages.slice(0, 20),
        cameraControl: overview.settings.allowCameraControl,
        blender: overview.tools.find((tool) => tool.tool === "blender")?.installed?.version ?? null,
        forgeGui: overview.tools.find((tool) => tool.tool === "forgegui")?.configured ?? false,
        hint: session ? null : "No editor is connected. Ask the user to open the project from the Game Development panel; Blender asset tools still work.",
      };
    }),
  ),
  continuum_game_call: McpToolAccess.actsAsCaller(({ operation, args }) =>
    withCore("agentCall", async (core, project) => {
      const result = await core.command({ sessionId: null, projectRoot: project.root, operation, args: args ?? {}, actor: "agent", threadId: project.threadId });
      return { ...result, capturePath: await capturePath(core, result.captureId) };
    }),
  ),
  continuum_game_capture: McpToolAccess.readsAsCaller((input) =>
    withCore("agentCapture", async (core, project) => {
      if (input.focusPath) {
        await core.command({ sessionId: null, projectRoot: project.root, operation: "viewport.focus", args: { path: input.focusPath }, actor: "agent", threadId: project.threadId });
      }
      const result = await core.command({
        sessionId: null,
        projectRoot: project.root,
        operation: "viewport.capture",
        args: { ...(input.view ? { view: input.view } : {}), ...(input.width ? { width: input.width } : {}), ...(input.height ? { height: input.height } : {}) },
        actor: "agent",
        threadId: project.threadId,
      });
      if (!result.ok) throw new Error(result.error ?? "Capture failed.");
      return { capturePath: await capturePath(core, result.captureId), captureId: result.captureId, details: result.value, note: "Open capturePath to look at it." };
    }),
  ),
  continuum_game_logs: McpToolAccess.readsAsCaller((input) =>
    withCore("agentLogs", async (core, project) => {
      const session = core.registry.sessionForProject(project.root);
      if (!session) throw new Error("No editor has connected for this project yet.");
      return {
        entries: core.registry.logs(session.sessionId, {
          levels: input.kinds ?? ["log", "warning", "error", "build-error", "test-result"],
          contains: input.contains ?? null,
          limit: Math.min(Math.max(input.limit ?? 120, 1), 500),
          playtest: input.latestPlaytestOnly ? "latest" : null,
        }),
      };
    }),
  ),
  continuum_game_run_tests: McpToolAccess.actsAsCaller((input) =>
    withCore("agentRunTests", (core, project) =>
      core.command({ sessionId: null, projectRoot: project.root, operation: "tests.run", args: { ...input }, actor: "agent", threadId: project.threadId }),
    ),
  ),
  continuum_game_checkpoint: McpToolAccess.actsAsCaller((input) =>
    withCore("agentCheckpoint", async (core, project) => {
      switch (input.action) {
        case "create":
          return core.checkpointCreate({ projectRoot: project.root, label: input.label ?? "Before agent change", ...(input.paths ? { paths: input.paths } : {}), createdBy: "agent" });
        case "list":
          return { checkpoints: (await core.workspace(project.root)).checkpoints };
        case "diff": {
          const diff = await core.checkpointDiff(project.root, input.checkpointId ?? "");
          return { ...diff, changes: diff.changes.map((change) => ({ ...change, diff: change.diff?.slice(0, 6_000) ?? null })) };
        }
        case "restore":
          return core.checkpointRestore(project.root, input.checkpointId ?? "", "agent", project.threadId);
      }
    }),
  ),
  continuum_asset_blender: McpToolAccess.actsAsCaller((input) =>
    withCore("agentBlender", (core, project) =>
      core.blender({
        projectRoot: project.root,
        assetId: input.asset,
        ...(input.name ? { name: input.name } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        operation: input.operation,
        args: input.args ?? {},
        fresh: input.fresh === true,
      }),
    ),
  ),
  continuum_asset_save_revision: McpToolAccess.actsAsCaller((input) =>
    withCore("agentSaveRevision", async (core, project) => {
      const saved = await core.saveBlenderRevision({
        projectRoot: project.root,
        assetId: input.asset,
        target: input.target,
        ...(input.format ? { format: input.format } : {}),
        note: input.note,
        brief: brief(input.brief as Record<string, unknown> | undefined),
        createdBy: "agent",
      });
      return { revision: saved.revision, previewPath: saved.revision.previewPath ? `${project.root}/${saved.revision.previewPath}` : null, note: "Open previewPath and confirm it matches the brief before importing." };
    }),
  ),
  continuum_asset_register: McpToolAccess.actsAsCaller((input) =>
    withCore("agentRegister", async (core, project) => {
      const { ensureAsset, addRevision } = await import("../../../gameDev/gameAssets.ts");
      const asset = await ensureAsset(project.root, { assetId: input.asset, name: input.name, kind: input.kind });
      const saved = await addRevision(project.root, asset.assetId, {
        createdBy: "agent",
        tool: "agent",
        note: input.note,
        files: input.files.map((file) => ({ role: file.role, source: file.path })),
        preview: input.preview ?? null,
        stats: { triangles: null, materials: null, missingTextures: null, textureMaxSize: null, dimensions: null },
        checks: [],
        brief: brief(input.brief as Record<string, unknown> | undefined),
        forgeGui: null,
        now: new Date(),
      });
      core.registry.note(project.root, "asset", `${asset.name} revision ${saved.revision.revision} recorded.`);
      return { revision: saved.revision };
    }),
  ),
  continuum_asset_import: McpToolAccess.actsAsCaller((input) =>
    withCore("agentImport", (core, project) =>
      core.assetImport({ projectRoot: project.root, assetId: input.asset, revision: input.revision, confirmReplace: false, actor: "agent", threadId: project.threadId, place: input.place ?? {} }),
    ),
  ),
  continuum_asset_list: McpToolAccess.readsAsCaller(() =>
    withCore("agentAssets", async (core, project) => ({ assets: await core.listAssets(project.root) })),
  ),
  continuum_asset_forgegui: McpToolAccess.actsAsCaller((input) =>
    withCore("agentForgeGui", (core, project) =>
      core.forgeGui({
        projectRoot: project.root,
        tool: input.tool,
        args: input.args ?? {},
        ...(input.asset ? { assetId: input.asset } : {}),
        ...(input.name ? { assetName: input.name } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.revision !== undefined ? { revision: input.revision } : {}),
        brief: brief(input.brief as Record<string, unknown> | undefined),
        threadId: project.threadId,
      }),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof GameDevToolkit.tools>;

export const layer = McpToolAccess.toLayer(GameDevToolkit, handlers);
