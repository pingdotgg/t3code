import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadRepoWorktree } from "./orchestrationV2.ts";

/**
 * Changing the thread's workspace detaches the live provider session, so the
 * current turn ends shortly after the handoff is recorded; the conversation
 * continues inside the worktree on the thread's next run.
 */
export const WorktreeMcpHandoffInput = Schema.Struct({
  branch: TrimmedNonEmptyString.annotate({
    description: "Branch name to create for the worktree (e.g. 'feature/my-change').",
  }),
  baseRef: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch or ref the worktree branch starts from. Defaults to the branch currently checked out in the project workspace.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Fetch origin and start the worktree branch from the remote-tracking commit of baseRef instead of the local ref. Defaults to the server's 'new worktrees start from origin' setting.",
    }),
  ),
  path: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isPattern(/^(?:[A-Za-z]:[\\/]|[\\/])/)).annotate({
      description:
        "Absolute filesystem path for the new worktree. Relative paths are rejected. Defaults to the server-managed worktrees directory.",
    }),
  ),
  runSetupScript: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Run the project's configured setup script in the new worktree after handoff. Defaults to true.",
    }),
  ),
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description:
        "Message queued as the thread's next turn after the handoff. The handoff detaches the current provider session, so pass the remaining work here to automatically resume inside the worktree; omit it to stop after the handoff and wait for the next message.",
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
  attached: Schema.Boolean.annotate({
    description: "True when this thread is already attached to a git worktree.",
  }),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  projectWorkspaceRoot: TrimmedNonEmptyString.annotate({
    description: "Root of the project's main workspace checkout.",
  }),
  defaultStartFromOrigin: Schema.Boolean.annotate({
    description: "Server default used by t3_worktree_handoff when startFromOrigin is omitted.",
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
        "Branch or ref a new branch starts from. Required when the branch does not exist yet. Ignored when it exists.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Fetch origin and start a new branch from the remote-tracking commit of baseRef. Defaults to the project's 'new worktrees start from origin' setting.",
    }),
  ),
  useExistingBranch: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Set true to continue a branch that already exists locally or on origin but has no worktree. Without it such a branch is refused, so new work never lands on an existing branch by accident.",
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
      description:
        "Stage the new gitlink in the parent worktree. Defaults to true. Commit it with ordinary git.",
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
