import {
  BlenderSceneInput,
  BlenderJob,
  BlenderJobOutput,
  BlenderJobRef,
  BlenderScene,
  BlenderStartJobInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Digest from "effect/crypto/Digest";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AssetSigner from "../../../assets/AssetSigner.ts";
import * as WorkspacePreviewRevisions from "../../../assets/WorkspacePreviewRevisions.ts";
import * as Blender from "../../../blender/Blender.ts";
import * as ServerConfig from "../../../config.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  Blender.Blender,
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
];

const jobResult = Schema.Struct({
  job: BlenderJob,
  links: Schema.Array(Schema.Struct({ output: BlenderJobOutput, url: Schema.String })),
});

export const BlenderToolkit = Toolkit.make(
  Tool.make("blender_inspect", {
    description:
      "Read object names, dimensions and saved selection from a workspace-relative .blend in this thread. Use the background Blender on this environment.",
    parameters: BlenderSceneInput.mapFields(Struct.omit(["threadId"])),
    success: BlenderScene,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("blender_run", {
    description:
      "Start one background Blender job. Use workspace-relative .blend and Python paths. Omit input to start a blank scene. Use saveAs for a new editable .blend, preview for GLB, and render for an on-demand PNG. Python scripts require full access and may call publish_preview() while editing when a preview was requested.",
    parameters: BlenderStartJobInput.mapFields(Struct.omit(["threadId"])),
    success: BlenderJob,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("blender_job", {
    description:
      "Read this thread's Blender job and available output links. Background job completion is delivered to this thread.",
    parameters: Schema.Struct({
      jobId: BlenderJobRef.fields.jobId,
    }),
    success: jobResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      ...dependencies,
      AssetSigner.AssetSigner,
      Digest.Digest,
      ChildProcessSpawner.ChildProcessSpawner,
      ProjectFaviconResolver.ProjectFaviconResolver,
      FileSystem.FileSystem,
      Path.Path,
      Orchestrator.OrchestratorV2,
      ServerConfig.ServerConfig,
      WorkspacePaths.WorkspacePaths,
      WorkspacePreviewRevisions.WorkspacePreviewRevisions,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("blender_cancel", {
    description: "Cancel this thread's Blender job and stop its owned subprocesses.",
    parameters: BlenderJobRef.mapFields(Struct.omit(["threadId"])),
    success: BlenderJob,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);
