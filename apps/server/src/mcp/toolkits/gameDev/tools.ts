import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as GameDevService from "../../../gameDev/GameDevService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    GameDevService.GameDevService,
    ThreadManagementService.ThreadManagementService,
    Project.ProjectService,
  ],
};

const Json = Schema.Record(Schema.String, Schema.Unknown);
const Result = Schema.Unknown;
const Engine = Schema.Literals(["roblox", "unity", "unreal"]);
const ExportTarget = Schema.Literals(["unity", "unreal", "roblox", "generic"]);

const Brief = Schema.Struct({
  description: Schema.String,
  style: Schema.optionalKey(Schema.String),
  dimensions: Schema.optionalKey(
    Schema.Struct({ x: Schema.Number, y: Schema.Number, z: Schema.Number, units: Schema.String }),
  ),
  textureResolution: Schema.optionalKey(Schema.Number),
  polygonBudget: Schema.optionalKey(Schema.Number),
  referenceImages: Schema.optionalKey(Schema.Array(Schema.String)),
  targetEngine: Schema.optionalKey(Engine),
}).annotate({ description: "The user's requirements; checks hold each revision to them." });

const GameStatusTool = Tool.make("continuum_game_status", {
  ...shared,
  description:
    "Game Development status for this thread's project: engine projects found, the connected editor (Roblox Studio, Unity, or Unreal) with the operations it supports right now and their argument shapes, play state, compile errors, and whether Blender and ForgeGUI are available. Call it before other continuum_game_* or continuum_asset_* tools.",
  parameters: Schema.Struct({}),
  success: Result,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GameCallTool = Tool.make("continuum_game_call", {
  ...shared,
  description:
    "Run one editor operation through the Continuum bridge on the connected editor for this project, such as scene.tree, object.get, object.create, object.update, script.read, script.write, asset.list, asset.update, blueprint.set_defaults, build.status, build.compile, playtest.start, playtest.stop, playtest.status, viewport.focus, editor.undo, or project.save. Only operations listed by continuum_game_status work. Deleting objects and restoring snapshots wait for the user's approval in Continuum. Edits go through the editor's undo history.",
  parameters: Schema.Struct({
    operation: Schema.String,
    args: Schema.optionalKey(Json),
  }),
  success: Result,
}).annotate(Tool.Destructive, true);

const GameCaptureTool = Tool.make("continuum_game_capture", {
  ...shared,
  description:
    "Capture the editor viewport (Unity Scene or Game view, Unreal level viewport, or Roblox Studio's window on Windows and macOS) and save it as a PNG you can open to see the result of your change. Optionally frame an object first (needs camera control on in Settings).",
  parameters: Schema.Struct({
    view: Schema.optionalKey(Schema.Literals(["scene", "game"])),
    width: Schema.optionalKey(Schema.Number),
    height: Schema.optionalKey(Schema.Number),
    focusPath: Schema.optionalKey(Schema.String),
  }),
  success: Result,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GameLogsTool = Tool.make("continuum_game_logs", {
  ...shared,
  description:
    "Read the connected editor's recent output: logs, warnings, errors, compile errors, test results, and your own bridge actions, optionally only from the latest playtest. Secrets are redacted.",
  parameters: Schema.Struct({
    kinds: Schema.optionalKey(
      Schema.Array(
        Schema.Literals(["log", "warning", "error", "build-error", "test-result", "agent-action", "play-state", "asset", "checkpoint", "capture"]),
      ),
    ),
    contains: Schema.optionalKey(Schema.String),
    latestPlaytestOnly: Schema.optionalKey(Schema.Boolean),
    limit: Schema.optionalKey(Schema.Number),
  }),
  success: Result,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GameRunTestsTool = Tool.make("continuum_game_run_tests", {
  ...shared,
  description:
    "Run the project's tests in the connected editor and wait for results: Unity Test Framework (mode EditMode or PlayMode, filter by class or namespace), Unreal automation tests (filter like Project.Inventory), or Roblox Luau specs (ModuleScripts named *.spec under ServerScriptService.Tests that return a table of test functions taking expect(condition, message)).",
  parameters: Schema.Struct({
    mode: Schema.optionalKey(Schema.Literals(["EditMode", "PlayMode"])),
    filter: Schema.optionalKey(Schema.String),
    roots: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  success: Result,
}).annotate(Tool.Destructive, false);

const GameCheckpointTool = Tool.make("continuum_game_checkpoint", {
  ...shared,
  description:
    "Game Project Checkpoints. `create` before a risky multi-file or scene change (copies scenes, assets, scripts, and settings; Roblox also snapshots scripts and properties in the open place). `list` and `diff` show what changed since. `restore` puts it back and needs the user's approval.",
  parameters: Schema.Struct({
    action: Schema.Literals(["create", "list", "diff", "restore"]),
    label: Schema.optionalKey(Schema.String),
    paths: Schema.optionalKey(Schema.Array(Schema.String)),
    checkpointId: Schema.optionalKey(Schema.String),
  }),
  success: Result,
}).annotate(Tool.Destructive, true);

const AssetBlenderTool = Tool.make("continuum_asset_blender", {
  ...shared,
  description:
    "Edit a 3D asset in Blender (background mode) for this project, with or without an engine. Each asset has a working .blend. Operations: inspect; create_mesh {name, primitive cube|plane|uv_sphere|ico_sphere|cylinder|cone|torus, size, location, rotationDegrees, scale, dimensions, shadeSmooth} or {name, vertices, faces}; modify {object, location, rotationDegrees, scale, dimensions, modifiers:[{type, ...}], applyModifiers, applyTransforms, bevel, shadeSmooth}; material {object, name, baseColor [r,g,b,a], metallic, roughness, emission, imageTexture}; delete {objects}; import {path}; render_preview {output, width, height}; check {polygonBudget, textureResolution, dimensions}. Blender units are meters. Use fresh=true to start an empty scene.",
  parameters: Schema.Struct({
    asset: Schema.String.annotate({ description: "Asset id: lowercase letters, digits, and dashes, such as wooden-crate." }),
    name: Schema.optionalKey(Schema.String),
    kind: Schema.optionalKey(Schema.Literals(["model", "texture", "ui", "icon", "other"])),
    operation: Schema.Literals(["inspect", "create_mesh", "modify", "material", "delete", "import", "render_preview", "check"]),
    args: Schema.optionalKey(Json),
    fresh: Schema.optionalKey(Schema.Boolean),
  }),
  success: Result,
}).annotate(Tool.Destructive, false);

const AssetSaveRevisionTool = Tool.make("continuum_asset_save_revision", {
  ...shared,
  description:
    "Freeze the asset's working .blend into a new revision: keeps the .blend source, exports for the target engine (Unity FBX in meters Y-up, Unreal FBX in centimeters Z-up, Roblox FBX in studs, or generic GLB), renders a preview PNG you should open, and checks it against the brief (polygon budget, texture size, dimensions, missing textures, unapplied scale).",
  parameters: Schema.Struct({
    asset: Schema.String,
    target: ExportTarget,
    format: Schema.optionalKey(Schema.Literals(["fbx", "glb", "obj"])),
    note: Schema.String,
    brief: Schema.optionalKey(Brief),
  }),
  success: Result,
}).annotate(Tool.Destructive, false);

const AssetRegisterTool = Tool.make("continuum_asset_register", {
  ...shared,
  description:
    "Record a 2D or 3D asset revision you produced another way (for example a PNG you drew with a script): files with roles source, export, texture, or reference, and a preview image. Paths are relative to the project or absolute.",
  parameters: Schema.Struct({
    asset: Schema.String,
    name: Schema.String,
    kind: Schema.Literals(["model", "texture", "ui", "icon", "other"]),
    files: Schema.Array(Schema.Struct({ role: Schema.Literals(["source", "export", "texture", "reference"]), path: Schema.String })),
    preview: Schema.optionalKey(Schema.String),
    note: Schema.String,
    brief: Schema.optionalKey(Brief),
  }),
  success: Result,
}).annotate(Tool.Destructive, false);

const AssetImportTool = Tool.make("continuum_asset_import", {
  ...shared,
  description:
    "Import a chosen asset revision into the connected editor and place it, then report what the engine measured: size against the export's expected size, up axis, materials, missing textures, and triangles. Replacing a revision already in the project waits for the user's approval. Roblox needs an approved upload first (continuum_asset_forgegui with artifact_publish).",
  parameters: Schema.Struct({
    asset: Schema.String,
    revision: Schema.Number,
    place: Schema.optionalKey(Json),
  }),
  success: Result,
}).annotate(Tool.Destructive, true);

const AssetListTool = Tool.make("continuum_asset_list", {
  ...shared,
  description: "List this project's generated and edited assets with revisions, previews, files, checks, and import status.",
  parameters: Schema.Struct({}),
  success: Result,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AssetForgeGuiTool = Tool.make("continuum_asset_forgegui", {
  ...shared,
  description:
    "Call a ForgeGUI tool with the user's ForgeGUI account (the key stays in Continuum). library_search, style_list, asset_capabilities, generation_status, and generation_list are free. generation_gui, generation_image, and generation_model_3d spend credits and wait for the user's approval; pass asset and name so the artwork is saved as a revision with its preview. artifact_publish uploads to Roblox only after the user approves; poll generation_status for moderation, then continuum_asset_import. Never retry an outcome_unknown job; check generation_status instead.",
  parameters: Schema.Struct({
    tool: Schema.String,
    args: Schema.optionalKey(Json),
    asset: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    kind: Schema.optionalKey(Schema.Literals(["model", "texture", "ui", "icon", "other"])),
    revision: Schema.optionalKey(Schema.Number),
    brief: Schema.optionalKey(Brief),
  }),
  success: Result,
}).annotate(Tool.Destructive, true);

export const GameDevToolkit = Toolkit.make(
  GameStatusTool,
  GameCallTool,
  GameCaptureTool,
  GameLogsTool,
  GameRunTestsTool,
  GameCheckpointTool,
  AssetBlenderTool,
  AssetSaveRevisionTool,
  AssetRegisterTool,
  AssetImportTool,
  AssetListTool,
  AssetForgeGuiTool,
);
