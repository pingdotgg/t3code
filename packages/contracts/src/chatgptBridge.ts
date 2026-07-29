/**
 * Workspace-bridge contracts for the product-native MCP "workspace" toolkit.
 *
 * These tools are what a *remote* MCP client — in practice a chatgpt.com
 * conversation that has SergeCode registered as a Developer Mode connector —
 * calls to inspect the repository behind one SergeCode thread. They are the
 * read side of the ChatGPT web bridge: the browser provider carries prompts
 * and prose, this toolkit carries repository truth.
 *
 * Two invariants shape every schema here:
 *
 *   1. **No caller-supplied workspace.** The credential is minted per thread
 *      and the thread owns the worktree, so no tool accepts a root, workspace
 *      id, or absolute path. A remote model cannot widen its own scope.
 *   2. **Bounded results.** Every tool that can return an unbounded amount of
 *      repository content caps it and reports the cap it applied, so a large
 *      repository degrades into a truncated answer rather than a stalled
 *      request or an oversized response body.
 *
 * Keep this module schema-only; the runtime lives in
 * `apps/server/src/mcp/toolkits/workspace/`.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Relative path inside the thread's worktree.
 *
 * Absolute paths and `..` segments are rejected here rather than in the
 * handler so that a malformed path never reaches the filesystem layer at all.
 * The guard in `WorkspacePathGuard` still re-checks the resolved path — this
 * is the cheap first gate, not the security boundary.
 */
export const WorkspaceRelativePath = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      (!value.startsWith("/") && !value.startsWith("~") && !value.split(/[\\/]/).includes("..")) ||
      new SchemaIssue.InvalidValue(Option.some(value), {
        message: "Path must be relative to the workspace root and must not contain '..' segments.",
      }),
    { identifier: "WorkspaceRelativePath" },
  ),
);
export type WorkspaceRelativePath = typeof WorkspaceRelativePath.Type;

/**
 * What the workspace connector may do, chosen in provider settings and baked
 * into the credential as capabilities at session start:
 *
 *   - `read`  — the five read-only tools.
 *   - `write` — adds file mutations (`workspace_write`/`_edit`/`_patch`).
 *   - `full`  — enables the highest workspace mutation access; shell execution
 *               remains withheld until a real OS-level sandbox is available.
 *
 * Whether a granted mutation *executes* is a separate, per-operation decision:
 * the thread's runtime mode either auto-approves it or routes it through the
 * approval card in the SergeCode timeline, exactly like a local provider's
 * tool call.
 */
export const WorkspaceBridgeAccess = Schema.Literals(["read", "write", "full"]);
export type WorkspaceBridgeAccess = typeof WorkspaceBridgeAccess.Type;

/* -------------------------------------------------------------------------- */
/* workspace_overview                                                          */
/* -------------------------------------------------------------------------- */

export const WorkspaceOverviewInput = Schema.Struct({});
export type WorkspaceOverviewInput = typeof WorkspaceOverviewInput.Type;

export const WorkspaceOverviewResult = Schema.Struct({
  /** Absolute worktree root, for display only — tools never accept it back. */
  root: TrimmedNonEmptyString,
  /** Repository name, derived from the root directory name. */
  name: TrimmedNonEmptyString,
  /** Checked-out branch, or null outside a git repository. */
  branch: Schema.NullOr(Schema.String),
  /** True when the worktree has uncommitted changes. */
  dirty: Schema.Boolean,
  /** Top-level entries, so the model can orient without a full tree walk. */
  entries: Schema.Array(TrimmedNonEmptyString),
  /**
   * Agent instruction files found at the root (AGENTS.md, CLAUDE.md, …).
   * Named rather than inlined so the model chooses whether to spend context
   * on them.
   */
  instructionFiles: Schema.Array(TrimmedNonEmptyString),
  /** True when write and command tools are unavailable on this credential. */
  readOnly: Schema.Boolean,
  /** Access level this credential grants; mutations may still need approval. */
  access: WorkspaceBridgeAccess,
});
export type WorkspaceOverviewResult = typeof WorkspaceOverviewResult.Type;

/* -------------------------------------------------------------------------- */
/* workspace_tree                                                              */
/* -------------------------------------------------------------------------- */

export const WorkspaceTreeInput = Schema.Struct({
  path: Schema.optional(
    WorkspaceRelativePath.annotate({
      description: "Directory to list, relative to the workspace root. Defaults to the root.",
    }),
  ),
  maxDepth: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })).annotate({
      description: "How many directory levels to descend (1-8).",
      default: 3,
    }),
  ),
  maxEntries: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 })).annotate({
      description: "Maximum entries to return before truncating (1-2000).",
      default: 400,
    }),
  ),
});
export type WorkspaceTreeInput = typeof WorkspaceTreeInput.Type;

export const WorkspaceTreeEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "directory"]),
});
export type WorkspaceTreeEntry = typeof WorkspaceTreeEntry.Type;

export const WorkspaceTreeResult = Schema.Struct({
  entries: Schema.Array(WorkspaceTreeEntry),
  /** True when `maxEntries` cut the listing short. */
  truncated: Schema.Boolean,
});
export type WorkspaceTreeResult = typeof WorkspaceTreeResult.Type;

/* -------------------------------------------------------------------------- */
/* workspace_read                                                              */
/* -------------------------------------------------------------------------- */

export const WorkspaceReadInput = Schema.Struct({
  path: WorkspaceRelativePath.annotate({
    description: "File to read, relative to the workspace root.",
  }),
  startLine: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "First line to return (1-based). Defaults to the start of the file.",
    }),
  ),
  endLine: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "Last line to return (1-based, inclusive). Defaults to the end of the file.",
    }),
  ),
});
export type WorkspaceReadInput = typeof WorkspaceReadInput.Type;

export const WorkspaceReadResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** File slice with 1-based line numbers, so follow-up edits can cite lines. */
  content: Schema.String,
  startLine: NonNegativeInt,
  endLine: NonNegativeInt,
  totalLines: NonNegativeInt,
  /** True when a byte cap, not `endLine`, ended the slice. */
  truncated: Schema.Boolean,
});
export type WorkspaceReadResult = typeof WorkspaceReadResult.Type;

/* -------------------------------------------------------------------------- */
/* workspace_search                                                            */
/* -------------------------------------------------------------------------- */

export const WorkspaceSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.annotate({
    description: "Literal text to find. Case-insensitive unless the query contains uppercase.",
  }),
  path: Schema.optional(
    WorkspaceRelativePath.annotate({
      description: "Restrict the search to this subdirectory.",
    }),
  ),
  maxResults: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).annotate({
      description: "Maximum matching lines to return (1-500).",
      default: 100,
    }),
  ),
});
export type WorkspaceSearchInput = typeof WorkspaceSearchInput.Type;

export const WorkspaceSearchMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: NonNegativeInt,
  text: Schema.String,
});
export type WorkspaceSearchMatch = typeof WorkspaceSearchMatch.Type;

export const WorkspaceSearchResult = Schema.Struct({
  matches: Schema.Array(WorkspaceSearchMatch),
  /** True when `maxResults` cut the result set short. */
  truncated: Schema.Boolean,
});
export type WorkspaceSearchResult = typeof WorkspaceSearchResult.Type;

/* -------------------------------------------------------------------------- */
/* workspace_changes                                                           */
/* -------------------------------------------------------------------------- */

export const WorkspaceChangesInput = Schema.Struct({
  includeDiff: Schema.optional(
    Schema.Boolean.annotate({
      description: "Include the unified diff body, not just the changed-file summary.",
      default: true,
    }),
  ),
  staged: Schema.optional(
    Schema.Boolean.annotate({
      description: "Diff the staged changes instead of the working tree.",
      default: false,
    }),
  ),
});
export type WorkspaceChangesInput = typeof WorkspaceChangesInput.Type;

export const WorkspaceChangedFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
});
export type WorkspaceChangedFile = typeof WorkspaceChangedFile.Type;

export const WorkspaceChangesResult = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  files: Schema.Array(WorkspaceChangedFile),
  /** Unified diff, empty when `includeDiff` is false or nothing changed. */
  diff: Schema.String,
  /** True when the diff body hit the byte cap. */
  truncated: Schema.Boolean,
});
export type WorkspaceChangesResult = typeof WorkspaceChangesResult.Type;

/* -------------------------------------------------------------------------- */
/* Mutations: workspace_write / _edit / _patch / _bash / _wait                 */
/* -------------------------------------------------------------------------- */

export const WorkspaceMutationTool = Schema.Literals(["write", "edit", "patch", "bash"]);
export type WorkspaceMutationTool = typeof WorkspaceMutationTool.Type;

/**
 * Lifecycle of one staged mutation.
 *
 * `pending-approval` is a normal, expected state — MCP calls must stay short,
 * and a human decision can take longer than a tool call may block. The caller
 * polls `workspace_wait` with the operation id until the state is terminal.
 * `failed` is terminal-but-approved: the user said yes and the operation
 * itself did not work (patch rejected, command spawn failed); the summary
 * carries the reason so the model can correct and retry.
 */
export const WorkspaceOperationStatus = Schema.Literals([
  "completed",
  "pending-approval",
  "denied",
  "failed",
]);
export type WorkspaceOperationStatus = typeof WorkspaceOperationStatus.Type;

/**
 * One result shape for every mutating tool and for `workspace_wait`, so the
 * remote model handles approval deferral the same way regardless of which
 * tool it called. Tool-specific fields are optional and populated only on
 * `completed`.
 */
export const WorkspaceMutationResult = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  tool: WorkspaceMutationTool,
  status: WorkspaceOperationStatus,
  /** Human-readable outcome: what happened, or why it is pending/denied/failed. */
  summary: Schema.String,
  /** Workspace-relative paths touched (write/edit/patch). */
  filesChanged: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** Bash exit code; null when the process was killed by a signal or timeout. */
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  /** Bash combined output, byte-capped. */
  output: Schema.optional(Schema.String),
  /** True when the bash output hit its byte cap. */
  truncated: Schema.optional(Schema.Boolean),
});
export type WorkspaceMutationResult = typeof WorkspaceMutationResult.Type;

export const WorkspaceWriteInput = Schema.Struct({
  path: WorkspaceRelativePath.annotate({
    description: "File to create or overwrite, relative to the workspace root.",
  }),
  content: Schema.String.annotate({
    description: "Complete new file content. This replaces the whole file.",
  }),
  createDirs: Schema.optional(
    Schema.Boolean.annotate({
      description: "Create missing parent directories.",
      default: true,
    }),
  ),
});
export type WorkspaceWriteInput = typeof WorkspaceWriteInput.Type;

export const WorkspaceEditInput = Schema.Struct({
  path: WorkspaceRelativePath.annotate({
    description: "File to edit, relative to the workspace root.",
  }),
  oldText: TrimmedNonEmptyString.annotate({
    description:
      "Exact text to replace, including whitespace. Must match the file verbatim; read the file first if unsure.",
  }),
  newText: Schema.String.annotate({
    description: "Replacement text.",
  }),
  replaceAll: Schema.optional(
    Schema.Boolean.annotate({
      description: "Replace every occurrence instead of requiring exactly one.",
      default: false,
    }),
  ),
});
export type WorkspaceEditInput = typeof WorkspaceEditInput.Type;

export const WorkspacePatchInput = Schema.Struct({
  patch: TrimmedNonEmptyString.annotate({
    description:
      "Unified diff to apply, as produced by `git diff`. Paths must be workspace-relative (a/… b/…).",
  }),
});
export type WorkspacePatchInput = typeof WorkspacePatchInput.Type;

export const WorkspaceBashInput = Schema.Struct({
  command: TrimmedNonEmptyString.annotate({
    description:
      "Shell command to run in the workspace root. Runs with a minimal environment; interactive commands will hang and time out.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 180_000 })).annotate({
      description: "Milliseconds before the command is killed (1s-180s).",
      default: 30_000,
    }),
  ),
});
export type WorkspaceBashInput = typeof WorkspaceBashInput.Type;

export const WorkspaceWaitInput = Schema.Struct({
  operationId: TrimmedNonEmptyString.annotate({
    description: "Operation id returned by a mutating workspace tool.",
  }),
  waitSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })).annotate({
      description: "Seconds to wait for a decision before returning the current status (0-30).",
      default: 20,
    }),
  ),
});
export type WorkspaceWaitInput = typeof WorkspaceWaitInput.Type;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const WorkspaceBridgeErrorReason = Schema.Literals([
  "capability-unavailable",
  "thread-not-found",
  "workspace-unavailable",
  "path-not-allowed",
  "not-found",
  "not-a-file",
  "not-a-directory",
  "too-large",
  "read-failed",
  "git-unavailable",
  "operation-not-found",
  "approval-unavailable",
  "invalid-input",
]);
export type WorkspaceBridgeErrorReason = typeof WorkspaceBridgeErrorReason.Type;

export class WorkspaceBridgeError extends Schema.TaggedErrorClass<WorkspaceBridgeError>()(
  "WorkspaceBridgeError",
  {
    reason: WorkspaceBridgeErrorReason,
    description: Schema.String,
  },
) {
  override get message(): string {
    return this.description;
  }
}
