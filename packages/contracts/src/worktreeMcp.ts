import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadRepoWorktree } from "./orchestrationV2.ts";

/** Uses the managed worktree folder; handoff detaches the provider, ending this turn and resuming there next run. */
export const WorktreeMcpHandoffInput = Schema.Struct({
  branch: TrimmedNonEmptyString,
  baseRef: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Default: checked-out branch.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True: fetch, start from the remote ref; check `startedFromOrigin`. Default: server setting.",
    }),
  ),
  runSetupScript: Schema.optional(
    Schema.Boolean.annotate({
      description: "Default true.",
    }),
  ),
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description: "Work to resume in the worktree next turn. Omitted: thread waits.",
    }),
  ),
});
export type WorktreeMcpHandoffInput = typeof WorktreeMcpHandoffInput.Type;

export const WorktreeMcpSetupScriptStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
    scriptName: TrimmedNonEmptyString,
    terminalId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("no-script"),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpSetupScriptStatus = typeof WorktreeMcpSetupScriptStatus.Type;

export const WorktreeMcpContinuationStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("scheduled"),
    delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpContinuationStatus = typeof WorktreeMcpContinuationStatus.Type;

export const WorktreeMcpHandoffResult = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  baseRef: TrimmedNonEmptyString,
  startedFromOrigin: Schema.Boolean,
  setupScript: WorktreeMcpSetupScriptStatus,
  continuation: WorktreeMcpContinuationStatus,
  note: Schema.String,
});
export type WorktreeMcpHandoffResult = typeof WorktreeMcpHandoffResult.Type;

export const WorktreeMcpStatusResult = Schema.Struct({
  attached: Schema.Boolean,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  projectWorkspaceRoot: TrimmedNonEmptyString,
  defaultStartFromOrigin: Schema.Boolean.annotate({
    description: "`startFromOrigin` default for `t3_worktree_handoff`.",
  }),
  repoWorktreesEnabled: Schema.Boolean.annotate({
    description:
      "True when this project lets the thread attach worktrees of repositories inside its folder with t3_repo_worktree_ensure.",
  }),
  repoWorktrees: Schema.Array(ThreadRepoWorktree).annotate({
    description: "Repository worktrees attached to this thread.",
  }),
});
export type WorktreeMcpStatusResult = typeof WorktreeMcpStatusResult.Type;

export const WorktreeMcpRepoEnsureInput = Schema.Struct({
  repository: TrimmedNonEmptyString.annotate({
    description:
      "Git repository inside the project folder: a path relative to the folder (for example 'service' or 'service/framework' for a submodule) or an absolute path inside it. A path inside a repository means that repository's top level.",
  }),
  branch: TrimmedNonEmptyString.annotate({
    description:
      "Exact branch for the worktree. When a worktree of the same repository already has it checked out, that worktree is reused as it is, including any uncommitted edits.",
  }),
  baseRef: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch, tag, or commit a new branch starts from, resolved in the local repository unless startFromOrigin is on. For a branch only origin has, pass 'origin/<name>' or set startFromOrigin. Required when the branch does not exist yet. Ignored when it exists.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True: fetch, start a new branch from baseRef's remote ref. Default: project setting.",
    }),
  ),
  useExistingBranch: Schema.optional(
    Schema.Boolean.annotate({
      description: "True: continue a branch that exists locally or on origin but has no worktree.",
    }),
  ),
});
export type WorktreeMcpRepoEnsureInput = typeof WorktreeMcpRepoEnsureInput.Type;

export const WorktreeMcpRepoEnsureResult = Schema.Struct({
  status: Schema.Literals(["created", "reused"]).annotate({
    description:
      "created: a new worktree was made. reused: an existing worktree of this repository and branch was attached as it is.",
  }),
  branchCreated: Schema.Boolean,
  alreadyAttached: Schema.Boolean.annotate({
    description: "True when this thread already had the worktree attached.",
  }),
  uncommittedFiles: NonNegativeInt.annotate({
    description: "Files with uncommitted changes in the worktree. They are kept as they are.",
  }),
  startedFromOrigin: Schema.Boolean,
  repoWorktree: ThreadRepoWorktree,
  note: Schema.String,
});
export type WorktreeMcpRepoEnsureResult = typeof WorktreeMcpRepoEnsureResult.Type;

export const WorktreeMcpRepoDetachInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString.annotate({
    description: "Absolute path of a repository worktree attached to this thread.",
  }),
});
export type WorktreeMcpRepoDetachInput = typeof WorktreeMcpRepoDetachInput.Type;

export const WorktreeMcpRepoDetachResult = Schema.Struct({
  detached: Schema.Boolean.annotate({
    description: "False when the worktree was not attached to this thread.",
  }),
  worktreePath: TrimmedNonEmptyString,
  note: Schema.String,
});
export type WorktreeMcpRepoDetachResult = typeof WorktreeMcpRepoDetachResult.Type;

export const WorktreeMcpRepoSetSubmoduleInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString.annotate({
    description:
      "Absolute path of the parent repository's worktree, attached to this thread, whose submodule pin changes.",
  }),
  submodulePath: TrimmedNonEmptyString.annotate({
    description: "Submodule path inside that worktree as Git records it, for example 'framework'.",
  }),
  sourceWorktreePath: TrimmedNonEmptyString.annotate({
    description:
      "Absolute path of the submodule repository's worktree, attached to this thread, that holds the commit.",
  }),
  commit: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Commit to pin. Defaults to the source worktree's HEAD.",
    }),
  ),
  stage: Schema.optional(
    Schema.Boolean.annotate({
      description: "Default true.",
    }),
  ),
});
export type WorktreeMcpRepoSetSubmoduleInput = typeof WorktreeMcpRepoSetSubmoduleInput.Type;

export const WorktreeMcpRepoSetSubmoduleResult = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  submodulePath: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  previousCommit: Schema.NullOr(TrimmedNonEmptyString),
  fetched: Schema.Boolean.annotate({
    description:
      "True when the commit was copied into the parent worktree's submodule from the source worktree's repository.",
  }),
  staged: Schema.Boolean,
  note: Schema.String,
});
export type WorktreeMcpRepoSetSubmoduleResult = typeof WorktreeMcpRepoSetSubmoduleResult.Type;

export class WorktreeMcpFailure extends Schema.TaggedError<WorktreeMcpFailure>()(
  "WorktreeMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "project_not_found",
      "already_in_worktree",
      "handoff_in_progress",
      "invalid_request",
      "operation_failed",
      "thread_credential_required",
      "not_enabled",
    ]),
    message: Schema.String,
  },
) {}
