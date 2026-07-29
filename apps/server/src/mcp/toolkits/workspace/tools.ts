/**
 * The `workspace` MCP toolkit — what a ChatGPT Developer Mode connector sees.
 *
 * Tool descriptions here are load-bearing product surface, not documentation:
 * they are the only instructions the remote model gets, and it will not read
 * this repository's conventions on its own. Each one states what the tool
 * does, what it will refuse, and which tool to reach for instead — so the
 * model routes correctly on the first call rather than probing.
 *
 * Every tool is annotated `Destructive: false` and `OpenWorld: false` because
 * the toolkit is read-only by construction; there is no write or command tool
 * to gate.
 */
import {
  WorkspaceBridgeError,
  WorkspaceChangesInput,
  WorkspaceChangesResult,
  WorkspaceOverviewInput,
  WorkspaceOverviewResult,
  WorkspaceReadInput,
  WorkspaceReadResult,
  WorkspaceSearchInput,
  WorkspaceSearchResult,
  WorkspaceTreeInput,
  WorkspaceTreeResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WorkspaceBridgeCoordinator } from "./WorkspaceBridgeCoordinator.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, WorkspaceBridgeCoordinator];

export const WorkspaceOverviewTool = Tool.make("workspace_overview", {
  description:
    "Start here. Returns the repository this conversation is connected to: its name, current git branch, whether it has uncommitted changes, its top-level entries, and which agent instruction files (AGENTS.md, CLAUDE.md, README.md) exist. Read those instruction files before proposing changes — they carry conventions you cannot infer from the code. The workspace is fixed by the connector URL; you cannot open a different one.",
  parameters: WorkspaceOverviewInput,
  success: WorkspaceOverviewResult,
  failure: WorkspaceBridgeError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect connected workspace")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, false);

export const WorkspaceTreeTool = Tool.make("workspace_tree", {
  description:
    "List files and directories under a path in the workspace, breadth-first to a bounded depth. Use this to orient before reading. Version-control internals, dependency directories, and credential files are never listed. Returns truncated: true when the entry cap cut the listing short — narrow the path rather than raising the cap.",
  parameters: WorkspaceTreeInput,
  success: WorkspaceTreeResult,
  failure: WorkspaceBridgeError,
  dependencies,
})
  .annotate(Tool.Title, "List workspace files")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, false);

export const WorkspaceReadTool = Tool.make("workspace_read", {
  description:
    "Read one file from the workspace. Content comes back with 1-based line numbers so you can cite exact lines in your answer. Pass startLine and endLine to read a slice of a large file instead of all of it. Paths are relative to the workspace root; absolute paths, '..' traversal, and credential files are refused.",
  parameters: WorkspaceReadInput,
  success: WorkspaceReadResult,
  failure: WorkspaceBridgeError,
  dependencies,
})
  .annotate(Tool.Title, "Read workspace file")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, false);

export const WorkspaceSearchTool = Tool.make("workspace_search", {
  description:
    "Find literal text across the workspace and return matching lines with their paths and line numbers. Matching is case-insensitive unless your query contains an uppercase letter. This is the fastest way to locate a symbol, string, or config key before reading files. Scope with path when you already know the subtree.",
  parameters: WorkspaceSearchInput,
  success: WorkspaceSearchResult,
  failure: WorkspaceBridgeError,
  dependencies,
})
  .annotate(Tool.Title, "Search workspace")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, false);

export const WorkspaceChangesTool = Tool.make("workspace_changes", {
  description:
    "Show what is currently uncommitted in the workspace: the changed-file list and, by default, the unified diff. Use this to review work in progress or to ground a follow-up suggestion in what actually changed, rather than asking the user to paste a diff.",
  parameters: WorkspaceChangesInput,
  success: WorkspaceChangesResult,
  failure: WorkspaceBridgeError,
  dependencies,
})
  .annotate(Tool.Title, "Review uncommitted changes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, false);

export const WorkspaceToolkit = Toolkit.make(
  WorkspaceOverviewTool,
  WorkspaceTreeTool,
  WorkspaceReadTool,
  WorkspaceSearchTool,
  WorkspaceChangesTool,
);
