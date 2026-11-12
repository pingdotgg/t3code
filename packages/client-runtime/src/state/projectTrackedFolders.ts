import {
  PROJECT_TRACKED_FOLDERS_MAX,
  type ProjectTrackedFolder,
  type WorkspaceScannedFolder,
} from "@t3tools/contracts";

const TRACKED_FOLDER_NAME_MAX = 128;

/** Scanned folders a project does not track yet, in scan order. */
export function untrackedScannedFolders(
  tracked: ReadonlyArray<ProjectTrackedFolder>,
  scanned: ReadonlyArray<WorkspaceScannedFolder>,
): ReadonlyArray<WorkspaceScannedFolder> {
  const seen = new Set(tracked.map((folder) => folder.path));
  return scanned.filter((folder) => {
    if (seen.has(folder.path)) return false;
    seen.add(folder.path);
    return true;
  });
}

/** Every scanned folder is selected until its path is deselected. */
export function trackedFoldersFromSelection(
  scanned: ReadonlyArray<WorkspaceScannedFolder>,
  deselectedPaths: ReadonlySet<string>,
): ReadonlyArray<ProjectTrackedFolder> {
  return scanned
    .filter((folder) => !deselectedPaths.has(folder.path))
    .map((folder) => ({
      path: folder.path,
      name: folder.name.slice(0, TRACKED_FOLDER_NAME_MAX).trim() || folder.path,
    }));
}

/**
 * The list to send as a project's `trackedFolders` after adding folders. Tracked folders keep
 * their place and name; `null` means the result would pass the server's limit.
 */
export function appendTrackedFolders(
  tracked: ReadonlyArray<ProjectTrackedFolder>,
  added: ReadonlyArray<ProjectTrackedFolder>,
): ReadonlyArray<ProjectTrackedFolder> | null {
  const seen = new Set(tracked.map((folder) => folder.path));
  const next = [...tracked];
  for (const folder of added) {
    if (seen.has(folder.path)) continue;
    seen.add(folder.path);
    next.push(folder);
  }
  return next.length > PROJECT_TRACKED_FOLDERS_MAX ? null : next;
}
