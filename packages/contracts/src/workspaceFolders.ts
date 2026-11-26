import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** `git` folders are repositories with their own history; `plain` folders are only files. */
export const WorkspaceFolderState = Schema.Literals(["git", "plain", "missing"]);
export type WorkspaceFolderState = typeof WorkspaceFolderState.Type;

export const WorkspaceFolder = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  state: WorkspaceFolderState,
  /** Found inside the project folder by the server, not added by someone. */
  discovered: Schema.optional(Schema.Boolean),
});
export type WorkspaceFolder = typeof WorkspaceFolder.Type;

export const WorkspaceListFoldersInput = Schema.Struct({
  projectId: ProjectId,
});
export type WorkspaceListFoldersInput = typeof WorkspaceListFoldersInput.Type;

export const WorkspaceListFoldersResult = Schema.Struct({
  /** The repositories found inside the project folder now, then the folders someone added. */
  folders: Schema.Array(WorkspaceFolder),
});
export type WorkspaceListFoldersResult = typeof WorkspaceListFoldersResult.Type;

export const WorkspaceScanFoldersInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
});
export type WorkspaceScanFoldersInput = typeof WorkspaceScanFoldersInput.Type;

export const WorkspaceScannedFolder = Schema.Struct({
  /** Absolute path on the environment. */
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isGitRepository: Schema.Boolean,
  /** `child` sits one level under the scanned folder; `code-workspace` came from that file. */
  source: Schema.Literals(["child", "code-workspace"]),
});
export type WorkspaceScannedFolder = typeof WorkspaceScannedFolder.Type;

export const WorkspaceScanFoldersResult = Schema.Struct({
  /** Resolved path of the scanned folder. */
  workspaceRoot: TrimmedNonEmptyString,
  isGitRepository: Schema.Boolean,
  /** The `.code-workspace` file the listed folders came from, when one was read. */
  codeWorkspaceFile: Schema.NullOr(TrimmedNonEmptyString),
  folders: Schema.Array(WorkspaceScannedFolder),
});
export type WorkspaceScanFoldersResult = typeof WorkspaceScanFoldersResult.Type;

/** A new worktree thread isolates every tracked repository by default only up to this many. */
export const TASK_FOLDER_DEFAULT_REPOSITORIES_MAX = 8;

/** A tracked repository's own worktree inside a thread's task folder. */
export const TaskFolderRepository = Schema.Struct({
  /** The tracked folder's path, as the project stores it. */
  repositoryPath: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type TaskFolderRepository = typeof TaskFolderRepository.Type;

/**
 * The folder a worktree thread of a multi-repository project works in: the project folder and
 * each chosen repository at the same relative places, every repository on the thread's branch.
 */
export const TaskFolder = Schema.Struct({
  root: TrimmedNonEmptyString,
  projectId: ProjectId,
  /** The project folder this was laid out from. */
  projectRoot: TrimmedNonEmptyString,
  /** The folder `root` stands in for: a path below it sits at the same place below `root`. */
  anchor: TrimmedNonEmptyString,
  /** Where the project folder sits inside `root`: the thread's `worktreePath`. */
  projectPath: TrimmedNonEmptyString,
  /** False when the project folder is not a repository: `projectPath` then links to its files. */
  projectIsWorktree: Schema.Boolean,
  repositories: Schema.Array(TaskFolderRepository),
});
export type TaskFolder = typeof TaskFolder.Type;

export const WorkspaceTaskFolderInput = Schema.Struct({
  /** A thread's `worktreePath`, or any path inside its task folder. */
  worktreePath: TrimmedNonEmptyString,
});
export type WorkspaceTaskFolderInput = typeof WorkspaceTaskFolderInput.Type;

export const WorkspaceTaskFolderResult = Schema.Struct({
  /** Null for a thread whose worktree is a single checkout. */
  taskFolder: Schema.NullOr(TaskFolder),
});
export type WorkspaceTaskFolderResult = typeof WorkspaceTaskFolderResult.Type;

export const WorkspaceAddTaskFolderRepositoryInput = Schema.Struct({
  threadId: ThreadId,
  /** One of the project's tracked Git folders. */
  repositoryPath: TrimmedNonEmptyString,
});
export type WorkspaceAddTaskFolderRepositoryInput =
  typeof WorkspaceAddTaskFolderRepositoryInput.Type;

export const WorktreeLayoutCommandKind = Schema.Literals(["create", "remove"]);
export type WorktreeLayoutCommandKind = typeof WorktreeLayoutCommandKind.Type;

/** One of a project's `worktreeLayout` commands, as its `t3.json` holds it now. */
export const WorktreeLayoutCommand = Schema.Struct({
  kind: WorktreeLayoutCommandKind,
  command: Schema.String,
  /** A person approved this exact text for this project. */
  approved: Schema.Boolean,
});
export type WorktreeLayoutCommand = typeof WorktreeLayoutCommand.Type;

export const WorkspaceLayoutCommandsInput = Schema.Struct({
  projectId: ProjectId,
});
export type WorkspaceLayoutCommandsInput = typeof WorkspaceLayoutCommandsInput.Type;

export const WorkspaceLayoutCommandsResult = Schema.Struct({
  /** Empty for a project that declares no `worktreeLayout`. */
  commands: Schema.Array(WorktreeLayoutCommand),
});
export type WorkspaceLayoutCommandsResult = typeof WorkspaceLayoutCommandsResult.Type;

export const WorkspaceApproveLayoutCommandsInput = Schema.Struct({
  projectId: ProjectId,
  approvals: Schema.Array(
    Schema.Struct({
      kind: WorktreeLayoutCommandKind,
      /** The text the person was shown, so a file that changed since is not approved unseen. Null withdraws the approval. */
      command: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
    }),
  ),
});
export type WorkspaceApproveLayoutCommandsInput = typeof WorkspaceApproveLayoutCommandsInput.Type;

/**
 * One command a folder's Claude Code settings ask Claude Code to run by itself, as the file holds
 * it now: a hook, or a helper command such as `apiKeyHelper`.
 */
export const ClaudeProjectHook = Schema.Struct({
  kind: Schema.Literals(["hook", "helper"]),
  /** `project` is `.claude/settings.json`; `local` is `.claude/settings.local.json`. */
  source: Schema.Literals(["project", "local"]),
  /** The Claude Code event a hook runs on, such as `SessionStart`; a helper's settings key. */
  event: Schema.String,
  /** The tools or sources the hook is limited to, when the file names any. */
  matcher: Schema.optional(Schema.String),
  /** What runs: the command, or the URL or prompt of a hook that is not a command. */
  detail: Schema.String,
});
export type ClaudeProjectHook = typeof ClaudeProjectHook.Type;

/**
 * - `none`: the folder declares no hooks or helper commands.
 * - `approved`: a person approved exactly these hooks for this project.
 * - `needs-approval`: nobody approved them as they are now.
 * - `off`: the administrator's policy turns project hooks off.
 */
export const ClaudeProjectHooksStatus = Schema.Literals([
  "none",
  "approved",
  "needs-approval",
  "off",
]);
export type ClaudeProjectHooksStatus = typeof ClaudeProjectHooksStatus.Type;

export const WorkspaceClaudeProjectHooksInput = Schema.Struct({
  projectId: ProjectId,
  /** Reads the folder this thread works in. Without it, the project's own folder. */
  threadId: Schema.optional(ThreadId),
});
export type WorkspaceClaudeProjectHooksInput = typeof WorkspaceClaudeProjectHooksInput.Type;

export const WorkspaceClaudeProjectHooksResult = Schema.Struct({
  status: ClaudeProjectHooksStatus,
  hooks: Schema.Array(ClaudeProjectHook),
  /** Names the hooks shown, so an approval covers what the person saw and nothing newer. */
  hooksHash: Schema.String,
  /**
   * How many sets of hooks are approved for the project. More than this folder accounts for when
   * another checkout of the project, such as a worktree on another branch, had its own approved.
   */
  approvals: Schema.Number,
});
export type WorkspaceClaudeProjectHooksResult = typeof WorkspaceClaudeProjectHooksResult.Type;

export const WorkspaceApproveClaudeProjectHooksInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  /** `hooksHash` of the hooks the person was shown. Null withdraws every approval of the project. */
  hooksHash: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
});
export type WorkspaceApproveClaudeProjectHooksInput =
  typeof WorkspaceApproveClaudeProjectHooksInput.Type;

export class ClaudeProjectHooksError extends Schema.TaggedError<ClaudeProjectHooksError>()(
  "ClaudeProjectHooksError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TaskFolderError extends Schema.TaggedError<TaskFolderError>()("TaskFolderError", {
  operation: Schema.Literals(["plan", "create", "add-repository", "remove", "read", "approve"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export class WorkspaceFoldersError extends Schema.TaggedError<WorkspaceFoldersError>()(
  "WorkspaceFoldersError",
  {
    operation: Schema.Literals(["list", "scan"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
