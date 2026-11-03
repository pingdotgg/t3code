import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** `home` is the project's own folder (or its worktree); `repository` is a tracked Git folder. */
export const WorkspaceRepositoryKind = Schema.Literals(["home", "repository"]);
export type WorkspaceRepositoryKind = typeof WorkspaceRepositoryKind.Type;

export const WorkspaceRepository = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Where Git, diffs and file reads run: the worktree in a task folder, else the real checkout. */
  cwd: TrimmedNonEmptyString,
  /** The home folder or the project's tracked path. Equal to `cwd` outside task folders. */
  originalPath: TrimmedNonEmptyString,
  /** From the thread's cwd, with `/` separators. Empty for the home repo. */
  relativePath: Schema.String,
  kind: WorkspaceRepositoryKind,
  /** The tracked folder is gone from disk; the UI offers Locate or Remove. */
  missing: Schema.Boolean,
});
export type WorkspaceRepository = typeof WorkspaceRepository.Type;

/** A plain tracked folder outside the home folder: read-only reference for the agent. */
export const WorkspaceReferenceFolder = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  missing: Schema.Boolean,
});
export type WorkspaceReferenceFolder = typeof WorkspaceReferenceFolder.Type;

export const WorkspaceTaskFolder = Schema.Struct({
  root: TrimmedNonEmptyString,
  homeWorktreePath: TrimmedNonEmptyString,
});
export type WorkspaceTaskFolder = typeof WorkspaceTaskFolder.Type;

export const WorkspaceListRepositoriesInput = Schema.Struct({
  projectId: ProjectId,
  /** The thread's cwd: its worktree path, or the project's home folder. */
  cwd: TrimmedNonEmptyString,
});
export type WorkspaceListRepositoriesInput = typeof WorkspaceListRepositoriesInput.Type;

export const WorkspaceListRepositoriesResult = Schema.Struct({
  /** Git repos the thread works in. Single-repo projects list only the home repo. */
  repositories: Schema.Array(WorkspaceRepository),
  references: Schema.Array(WorkspaceReferenceFolder),
  taskFolder: Schema.NullOr(WorkspaceTaskFolder),
});
export type WorkspaceListRepositoriesResult = typeof WorkspaceListRepositoriesResult.Type;

export const WorkspaceScanFoldersInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
});
export type WorkspaceScanFoldersInput = typeof WorkspaceScanFoldersInput.Type;

export const WorkspaceScannedFolder = Schema.Struct({
  /** Resolved absolute path. */
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isGitRepository: Schema.Boolean,
  source: Schema.Literals(["child", "code-workspace"]),
});
export type WorkspaceScannedFolder = typeof WorkspaceScannedFolder.Type;

export const WorkspaceScanFoldersResult = Schema.Struct({
  homeIsGitRepository: Schema.Boolean,
  /** The `.code-workspace` file the folders came from, when one was read. */
  codeWorkspaceFile: Schema.NullOr(TrimmedNonEmptyString),
  folders: Schema.Array(WorkspaceScannedFolder),
});
export type WorkspaceScanFoldersResult = typeof WorkspaceScanFoldersResult.Type;

export const WorkspaceHomeGitInitInput = Schema.Struct({
  projectId: ProjectId,
});
export type WorkspaceHomeGitInitInput = typeof WorkspaceHomeGitInitInput.Type;

export const WORKSPACE_HOME_GIT_INIT_PREVIEW_FILES_MAX = 200;

export const WorkspaceHomeGitInitPreview = Schema.Struct({
  /** Paths relative to the home folder that the first commit will include. */
  files: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMaxLength(WORKSPACE_HOME_GIT_INIT_PREVIEW_FILES_MAX),
  ),
  fileCount: NonNegativeInt,
  /** Lines the new `.gitignore` will hold: the tracked child repos and `.env*`. */
  ignoreEntries: Schema.Array(TrimmedNonEmptyString),
});
export type WorkspaceHomeGitInitPreview = typeof WorkspaceHomeGitInitPreview.Type;

export const WorkspaceInitializeHomeGitResult = Schema.Struct({
  commitSha: TrimmedNonEmptyString,
  fileCount: NonNegativeInt,
});
export type WorkspaceInitializeHomeGitResult = typeof WorkspaceInitializeHomeGitResult.Type;

export class WorkspaceRepositoriesError extends Schema.TaggedError<WorkspaceRepositoriesError>()(
  "WorkspaceRepositoriesError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
