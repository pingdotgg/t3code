import {
  getFilesystemBrowsePath,
  getFilesystemBrowseTabCompletion,
} from "@t3tools/client-runtime/state/filesystem";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  normalizeProjectPathForComparison,
} from "@t3tools/client-runtime/state/projects";
import type { FilesystemBrowseEntry } from "@t3tools/contracts";
import { scoreQueryMatch } from "@t3tools/shared/searchRanking";

/** What Enter does on a row of the `/cd` destination pane. */
type FolderMoveAction =
  | { readonly kind: "move"; readonly path: string }
  | { readonly kind: "no-project" }
  | { readonly kind: "open"; readonly query: string };

export interface FolderMoveRow {
  readonly id: string;
  readonly group: "Projects" | "Folders";
  readonly icon: "project" | "folder" | "parent" | "use" | "no-project";
  readonly label: string;
  readonly description: string;
  /** A project root. It shows the project icon, and a badge among the folders. */
  readonly isProject: boolean;
  /** The thread's own folder, which a badge marks. Enter opens it like any other folder. */
  readonly isCurrent?: true | undefined;
  readonly action: FolderMoveAction;
}

interface DestinationProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly updatedAt: string;
  readonly archivedAt?: string | null | undefined;
  readonly isScratch?: true | undefined;
}

/** The typed destination without the one pair of quotes that `/cd` strips. */
export function folderMoveQueryPath(query: string): string {
  const trimmed = query.trim();
  const quoted = /^(["'])([\s\S]*?)\1?$/.exec(trimmed);
  return quoted ? (quoted[2] ?? "") : trimmed;
}

/**
 * A typed name picks the first matching project, so that row is active and Enter moves there.
 * An empty query and a path have no active row: Enter runs the typed destination as it stands.
 */
export function folderMoveHighlightsFirstRow(input: {
  readonly query: string;
  readonly isBrowsing: boolean;
}): boolean {
  return !input.isBrowsing && folderMoveQueryPath(input.query) !== "";
}

const samePath = (left: string, right: string) =>
  normalizeProjectPathForComparison(left) === normalizeProjectPathForComparison(right);

/** Projects a thread can move to: not its own folder, not archived, not No project. */
function destinationProjects(
  projects: ReadonlyArray<DestinationProject>,
  currentFolder: string | null,
): ReadonlyArray<DestinationProject> {
  return projects.filter(
    (project) =>
      project.isScratch !== true &&
      project.archivedAt == null &&
      (currentFolder === null || !samePath(project.workspaceRoot, currentFolder)),
  );
}

const projectRow = (project: DestinationProject): FolderMoveRow => ({
  id: `folder-move:project:${project.id}`,
  group: "Projects",
  icon: "project",
  label: project.title,
  description: project.workspaceRoot,
  isProject: true,
  action: { kind: "move", path: project.workspaceRoot },
});

/**
 * The rows for an empty or a name query: the projects, most recent thread activity first, or
 * best match first, then No project.
 */
export function folderMoveProjectRows(input: {
  readonly projects: ReadonlyArray<DestinationProject>;
  readonly threads: ReadonlyArray<{ readonly projectId: string; readonly updatedAt: string }>;
  readonly currentFolder: string | null;
  readonly inNoProject: boolean;
  readonly query: string;
}): ReadonlyArray<FolderMoveRow> {
  const lastActivity = new Map<string, string>();
  for (const thread of input.threads) {
    const known = lastActivity.get(thread.projectId);
    if (known === undefined || thread.updatedAt > known) {
      lastActivity.set(thread.projectId, thread.updatedAt);
    }
  }
  const activity = (project: DestinationProject) =>
    lastActivity.get(project.id) ?? project.updatedAt;
  const query = folderMoveQueryPath(input.query).toLowerCase();
  const score = (project: DestinationProject) =>
    query === ""
      ? 0
      : Math.min(
          scoreQueryMatch({
            value: project.title.toLowerCase(),
            query,
            exactBase: 0,
            prefixBase: 2,
            boundaryBase: 4,
            includesBase: 6,
            boundaryMarkers: ["-", "_", " ", "."],
          }) ?? Number.POSITIVE_INFINITY,
          scoreQueryMatch({
            value: project.workspaceRoot.toLowerCase(),
            query,
            exactBase: 10,
            boundaryBase: 12,
            includesBase: 14,
            boundaryMarkers: ["/", "\\"],
          }) ?? Number.POSITIVE_INFINITY,
        );
  const rows = destinationProjects(input.projects, input.currentFolder)
    .map((project) => ({ project, score: score(project) }))
    .filter((entry) => Number.isFinite(entry.score))
    .toSorted(
      (left, right) =>
        left.score - right.score ||
        activity(right.project).localeCompare(activity(left.project)) ||
        left.project.title.localeCompare(right.project.title),
    )
    .map((entry) => projectRow(entry.project));
  const offersNoProject = !input.inNoProject && (query === "" || "no project".includes(query));
  return offersNoProject
    ? [
        ...rows,
        {
          id: "folder-move:no-project",
          group: "Projects",
          icon: "no-project",
          label: "No project",
          description: "Move to a new scratch folder",
          isProject: false,
          action: { kind: "no-project" },
        },
      ]
    : rows;
}

/**
 * The rows for a path query: the browsed folder itself, its parent, and its subfolders. A
 * folder that is a project root moves the thread at once; another folder opens in the pane.
 */
export function folderMoveFolderRows(input: {
  readonly projects: ReadonlyArray<DestinationProject>;
  readonly currentFolder: string | null;
  readonly query: string;
  readonly platform: string;
  /** The folder the server resolved the typed directory to. */
  readonly directoryFullPath: string;
  readonly entries: ReadonlyArray<FilesystemBrowseEntry>;
  /** The server may not read the folder, so the pane does not offer to move into it. */
  readonly unreadable?: boolean | undefined;
}): ReadonlyArray<FolderMoveRow> {
  const typed = folderMoveQueryPath(input.query);
  const browse = getFilesystemBrowsePath(typed, input.platform);
  const projects = destinationProjects(input.projects, input.currentFolder);
  const projectAt = (folder: string) =>
    projects.find((project) => samePath(project.workspaceRoot, folder));
  const rows: Array<FolderMoveRow> = [];
  if (browse.filterQuery === "") {
    const project = projectAt(input.directoryFullPath);
    const isCurrent =
      input.currentFolder !== null && samePath(input.directoryFullPath, input.currentFolder);
    if (project !== undefined) {
      rows.push({ ...projectRow(project), id: "folder-move:here", group: "Folders" });
    } else if (!isCurrent && input.unreadable !== true) {
      rows.push({
        id: "folder-move:here",
        group: "Folders",
        icon: "use",
        label: "Use this folder",
        description: input.directoryFullPath,
        isProject: false,
        action: { kind: "move", path: input.directoryFullPath },
      });
    }
  }
  if (browse.canBrowseUp && browse.parentPath !== null) {
    rows.push({
      id: "folder-move:parent",
      group: "Folders",
      icon: "parent",
      label: "..",
      description: "Parent folder",
      isProject: false,
      action: { kind: "open", query: browse.parentPath },
    });
  }
  const folders = input.entries.map((entry): FolderMoveRow => {
    const project = projectAt(entry.fullPath);
    if (project !== undefined) {
      return {
        ...projectRow(project),
        id: `folder-move:folder:${entry.fullPath}`,
        group: "Folders",
      };
    }
    // The thread's own folder is no destination, so it opens; it keeps the project icon when it
    // is a project root, which `projectAt` leaves out.
    const isCurrent = input.currentFolder !== null && samePath(entry.fullPath, input.currentFolder);
    const isRoot =
      isCurrent &&
      input.projects.some((candidate) => samePath(candidate.workspaceRoot, entry.fullPath));
    return {
      id: `folder-move:folder:${entry.fullPath}`,
      group: "Folders",
      icon: isRoot ? "project" : "folder",
      label: entry.name,
      description: entry.fullPath,
      isProject: isRoot,
      ...(isCurrent ? { isCurrent: true } : {}),
      action: {
        kind: "open",
        query: appendBrowsePathSegment(browse.directoryPath, entry.name),
      },
    };
  });
  return [
    ...rows,
    ...folders.filter((row) => row.isProject),
    ...folders.filter((row) => !row.isProject),
  ];
}

/**
 * What the pane says when the typed text matches nothing, or null. A path counts only its
 * matching folders: the parent row is always there and is not a match. A missing folder gets
 * the sentence the server's refusal uses, so the pane and the toast agree.
 */
export function folderMoveNoMatchText(input: {
  readonly query: string;
  readonly platform: string;
  /** The folder the server resolved the typed directory to, or null before it answers. */
  readonly directoryFullPath: string | null;
  readonly entries: ReadonlyArray<FilesystemBrowseEntry>;
  readonly rowCount: number;
}): string | null {
  const typed = folderMoveQueryPath(input.query);
  const browse = getFilesystemBrowsePath(typed, input.platform);
  if (browse.isBrowsing) {
    return input.directoryFullPath !== null &&
      browse.filterQuery !== "" &&
      input.entries.length === 0
      ? `No folder at ${ensureBrowseDirectoryPath(input.directoryFullPath)}${browse.filterQuery}.`
      : null;
  }
  return typed !== "" && input.rowCount === 0
    ? `No project matches "${typed}". Type a path to move to a folder.`
    : null;
}

/**
 * The query Tab completes to: the highlighted row's folder, or what the typed name has in
 * common with the folders it matches. Null leaves the text as it is.
 */
export function folderMoveTabCompletion(input: {
  readonly query: string;
  readonly platform: string;
  readonly highlighted: FolderMoveRow | null;
  readonly entries: ReadonlyArray<FilesystemBrowseEntry>;
}): string | null {
  const { highlighted } = input;
  if (highlighted?.action.kind === "open") return highlighted.action.query;
  if (highlighted?.action.kind === "move") {
    return ensureBrowseDirectoryPath(highlighted.action.path);
  }
  if (highlighted !== null) return null;
  const browse = getFilesystemBrowsePath(folderMoveQueryPath(input.query), input.platform);
  if (!browse.isBrowsing) return null;
  const completion = getFilesystemBrowseTabCompletion(input.entries, browse.filterQuery);
  if (completion === null) return null;
  return completion.isComplete
    ? appendBrowsePathSegment(browse.directoryPath, completion.name)
    : `${browse.directoryPath}${completion.name}`;
}
