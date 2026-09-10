import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;
const FILESYSTEM_DIRECTORY_NAME_MAX_LENGTH = 255;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
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

function decodedFilesystemErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class FilesystemBrowseError extends Schema.TaggedError<FilesystemBrowseError>()(
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
        decodedFilesystemErrorMessage(props) ??
        `Failed to browse filesystem path '${props.partialPath}'${cwd}.`,
    } as any);
  }
}

/**
 * Creates one directory inside an already browsed directory. `name` is a single
 * path segment so the picker can only ever add a child of what it is showing;
 * `parentPath` accepts the same forms as a browse path (`~/`, absolute, or
 * project-relative with `cwd`).
 */
export const FilesystemCreateDirectoryInput = Schema.Struct({
  parentPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_DIRECTORY_NAME_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemCreateDirectoryInput = typeof FilesystemCreateDirectoryInput.Type;

export const FilesystemCreateDirectoryResult = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type FilesystemCreateDirectoryResult = typeof FilesystemCreateDirectoryResult.Type;

export const FilesystemCreateDirectoryFailure = Schema.Literals([
  "windows_path_unsupported",
  "current_project_required",
  "invalid_directory_name",
  "create_directory_failed",
]);
export type FilesystemCreateDirectoryFailure = typeof FilesystemCreateDirectoryFailure.Type;

export class FilesystemCreateDirectoryError extends Schema.TaggedError<FilesystemCreateDirectoryError>()(
  "FilesystemCreateDirectoryError",
  {
    parentPath: Schema.optional(TrimmedNonEmptyString),
    name: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(FilesystemCreateDirectoryFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    platform: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // Structured diagnostics stay optional so a client can still decode this
  // error from a server that only sends a message, exactly like its browse
  // sibling above.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly parentPath: string;
    readonly name: string;
    readonly cwd?: string | undefined;
    readonly failure: FilesystemCreateDirectoryFailure;
    readonly resolvedPath?: string;
    readonly platform?: string;
    readonly cause?: unknown;
  }) {
    const cwd = props.cwd === undefined ? "" : ` from '${props.cwd}'`;
    super({
      ...props,
      message:
        decodedFilesystemErrorMessage(props) ??
        `Failed to create folder '${props.name}' in '${props.parentPath}'${cwd}.`,
    } as any);
  }
}
