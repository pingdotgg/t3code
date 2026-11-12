import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
