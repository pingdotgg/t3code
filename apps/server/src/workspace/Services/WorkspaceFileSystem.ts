/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import { Context } from "effect";
import type { Effect } from "effect";

import type {
  ProjectCreateDirectoryInput,
  ProjectCreateDirectoryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameEntryInput,
  ProjectRenameEntryResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@forma/contracts";
import {
  ProjectCreateDirectoryError,
  ProjectDeleteEntryError,
  ProjectFileBinaryError,
  ProjectFileNotFoundError,
  ProjectFileTooLargeError,
  ProjectFileVersionConflictError,
  ProjectReadFileError,
  ProjectRenameEntryError,
  ProjectWriteFileError,
} from "@forma/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths.ts";

/**
 * WorkspaceFileSystemShape - Service API for workspace-relative file operations.
 */
export interface WorkspaceFileSystemShape {
  /**
   * Read a text file relative to the workspace root.
   *
   * Rejects binary and oversized files.
   */
  readonly readFile: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<
    ProjectReadFileResult,
    | ProjectFileBinaryError
    | ProjectFileNotFoundError
    | ProjectFileTooLargeError
    | ProjectReadFileError
    | WorkspacePathOutsideRootError
  >;

  /**
   * Write a file relative to the workspace root.
   *
   * Creates parent directories as needed and rejects paths that escape the
   * workspace root.
   */
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    ProjectFileVersionConflictError | ProjectWriteFileError | WorkspacePathOutsideRootError
  >;

  readonly createDirectory: (
    input: ProjectCreateDirectoryInput,
  ) => Effect.Effect<
    ProjectCreateDirectoryResult,
    ProjectCreateDirectoryError | WorkspacePathOutsideRootError
  >;

  readonly renameEntry: (
    input: ProjectRenameEntryInput,
  ) => Effect.Effect<
    ProjectRenameEntryResult,
    ProjectRenameEntryError | WorkspacePathOutsideRootError
  >;

  readonly deleteEntry: (
    input: ProjectDeleteEntryInput,
  ) => Effect.Effect<
    ProjectDeleteEntryResult,
    ProjectDeleteEntryError | WorkspacePathOutsideRootError
  >;
}

/**
 * WorkspaceFileSystem - Service tag for workspace file operations.
 */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("forma/workspace/Services/WorkspaceFileSystem") {}
