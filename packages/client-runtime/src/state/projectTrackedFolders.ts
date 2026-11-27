import {
  PROJECT_TRACKED_FOLDERS_MAX,
  type ProjectTrackedFolder,
  type WorkspaceScannedFolder,
} from "@t3tools/contracts";

/**
 * Folders a project's `.code-workspace` file lists that the project does not cover yet. The
 * server finds repositories inside the project folder itself; a listed folder outside it is only
 * offered, since adding it lets agents work somewhere new.
 */
export function suggestedTrackedFolders(
  tracked: ReadonlyArray<ProjectTrackedFolder>,
  scanned: ReadonlyArray<WorkspaceScannedFolder>,
): ReadonlyArray<ProjectTrackedFolder> {
  const seen = new Set(tracked.map((folder) => folder.path));
  return scanned.flatMap((folder) => {
    if (folder.source !== "code-workspace" || seen.has(folder.path)) return [];
    seen.add(folder.path);
    // The project schema caps a name's length.
    return [{ path: folder.path, name: folder.name.slice(0, 128).trim() || folder.path }];
  });
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
