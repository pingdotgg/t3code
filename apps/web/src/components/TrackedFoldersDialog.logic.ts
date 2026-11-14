import type { ProjectTrackedFolder, WorkspaceScannedFolder } from "@t3tools/contracts";
import { hasTrailingPathSeparator } from "@t3tools/client-runtime/state/projects";
import {
  fileBasename,
  isAbsolutePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

export const TRACKED_FOLDERS_FILTER_THRESHOLD = 8;

/** Relative to the project folder when inside it, absolute otherwise. */
export function trackedFolderDisplayPath(path: string, workspaceRoot: string): string {
  const relative = workspaceRelativeFilePath(path, workspaceRoot);
  return relative === null || relative === "." ? path : relative;
}

export function filterScannedFolders(
  folders: ReadonlyArray<WorkspaceScannedFolder>,
  query: string,
): ReadonlyArray<WorkspaceScannedFolder> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return folders;
  return folders.filter(
    (folder) =>
      folder.name.toLowerCase().includes(needle) || folder.path.toLowerCase().includes(needle),
  );
}

/** Scanned paths that the project does not track yet. */
export function untrackedScannedPaths(
  tracked: ReadonlyArray<ProjectTrackedFolder>,
  scanned: ReadonlyArray<WorkspaceScannedFolder>,
): ReadonlySet<string> {
  const trackedKeys = new Set(
    tracked.map((folder) => normalizeProjectPathForComparison(folder.path)),
  );
  return new Set(
    scanned
      .filter((folder) => !trackedKeys.has(normalizeProjectPathForComparison(folder.path)))
      .map((folder) => folder.path),
  );
}

/**
 * The tracked list after a rescan. A tracked folder the scan did not return stays, since it was
 * added by path or is missing right now; one the scan returned stays only while it is checked.
 */
export function mergeScannedTrackedFolders(input: {
  readonly tracked: ReadonlyArray<ProjectTrackedFolder>;
  readonly scanned: ReadonlyArray<WorkspaceScannedFolder>;
  readonly checked: ReadonlyArray<WorkspaceScannedFolder>;
}): ReadonlyArray<ProjectTrackedFolder> {
  const scannedKeys = new Set(
    input.scanned.map((folder) => normalizeProjectPathForComparison(folder.path)),
  );
  const checkedKeys = new Set(
    input.checked.map((folder) => normalizeProjectPathForComparison(folder.path)),
  );
  const seen = new Set<string>();
  const merged: ProjectTrackedFolder[] = [];
  for (const folder of input.tracked) {
    const key = normalizeProjectPathForComparison(folder.path);
    if (seen.has(key) || (scannedKeys.has(key) && !checkedKeys.has(key))) continue;
    seen.add(key);
    merged.push(folder);
  }
  for (const folder of input.checked) {
    const key = normalizeProjectPathForComparison(folder.path);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ path: folder.path, name: folder.name });
  }
  return merged;
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
  const name = fileBasename(path).trim();
  if (path.length === 0 || name.length === 0) return null;
  return { path, name };
}
