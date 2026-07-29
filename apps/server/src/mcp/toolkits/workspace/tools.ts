/**
 * The `workspace` MCP toolkit — what a ChatGPT Developer Mode connector sees.
 *
 * Tool descriptions here are load-bearing product surface, not documentation:
 * they are the only instructions the remote model gets, and it will not read
 * this repository's conventions on its own. Each one states what the tool
 * does, what it will refuse, and which tool to reach for instead — so the
 * model routes correctly on the first call rather than probing.
 *
 * The read tools are annotated `Readonly`/non-destructive; the mutating tools
 * (`workspace_write`/`_edit`/`_patch`/`_bash`) are `Destructive` and are
 * additionally gated twice at runtime: by the credential's capabilities
 * (settings-level access) and by the thread's runtime mode (per-operation
 * approval in the SergeCode timeline).
 */
import {
  WorkspaceBashInput,
  WorkspaceBridgeError,
  WorkspaceChangesInput,
  WorkspaceChangesResult,
  WorkspaceEditInput,
  WorkspaceMutationResult,
  WorkspaceOverviewInput,
  WorkspaceOverviewResult,
  WorkspacePatchInput,
  WorkspaceReadInput,
  WorkspaceReadResult,
  WorkspaceSearchInput,
  WorkspaceSearchResult,
  WorkspaceTreeInput,
  WorkspaceTreeResult,
  WorkspaceWaitInput,
  WorkspaceWriteInput,
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

/**
 * Shared tail for every mutating tool's description. The pending/poll
 * protocol is the part remote models get wrong most often, so it is stated
 * on every tool rather than once in a place the model may not have read.
 */
const APPROVAL_PROTOCOL =
  " Depending on the thread's runtime mode this may return status pending-approval — the user is being asked in SergeCode. Poll workspace_wait with the returned operationId until the status is terminal; do not re-submit the operation.";

export const WorkspaceWriteTool = Tool.make("workspace_write", {
  description:
    "Create or completely overwrite one file in the workspace. Prefer workspace_edit for small changes so the user reviews a focused diff instead of a whole file." +
    APPROVAL_PROTOCOL,
  parameters: WorkspaceWriteInput,
  success: WorkspaceMutationResult,
  failure: WorkspaceBridgeError,
  dependencies,
})
  .annotate(Tool.Title, "Write workspace file")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, true);

export const WorkspaceEditTool = Tool.make("workspace_edit", {
  description:
    "Replace an exact text snippet in one file. oldText must match the current file content verbatim (read the file first); the call fails if it matches zero or several places unless replaceAll is set." +
    APPROVAL_PROTOCOL,
  parameters: WorkspaceEditInput,
  success: WorkspaceMutationResult,
  failure: WorkspaceBridgeError,
  dependencies,
})
  .annotate(Tool.Title, "Edit workspace file")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, true);

export const WorkspacePatchTool = Tool.make("workspace_patch", {
  description:
    "Apply one unified diff (git diff format, a/… b/… paths) to the workspace. The patch is checked with `git apply --check` first and rejected wholesale if any hunk fails, so a partial apply never happens." +
    APPROVAL_PROTOCOL,
  parameters: WorkspacePatchInput,
  success: WorkspaceMutationResult,
  failure: WorkspaceBridgeError,
  dependencies,
})
  .annotate(Tool.Title, "Apply patch to workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, true);

export const WorkspaceBashTool = Tool.make("workspace_bash", {
  description:
    "Shell execution is currently disabled for public connectors because the server cannot enforce an OS-level filesystem and network sandbox. Use workspace_read, workspace_search, workspace_changes, or workspace_patch instead." +
    APPROVAL_PROTOCOL,
  parameters: WorkspaceBashInput,
  success: WorkspaceMutationResult,
  failure: WorkspaceBridgeError,
  dependencies,
})
  .annotate(Tool.Title, "Run command in workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, true);

export const WorkspaceWaitTool = Tool.make("workspace_wait", {
  description:
    "Check on a pending workspace operation. Returns the operation's current state, waiting briefly for the user's approval decision. Keep calling it while the status is pending-approval; when it turns completed, denied, or failed, act on that result.",
  parameters: WorkspaceWaitInput,
  success: WorkspaceMutationResult,
  failure: WorkspaceBridgeError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for workspace operation")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, false);

export const WorkspaceToolkit = Toolkit.make(
  WorkspaceOverviewTool,
  WorkspaceTreeTool,
  WorkspaceReadTool,
  WorkspaceSearchTool,
  WorkspaceChangesTool,
  WorkspaceWriteTool,
  WorkspaceEditTool,
  WorkspacePatchTool,
  WorkspaceBashTool,
  WorkspaceWaitTool,
);
