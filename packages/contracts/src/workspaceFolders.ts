import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** `git` folders are repositories with their own history; `plain` folders are only files. */
export const WorkspaceFolderState = Schema.Literals(["git", "plain", "missing"]);
export type WorkspaceFolderState = typeof WorkspaceFolderState.Type;

export const WorkspaceFolder = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  state: WorkspaceFolderState,
});
export type WorkspaceFolder = typeof WorkspaceFolder.Type;

export const WorkspaceListFoldersInput = Schema.Struct({
  projectId: ProjectId,
});
export type WorkspaceListFoldersInput = typeof WorkspaceListFoldersInput.Type;

export const WorkspaceListFoldersResult = Schema.Struct({
  /** The project's tracked folders, in their stored order. */
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

export class TaskFolderError extends Schema.TaggedError<TaskFolderError>()("TaskFolderError", {
  operation: Schema.Literals(["plan", "create", "add-repository", "remove", "read"]),
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
