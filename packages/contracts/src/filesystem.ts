import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
  /** When true, also list `.code-workspace` files alongside directories. */
  includeWorkspaceFiles: Schema.optional(Schema.Boolean),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntryKind = Schema.Literals(["directory", "workspaceFile"]);
export type FilesystemBrowseEntryKind = typeof FilesystemBrowseEntryKind.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
  /** Absent ⇒ `"directory"` for back-compat with older servers. */
  kind: Schema.optional(FilesystemBrowseEntryKind),
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export const FilesystemBrowseFailure = Schema.Literals([
  "windows_path_unsupported",
  "current_project_required",
  "read_directory_failed",
]);
export type FilesystemBrowseFailure = typeof FilesystemBrowseFailure.Type;

function decodedFilesystemBrowseErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class FilesystemBrowseError extends Schema.TaggedErrorClass<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  {
    partialPath: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(FilesystemBrowseFailure),
    parentPath: Schema.optional(TrimmedNonEmptyString),
    platform: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // Structured diagnostics stay optional for rolling compatibility with legacy message-only
  // payloads, while new call sites must provide the request context and failure classification.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly partialPath: string;
    readonly cwd?: string | undefined;
    readonly failure: FilesystemBrowseFailure;
    readonly parentPath?: string;
    readonly platform?: string;
    readonly cause?: unknown;
  }) {
    const cwd = props.cwd === undefined ? "" : ` from '${props.cwd}'`;
    super({
      ...props,
      message:
        decodedFilesystemBrowseErrorMessage(props) ??
        `Failed to browse filesystem path '${props.partialPath}'${cwd}.`,
    } as any);
  }
}

export const FilesystemScanGitReposInput = Schema.Struct({
  parentPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
});
export type FilesystemScanGitReposInput = typeof FilesystemScanGitReposInput.Type;

export const FilesystemScanGitReposChild = Schema.Struct({
  name: TrimmedNonEmptyString,
  absolutePath: TrimmedNonEmptyString,
  hasGit: Schema.Boolean,
});
export type FilesystemScanGitReposChild = typeof FilesystemScanGitReposChild.Type;

export const FilesystemScanGitReposResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  parentHasGit: Schema.Boolean,
  children: Schema.Array(FilesystemScanGitReposChild),
});
export type FilesystemScanGitReposResult = typeof FilesystemScanGitReposResult.Type;

export class FilesystemScanGitReposError extends Schema.TaggedErrorClass<FilesystemScanGitReposError>()(
  "FilesystemScanGitReposError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const FilesystemReadWorkspaceFileInput = Schema.Struct({
  workspaceFilePath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
});
export type FilesystemReadWorkspaceFileInput = typeof FilesystemReadWorkspaceFileInput.Type;

export const FilesystemReadWorkspaceFileFolder = Schema.Struct({
  /** The `path` exactly as written in the file (relative, absolute, or `~`-prefixed). */
  rawPath: Schema.String,
  /** Display name — the explicit `name` field if present, else the resolved basename. */
  name: Schema.String,
  /** Absolute, normalized path (relative paths resolved against the file's directory). */
  absolutePath: Schema.String,
  /** Whether the resolved folder currently exists on disk as a directory. */
  exists: Schema.Boolean,
  /** Whether the resolved folder is a git repository. */
  isGit: Schema.Boolean,
});
export type FilesystemReadWorkspaceFileFolder = typeof FilesystemReadWorkspaceFileFolder.Type;

export const FilesystemReadWorkspaceFileResult = Schema.Struct({
  /** Absolute, normalized path to the `.code-workspace` file. */
  workspaceFilePath: TrimmedNonEmptyString,
  /** Directory containing the file — the project's `workspaceRoot` anchor. */
  anchorDir: TrimmedNonEmptyString,
  /** Every resolved folder entry, in file order. Missing/non-git folders are surfaced. */
  folders: Schema.Array(FilesystemReadWorkspaceFileFolder),
  /** Absolute paths of folders that exist and are git repos — the project's `repoRoots`. */
  repoRoots: Schema.Array(Schema.String),
});
export type FilesystemReadWorkspaceFileResult = typeof FilesystemReadWorkspaceFileResult.Type;

export class FilesystemReadWorkspaceFileError extends Schema.TaggedErrorClass<FilesystemReadWorkspaceFileError>()(
  "FilesystemReadWorkspaceFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** One desired `folders[]` entry to write back into a `.code-workspace`. */
export const FilesystemWriteWorkspaceFileFolder = Schema.Struct({
  /** Path to record, exactly as it should appear in the file (relative or absolute). */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  /** Optional display name; omitted ⇒ VS Code derives it from the basename. */
  name: Schema.optional(TrimmedNonEmptyString),
});
export type FilesystemWriteWorkspaceFileFolder = typeof FilesystemWriteWorkspaceFileFolder.Type;

export const FilesystemWriteWorkspaceFileInput = Schema.Struct({
  workspaceFilePath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  /** The full replacement folder list. Unknown top-level keys (e.g. `settings`) are preserved. */
  folders: Schema.Array(FilesystemWriteWorkspaceFileFolder),
});
export type FilesystemWriteWorkspaceFileInput = typeof FilesystemWriteWorkspaceFileInput.Type;

/** Result mirrors a fresh read: the file is re-resolved after the write. */
export const FilesystemWriteWorkspaceFileResult = FilesystemReadWorkspaceFileResult;
export type FilesystemWriteWorkspaceFileResult = typeof FilesystemWriteWorkspaceFileResult.Type;

export class FilesystemWriteWorkspaceFileError extends Schema.TaggedErrorClass<FilesystemWriteWorkspaceFileError>()(
  "FilesystemWriteWorkspaceFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
