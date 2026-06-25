import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import {
  OrchestrationArchiveThreadInput,
  OrchestrationArchiveThreadResult,
  OrchestrationCreateThreadInput,
  OrchestrationCreateThreadResult,
  OrchestrationGetSnapshotError,
  OrchestrationListProjectsResult,
  OrchestrationListThreadsInput,
  OrchestrationListThreadsResult,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  OrchestrationEngine.OrchestrationEngineService,
];

const readOnlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.Destructive, false) as T;

const mutatingTool = <T extends Tool.Any>(tool: T): T => tool.annotate(Tool.Destructive, true) as T;

export const ProjectsListTool = readOnlyTool(
  Tool.make("projects_list", {
    description: "List all projects visible in the current workspace.",
    success: OrchestrationListProjectsResult,
    failure: OrchestrationGetSnapshotError,
    dependencies,
  }).annotate(Tool.Title, "List projects"),
);

export const ThreadsListTool = readOnlyTool(
  Tool.make("threads_list", {
    description: "List all threads belonging to one project.",
    parameters: OrchestrationListThreadsInput,
    success: OrchestrationListThreadsResult,
    failure: OrchestrationGetSnapshotError,
    dependencies,
  }).annotate(Tool.Title, "List project threads"),
);

export const ThreadsCreateTool = mutatingTool(
  Tool.make("threads_create", {
    description:
      "Create a new thread in the requested project and return the created shell summary.",
    parameters: OrchestrationCreateThreadInput,
    success: OrchestrationCreateThreadResult,
    failure: Schema.Union([OrchestrationDispatchCommandError, OrchestrationGetSnapshotError]),
    dependencies,
  }).annotate(Tool.Title, "Create thread"),
);

export const ThreadsArchiveTool = mutatingTool(
  Tool.make("threads_archive", {
    description: "Archive a thread and return its updated shell summary.",
    parameters: OrchestrationArchiveThreadInput,
    success: OrchestrationArchiveThreadResult,
    failure: Schema.Union([OrchestrationDispatchCommandError, OrchestrationGetSnapshotError]),
    dependencies,
  }).annotate(Tool.Title, "Archive thread"),
);

export const OrchestrationToolkit = Toolkit.make(
  ProjectsListTool,
  ThreadsListTool,
  ThreadsCreateTool,
  ThreadsArchiveTool,
);
