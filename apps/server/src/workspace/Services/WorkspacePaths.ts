/**
 * WorkspacePaths - Effect service contract for workspace path handling.
 *
 * Owns normalization and validation of workspace roots plus safe resolution of
 * workspace-root-relative paths.
 *
 * @module WorkspacePaths
 */
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class WorkspaceRootNotExistsError extends Schema.TaggedErrorClass<WorkspaceRootNotExistsError>()(
  "WorkspaceRootNotExistsError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root does not exist: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootCreateFailedError extends Schema.TaggedErrorClass<WorkspaceRootCreateFailedError>()(
  "WorkspaceRootCreateFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to create workspace root: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootNotDirectoryError extends Schema.TaggedErrorClass<WorkspaceRootNotDirectoryError>()(
  "WorkspaceRootNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root is not a directory: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspacePathOutsideRootError extends Schema.TaggedErrorClass<WorkspacePathOutsideRootError>()(
  "WorkspacePathOutsideRootError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file path must be relative to the project root: ${this.relativePath}`;
  }
}

export const WorkspacePathsError = Schema.Union([
  WorkspaceRootNotExistsError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspacePathOutsideRootError,
]);
export type WorkspacePathsError = typeof WorkspacePathsError.Type;

/**
 * WorkspacePathsShape - Service API for workspace path normalization and guards.
 */
export interface WorkspacePathsShape {
  /**
   * Normalize a user-provided workspace root and verify it exists as a directory.
   */
  readonly normalizeWorkspaceRoot: (
    workspaceRoot: string,
    options?: { readonly createIfMissing?: boolean },
  ) => Effect.Effect<
    string,
    WorkspaceRootNotExistsError | WorkspaceRootCreateFailedError | WorkspaceRootNotDirectoryError
  >;

  /**
   * Resolve a relative path within a validated workspace root.
   *
   * Rejects absolute paths and traversal attempts outside the workspace root.
   */
  readonly resolveRelativePathWithinRoot: (input: {
    workspaceRoot: string;
    relativePath: string;
  }) => Effect.Effect<
    { absolutePath: string; relativePath: string },
    WorkspacePathOutsideRootError
  >;
}

/**
 * WorkspacePaths - Service tag for workspace path normalization and resolution.
 */
export class WorkspacePaths extends Context.Service<WorkspacePaths, WorkspacePathsShape>()(
  "t3/workspace/Services/WorkspacePaths",
) {}
