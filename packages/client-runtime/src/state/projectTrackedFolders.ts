import {
  isTrackedFolderRule,
  PROJECT_TRACKED_FOLDERS_MAX,
  trackedFolderCovers,
  type ProjectTrackedFolder,
  type WorkspaceScannedFolder,
} from "@t3tools/contracts";

const TRACKED_FOLDER_NAME_MAX = 128;

const depth = (folderPath: string) => folderPath.split(/[\\/]/).filter(Boolean).length;

/** Whether a rule the project tracks already follows this folder. */
export function isFollowedByRule(
  tracked: ReadonlyArray<ProjectTrackedFolder>,
  folderPath: string,
): boolean {
  return tracked.some(
    (rule) =>
      isTrackedFolderRule(rule.path) &&
      depth(rule.path) === depth(folderPath) &&
      trackedFolderCovers(rule.path, folderPath),
  );
}

/** Scanned folders a project does not track yet, by name or by rule, in scan order. */
export function untrackedScannedFolders(
  tracked: ReadonlyArray<ProjectTrackedFolder>,
  scanned: ReadonlyArray<WorkspaceScannedFolder>,
): ReadonlyArray<WorkspaceScannedFolder> {
  const seen = new Set(tracked.map((folder) => folder.path));
  return scanned.filter((folder) => {
    if (seen.has(folder.path) || isFollowedByRule(tracked, folder.path)) return false;
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

/**
 * The tracked list that keeps following a scanned folder: one rule per folder the repositories
 * sit in, so later clones are picked up. Folders a workspace file lists stay named.
 */
export function followedTrackedFolders(input: {
  readonly scanned: ReadonlyArray<WorkspaceScannedFolder>;
}): ReadonlyArray<ProjectTrackedFolder> {
  const followed: ProjectTrackedFolder[] = [];
  const seen = new Set<string>();
  for (const folder of input.scanned) {
    const cut = Math.max(folder.path.lastIndexOf("/"), folder.path.lastIndexOf("\\"));
    const rule = `${folder.path.slice(0, cut + 1)}*`;
    const entry =
      folder.source === "child" && cut > 0
        ? // Named by its last two segments: `src/*` says more than `*`.
          { path: rule, name: rule.split(/[\\/]/).slice(-2).join("/") }
        : { path: folder.path, name: folder.name };
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    followed.push(entry);
  }
  return followed;
}

/**
 * A project's tracked list once it follows a scan: the rules that cover what the scan found, and
 * the folders the scan did not reach. Older rules and the scanned folders' own entries go.
 */
export function trackedFoldersFollowingScan(input: {
  readonly tracked: ReadonlyArray<ProjectTrackedFolder>;
  readonly scanned: ReadonlyArray<WorkspaceScannedFolder>;
}): ReadonlyArray<ProjectTrackedFolder> {
  const scannedPaths = new Set(input.scanned.map((folder) => folder.path));
  return [
    ...input.tracked.filter(
      (folder) => !isTrackedFolderRule(folder.path) && !scannedPaths.has(folder.path),
    ),
    ...followedTrackedFolders(input),
  ];
}
