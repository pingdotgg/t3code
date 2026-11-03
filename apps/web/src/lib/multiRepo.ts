import type {
  OrchestrationV2LaunchRepository,
  ProjectTrackedFolder,
  WorkspaceListRepositoriesResult,
  WorkspaceRepository,
  WorkspaceScannedFolder,
  WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import {
  fileBasename,
  normalizeProjectPathForComparison,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

/** Above this many found folders, Add project starts with none checked and shows a filter. */
export const SCAN_PRESELECT_MAX = 8;

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function samePath(a: string, b: string) {
  return normalizeProjectPathForComparison(a) === normalizeProjectPathForComparison(b);
}

function isInsideFolder(path: string, folder: string) {
  const relative = workspaceRelativeFilePath(path, folder);
  return relative !== null && relative !== ".";
}

export function scannedFoldersTitle(folders: ReadonlyArray<WorkspaceScannedFolder>) {
  const repositories = folders.filter((folder) => folder.isGitRepository).length;
  const plain = folders.length - repositories;
  if (plain === 0) return `Found ${plural(repositories, "repository", "repositories")}`;
  if (repositories === 0) return `Found ${plural(plain, "folder", "folders")}`;
  return `Found ${plural(repositories, "repository", "repositories")} and ${plural(plain, "folder", "folders")}`;
}

export function initialScanSelection(
  folders: ReadonlyArray<WorkspaceScannedFolder>,
): ReadonlySet<string> {
  return new Set(folders.length <= SCAN_PRESELECT_MAX ? folders.map((folder) => folder.path) : []);
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

export function trackedFoldersFromScan(
  folders: ReadonlyArray<WorkspaceScannedFolder>,
  checked: ReadonlySet<string>,
): ProjectTrackedFolder[] {
  return folders
    .filter((folder) => checked.has(folder.path))
    .map((folder) => ({ path: folder.path, name: folder.name }));
}

/** Plain folders outside home are read-only for the agent; plain folders inside are part of home. */
export function folderKindLabel(
  folder: { readonly path: string; readonly isGitRepository: boolean },
  workspaceRoot: string,
): "Reference" | "Folder" | null {
  if (folder.isGitRepository) return null;
  return isInsideFolder(folder.path, workspaceRoot) ? "Folder" : "Reference";
}

/** Adds a picked folder, named after its last segment. Already-tracked paths are left as they are. */
export function addTrackedFolder(
  trackedFolders: ReadonlyArray<ProjectTrackedFolder>,
  path: string,
): ProjectTrackedFolder[] {
  if (trackedFolders.some((folder) => samePath(folder.path, path))) return [...trackedFolders];
  return [...trackedFolders, { path, name: fileBasename(path).slice(0, 128) }];
}

export function removeTrackedFolder(
  trackedFolders: ReadonlyArray<ProjectTrackedFolder>,
  path: string,
): ProjectTrackedFolder[] {
  return trackedFolders.filter((folder) => !samePath(folder.path, path));
}

/** Locate keeps the folder's name and position in the list. */
export function relocateTrackedFolder(
  trackedFolders: ReadonlyArray<ProjectTrackedFolder>,
  path: string,
  nextPath: string,
): ProjectTrackedFolder[] {
  return trackedFolders.map((folder) =>
    samePath(folder.path, path) ? { path: nextPath, name: folder.name } : folder,
  );
}

export function untrackedScannedFolders(
  trackedFolders: ReadonlyArray<ProjectTrackedFolder>,
  scanned: ReadonlyArray<WorkspaceScannedFolder>,
): ReadonlyArray<WorkspaceScannedFolder> {
  return scanned.filter(
    (folder) => !trackedFolders.some((tracked) => samePath(tracked.path, folder.path)),
  );
}

type TrackedFolderState =
  | { readonly kind: "repository" | "reference"; readonly missing: boolean }
  | { readonly kind: "folder" | "unknown"; readonly missing: false };

/** Git-ness is detected on the server; a plain folder inside home appears in neither list. */
export function trackedFolderState(
  folder: ProjectTrackedFolder,
  workspace: WorkspaceListRepositoriesResult | null,
): TrackedFolderState {
  if (workspace === null) return { kind: "unknown", missing: false };
  const repository = workspace.repositories.find(
    (candidate) => candidate.kind === "repository" && samePath(candidate.originalPath, folder.path),
  );
  if (repository) return { kind: "repository", missing: repository.missing };
  const reference = workspace.references.find((candidate) => samePath(candidate.path, folder.path));
  if (reference) return { kind: "reference", missing: reference.missing };
  return { kind: "folder", missing: false };
}

export function trackedGitRepositories(
  workspace: WorkspaceListRepositoriesResult | null,
): ReadonlyArray<WorkspaceRepository> {
  return workspace?.repositories.filter((repository) => repository.kind === "repository") ?? [];
}

export function isMultiRepoWithGitHome(workspace: WorkspaceListRepositoriesResult | null) {
  return (
    workspace !== null &&
    workspace.repositories.some((repository) => repository.kind === "home") &&
    workspace.repositories.some((repository) => repository.kind === "repository")
  );
}

/** What a new task folder leaves out, keyed by tracked path. Absent means every repo from its default. */
export interface WorktreeRepositorySelection {
  readonly excludedPaths: ReadonlyArray<string>;
  readonly baseRefs: Readonly<Record<string, string>>;
}

export function isRepositoryIncluded(
  selection: WorktreeRepositorySelection | undefined,
  path: string,
) {
  return selection === undefined || !selection.excludedPaths.includes(path);
}

export function includedRepositoryCount(
  repositories: ReadonlyArray<Pick<WorkspaceRepository, "originalPath">>,
  selection: WorktreeRepositorySelection | undefined,
) {
  return repositories.filter((repository) =>
    isRepositoryIncluded(selection, repository.originalPath),
  ).length;
}

/**
 * The worktree launch's `repositories`: omitted when every repo is in with its default base, so the
 * server keeps its own default. Excluded paths the project no longer tracks are ignored.
 */
export function resolveLaunchRepositories(
  repositories: ReadonlyArray<Pick<WorkspaceRepository, "originalPath">>,
  selection: WorktreeRepositorySelection | undefined,
): OrchestrationV2LaunchRepository[] | undefined {
  if (selection === undefined) return undefined;
  const included = repositories.flatMap((repository) => {
    if (!isRepositoryIncluded(selection, repository.originalPath)) return [];
    const baseRef = selection.baseRefs[repository.originalPath]?.trim() ?? "";
    return [
      baseRef.length > 0
        ? { path: repository.originalPath, baseRef }
        : { path: repository.originalPath },
    ];
  });
  const changed =
    included.length < repositories.length || included.some((entry) => "baseRef" in entry);
  return changed ? included : undefined;
}

export interface TaskFolderRepositoryState {
  readonly name: string;
  /** Null when the status read failed. */
  readonly hasChanges: boolean | null;
}

/** Repos removal leaves on disk: the server never removes one with changes. */
export function keptTaskFolderRepositories(
  repositories: ReadonlyArray<TaskFolderRepositoryState>,
): string[] {
  return repositories
    .filter((repository) => repository.hasChanges === true)
    .map((repository) => repository.name);
}

export function taskFolderDeleteConfirmation(input: {
  readonly root: string;
  readonly repositories: ReadonlyArray<TaskFolderRepositoryState>;
}): string {
  return [
    "This thread is the only one using this task folder:",
    input.root,
    "",
    ...input.repositories.map(
      (repository) =>
        `${repository.name}: ${
          repository.hasChanges === false
            ? "clean"
            : repository.hasChanges
              ? "has changes"
              : "status unknown"
        }`,
    ),
    "",
    "Delete the task folder too? Repos with changes are kept.",
  ].join("\n");
}

export function failedSetupRepositories(snapshot: WorktreeSetupSnapshot | null) {
  return snapshot?.phase === "failed"
    ? snapshot.repositories.filter((repository) => repository.status === "failed")
    : [];
}
