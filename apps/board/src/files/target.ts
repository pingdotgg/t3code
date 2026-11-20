import type { EnvironmentId } from "@t3tools/contracts";

import type { FileRef } from "../state/filesView";

/** A place the file view browses: the project, or a ticket's worktree. */
export interface FilesRoot {
  /** The folder the engine lists inside, which is the `cwd` of every call. */
  readonly cwd: string;
  readonly label: string;
  /** The branch a ticket worktree's work is compared against, from `tickets.json`. Null compares against the default branch. */
  readonly base: string | null;
}

/** The roots of a board, the project first and then each ticket worktree once. */
export function boardRoots(
  project: { readonly title: string; readonly workspaceRoot: string },
  tickets: ReadonlyArray<{
    readonly key: string;
    readonly worktreePath?: string | null;
    readonly base?: string | null;
  }>,
): ReadonlyArray<FilesRoot> {
  const roots: FilesRoot[] = [
    { cwd: trimSlashes(project.workspaceRoot), label: project.title, base: null },
  ];
  for (const ticket of tickets) {
    const cwd = trimSlashes(ticket.worktreePath ?? "");
    if (cwd !== "" && !roots.some((root) => root.cwd === cwd)) {
      roots.push({ cwd, label: `${ticket.key} worktree`, base: ticket.base ?? null });
    }
  }
  return roots;
}

/** A folder as the engine takes it, without a trailing slash, which is what a root's `cwd` is. */
export const trimSlashes = (path: string) => path.replace(/\/+$/, "");

/** What the file view needs to know about the board it browses. */
export interface FilesBoard {
  readonly environmentId: EnvironmentId;
  readonly mediaThreadId: string;
  /** The project first, then the ticket worktrees. */
  readonly roots: ReadonlyArray<FilesRoot>;
}

/** One file, addressed the way the engine takes it: a path relative to the root it was listed under. */
export interface FileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  /** The thread a media URL is minted under. */
  readonly mediaThreadId: string;
  /** The line a text file opens at, which the file view scrolls to and marks. */
  readonly line?: number;
}

export const absolutePathOf = (target: Pick<FileTarget, "cwd" | "path">) =>
  `${trimSlashes(target.cwd)}/${target.path}`;

export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The root and relative path of an absolute path on the engine's host, from the deepest root that
 * holds it. Null when no root does.
 */
export function locate(
  roots: ReadonlyArray<FilesRoot>,
  absolutePath: string,
): { readonly root: FilesRoot; readonly path: string } | null {
  let best: FilesRoot | null = null;
  for (const root of roots) {
    if (
      absolutePath.startsWith(`${root.cwd}/`) &&
      (best === null || root.cwd.length > best.cwd.length)
    ) {
      best = root;
    }
  }
  return best === null ? null : { root: best, path: absolutePath.slice(best.cwd.length + 1) };
}

export const fileTarget = (board: FilesBoard, { cwd, path, line }: FileRef): FileTarget => ({
  environmentId: board.environmentId,
  cwd,
  path,
  mediaThreadId: board.mediaThreadId,
  ...(line === undefined ? {} : { line }),
});
