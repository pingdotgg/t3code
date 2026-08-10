/**
 * Client-side view of a project's source folders.
 *
 * The server owns the folder list (see {@link ./projectFolders.ts}); this module
 * turns it into what the file tree, the search surfaces, the pickers and the
 * terminals need: a deduped, ordered list with stable ids and unique
 * human-readable labels, plus the rule for attributing an absolute path back to
 * the folder that contains it.
 *
 * Browser-safe: no `node:path`, no Effect.
 *
 * @module workspaceFolders
 */
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "./path.ts";

/**
 * Id of the folder a thread actually runs in.
 *
 * The primary folder keeps a fixed id rather than a path-derived one so that
 * persisted UI state (open file tabs, terminal placement) survives promoting a
 * different folder to primary, and so state written before this feature existed
 * still decodes as "the primary folder".
 */
export const PRIMARY_WORKSPACE_FOLDER_ID = "primary";

export interface WorkspaceFolder {
  /** Stable identity: {@link PRIMARY_WORKSPACE_FOLDER_ID}, or the folder's normalized path. */
  readonly id: string;
  /** Absolute path to query. For the primary this is the thread's worktree when it has one. */
  readonly cwd: string;
  /** Unique, human-readable name. Derived at read time — never persist it. */
  readonly label: string;
  readonly isPrimary: boolean;
}

function splitSegments(value: string): ReadonlyArray<string> {
  return value.split(/[\\/]+/u).filter((segment) => segment.length > 0);
}

function basename(value: string): string {
  const segments = splitSegments(value);
  return segments.at(-1) ?? value;
}

/**
 * True when `candidate` is `ancestor` or sits underneath it.
 *
 * Compares normalized segments so that trailing separators, mixed separators,
 * and Windows case differences do not produce false negatives.
 */
export function isFolderContainedBy(candidate: string, ancestor: string): boolean {
  const candidateSegments = splitSegments(normalizeProjectPathForComparison(candidate));
  const ancestorSegments = splitSegments(normalizeProjectPathForComparison(ancestor));
  if (ancestorSegments.length > candidateSegments.length) {
    return false;
  }
  return ancestorSegments.every((segment, index) => candidateSegments[index] === segment);
}

/**
 * Assign each folder the shortest trailing path fragment that is unique across
 * the set.
 *
 * A bare basename is used when it is already unambiguous; otherwise parent
 * segments are prepended until the label distinguishes the folder. Labels are
 * derived rather than stored so that adding a folder which forces `api` to
 * become `dev/api` cannot invalidate anything already persisted.
 */
export function deriveFolderLabels(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const segmentLists = paths.map((path) => splitSegments(path));
  return segmentLists.map((segments, index) => {
    if (segments.length === 0) {
      return paths[index] ?? "";
    }
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const candidate = segments.slice(segments.length - depth).join("/");
      const collides = segmentLists.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other
            .slice(Math.max(0, other.length - depth))
            .join("/")
            .toLowerCase() === candidate.toLowerCase(),
      );
      if (!collides) {
        return candidate;
      }
    }
    // Every suffix collides (two folders with identical paths should have been
    // deduped upstream); fall back to the full path so the rows stay distinct.
    return paths[index] ?? segments.join("/");
  });
}

/**
 * Build the folder list for a thread.
 *
 * A worktree replaces the *primary* folder's cwd only: additional folders are
 * separate trees that a worktree does not shadow. Duplicate and nested folders
 * are dropped — either would produce duplicate tree rows and make attributing a
 * path to a folder ambiguous.
 */
export function resolveWorkspaceFolders(input: {
  readonly primaryRoot: string;
  readonly worktreePath?: string | null;
  readonly additionalFolders: ReadonlyArray<{
    readonly path: string;
    readonly label?: string | undefined;
  }>;
}): ReadonlyArray<WorkspaceFolder> {
  const primaryCwd = input.worktreePath ?? input.primaryRoot;
  const accepted: Array<{ id: string; cwd: string; explicitLabel?: string; isPrimary: boolean }> = [
    { id: PRIMARY_WORKSPACE_FOLDER_ID, cwd: primaryCwd, isPrimary: true },
  ];

  for (const folder of input.additionalFolders) {
    const path = folder.path.trim();
    if (path.length === 0) continue;
    const overlaps = accepted.some(
      (existing) =>
        isFolderContainedBy(path, existing.cwd) || isFolderContainedBy(existing.cwd, path),
    );
    if (overlaps) continue;
    accepted.push({
      id: normalizeProjectPathForComparison(path),
      cwd: path,
      ...(folder.label !== undefined ? { explicitLabel: folder.label } : {}),
      isPrimary: false,
    });
  }

  const derived = deriveFolderLabels(accepted.map((entry) => entry.cwd));
  return accepted.map((entry, index) => ({
    id: entry.id,
    cwd: entry.cwd,
    label: entry.explicitLabel ?? derived[index] ?? basename(entry.cwd),
    isPrimary: entry.isPrimary,
  }));
}

export interface WorkspaceFolderRelativePath {
  readonly folder: WorkspaceFolder;
  /** POSIX-style path relative to `folder.cwd`. Empty when the path is the folder itself. */
  readonly relativePath: string;
}

/**
 * Attribute an absolute path to the folder that contains it.
 *
 * Longest match wins, so a folder nested under another is credited correctly
 * even though {@link resolveWorkspaceFolders} normally drops such folders —
 * this stays correct for paths resolved against an unfiltered list.
 *
 * Returns `null` when no folder contains the path; callers should display it
 * verbatim in that case rather than inventing a relative path.
 */
export function relativizeAgainstFolders(
  folders: ReadonlyArray<WorkspaceFolder>,
  absolutePath: string,
): WorkspaceFolderRelativePath | null {
  let best: WorkspaceFolderRelativePath | null = null;
  let bestDepth = -1;

  for (const folder of folders) {
    if (!isFolderContainedBy(absolutePath, folder.cwd)) continue;
    const depth = splitSegments(folder.cwd).length;
    if (depth <= bestDepth) continue;
    const relativeSegments = splitSegments(absolutePath).slice(splitSegments(folder.cwd).length);
    best = { folder, relativePath: relativeSegments.join("/") };
    bestDepth = depth;
  }

  return best;
}

/**
 * Render a path for display: `label/relative` when the project has more than
 * one folder, otherwise the bare relative path so single-folder projects look
 * exactly as they did before source folders existed.
 */
export function formatWorkspaceFolderPath(
  folders: ReadonlyArray<WorkspaceFolder>,
  absolutePath: string,
): string {
  const resolved = relativizeAgainstFolders(folders, absolutePath);
  if (resolved === null) return absolutePath;
  if (folders.length <= 1) return resolved.relativePath;
  return resolved.relativePath.length === 0
    ? resolved.folder.label
    : `${resolved.folder.label}/${resolved.relativePath}`;
}

/**
 * The path to hand to the agent for a file in `folder`.
 *
 * The agent's process cwd is the primary folder, so a bare relative path from
 * another folder would silently resolve to the wrong file inside the primary.
 * Non-primary references therefore go out absolute.
 */
export function agentPathForWorkspaceFolder(input: {
  readonly folder: Pick<WorkspaceFolder, "cwd" | "isPrimary">;
  readonly relativePath: string;
}): string {
  if (input.folder.isPrimary) return input.relativePath;
  const separator = isWindowsAbsolutePath(input.folder.cwd) ? "\\" : "/";
  const base = input.folder.cwd.replace(/[\\/]+$/u, "");
  const relative = isWindowsAbsolutePath(input.folder.cwd)
    ? input.relativePath.replaceAll("/", "\\")
    : input.relativePath;
  return relative.length === 0 ? base : `${base}${separator}${relative}`;
}
