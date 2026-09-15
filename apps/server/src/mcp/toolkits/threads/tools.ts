import {
  ThreadsCreateInput,
  ThreadsCreateResult,
  ThreadsListInput,
  ThreadsListResult,
  ThreadsSurfaceError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const listDependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

const createDependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  OrchestrationEngine.OrchestrationEngineService,
  Crypto.Crypto,
];

export const ThreadsListTool = Tool.make("threads_list", {
  description:
    "List threads in this environment. Returns thread ids and titles only — one row per thread with its id, project, title, settled state, and last-updated time. Use filter:'settled' for finished work, 'active' for in-flight threads, or 'recent' (default) for the most recently updated. Use this when the user asks to see threads rather than describe them from memory.",
  parameters: ThreadsListInput,
  success: ThreadsListResult,
  failure: ThreadsSurfaceError,
  dependencies: listDependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadsCreateTool = Tool.make("threads_create", {
  description:
    "Create a new, empty thread in this environment (in the current project unless projectId is given) and return its id. The thread starts with no conversation; the user can open it and start a turn. Creating a thread shows the user a notification with a link to it, so prefer this over describing where things live.",
  parameters: ThreadsCreateInput,
  success: ThreadsCreateResult,
  failure: ThreadsSurfaceError,
  dependencies: createDependencies,
})
  .annotate(Tool.Title, "Create thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const ThreadsToolkit = Toolkit.make(ThreadsListTool, ThreadsCreateTool);
