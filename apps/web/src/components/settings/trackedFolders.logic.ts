import type { ProjectTrackedFolder } from "@t3tools/contracts";
import { hasTrailingPathSeparator } from "@t3tools/client-runtime/state/projects";
import {
  fileBasename,
  isAbsolutePath,
  normalizeProjectPathForDispatch,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

/** Relative to the project folder when inside it, absolute otherwise. */
export function trackedFolderDisplayPath(path: string, workspaceRoot: string): string {
  const relative = workspaceRelativeFilePath(path, workspaceRoot);
  return relative === null || relative === "." ? path : relative;
}

/**
 * The folder a typed path adds. A listing resolves `~/` and names the directory exactly; without
 * one, only an absolute path is safe to send.
 */
export function resolveTrackedFolderInput(input: {
  readonly query: string;
  readonly listedDirectoryPath: string | null;
  readonly exactEntryPath: string | null;
}): ProjectTrackedFolder | null {
  const query = input.query.trim();
  if (query.length === 0) return null;
  const rawPath =
    input.exactEntryPath ??
    (hasTrailingPathSeparator(query) && input.listedDirectoryPath !== null
      ? input.listedDirectoryPath
      : isAbsolutePath(query)
        ? query
        : null);
  if (rawPath === null) return null;
  const path = normalizeProjectPathForDispatch(rawPath);
  // `ProjectTrackedFolder.name` takes at most 128 characters.
  const name = fileBasename(path).slice(0, 128).trim();
  if (path.length === 0 || name.length === 0) return null;
  return { path, name };
}
