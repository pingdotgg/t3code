import type { ProjectReadFileError } from "@t3tools/contracts";

export interface FilePreviewErrorDetails {
  readonly title: string;
  readonly explanation: string;
  readonly attemptedPath: string | null;
  readonly duplicateWorkspacePrefixHint: string | null;
}

/**
 * Checks if a relative path mistakenly begins with the workspace folder name.
 * e.g. cwd = "/Users/alice/CMU/33120" and relativePath = "33120/film-critique/outline.md"
 */
export function detectDuplicatedWorkspacePrefix(
  cwd?: string | null | undefined,
  relativePath?: string | null | undefined,
): string | null {
  if (!cwd || !relativePath) return null;

  const cwdSegments = cwd.split(/[\\/]/).filter(Boolean);
  const workspaceFolder = cwdSegments[cwdSegments.length - 1];
  if (!workspaceFolder) return null;

  const relNormalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const relSegments = relNormalized.split("/");

  // Must have more than 1 segment (i.e. pointing to a file inside the duplicated folder)
  if (relSegments.length > 1 && relSegments[0] === workspaceFolder) {
    return workspaceFolder;
  }
  return null;
}

/**
 * Resolves user-friendly error title, description, attempted path, and hints
 * from structured project file read errors.
 */
export function getFilePreviewErrorDetails(options: {
  readonly cwd?: string | null | undefined;
  readonly relativePath?: string | null | undefined;
  readonly readError?: ProjectReadFileError | null | undefined;
  readonly fallbackError?: string | null | undefined;
}): FilePreviewErrorDetails {
  const { cwd, relativePath, readError, fallbackError } = options;

  const attemptedPath = readError?.resolvedPath ?? readError?.operationPath ?? null;
  const duplicateFolder = detectDuplicatedWorkspacePrefix(cwd, relativePath);
  const duplicateWorkspacePrefixHint = duplicateFolder
    ? `The path begins with "${duplicateFolder}", which matches the workspace folder name. The link may have mistakenly included the workspace folder in its relative path.`
    : null;

  const failure = readError?.failure;

  switch (failure) {
    case "path_not_file":
      return {
        title: "Not a regular file",
        explanation: "The path is a directory or special file, not a regular file.",
        attemptedPath,
        duplicateWorkspacePrefixHint,
      };
    case "binary_file":
      return {
        title: "Binary file",
        explanation: "The file is binary and cannot be displayed in text preview.",
        attemptedPath,
        duplicateWorkspacePrefixHint,
      };
    case "workspace_path_outside_root":
      return {
        title: "Path outside workspace",
        explanation: "The requested path is outside the workspace root directory.",
        attemptedPath,
        duplicateWorkspacePrefixHint,
      };
    case "resolved_path_outside_root":
      return {
        title: "Resolved path outside workspace",
        explanation: "The path resolves to a location outside the workspace root directory.",
        attemptedPath,
        duplicateWorkspacePrefixHint,
      };
    case "operation_failed":
      return {
        title: "Failed to read file",
        explanation: "The file could not be accessed or read.",
        attemptedPath,
        duplicateWorkspacePrefixHint,
      };
    default:
      return {
        title: "Failed to read file",
        explanation:
          fallbackError && fallbackError !== "Workspace query failed."
            ? fallbackError
            : "An error occurred while reading the file.",
        attemptedPath,
        duplicateWorkspacePrefixHint,
      };
  }
}
