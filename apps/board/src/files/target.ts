import type { EnvironmentId } from "@t3tools/contracts";

import { BOARDS_DIR } from "../domain/board";

/** A place the Files panel browses: the project, or a ticket's worktree. */
export interface FilesRoot {
  /** The folder the engine lists and writes inside, which is the `cwd` of every call. */
  readonly cwd: string;
  readonly label: string;
}

/** The roots of a board, the project first and then each ticket worktree once. */
export function boardRoots(
  project: { readonly title: string; readonly workspaceRoot: string },
  tickets: ReadonlyArray<{ readonly key: string; readonly worktreePath?: string | null }>,
): ReadonlyArray<FilesRoot> {
  const roots: FilesRoot[] = [{ cwd: trimSlashes(project.workspaceRoot), label: project.title }];
  for (const ticket of tickets) {
    const cwd = trimSlashes(ticket.worktreePath ?? "");
    if (cwd !== "" && !roots.some((root) => root.cwd === cwd)) {
      roots.push({ cwd, label: `${ticket.key} worktree` });
    }
  }
  return roots;
}

const trimSlashes = (path: string) => path.replace(/\/+$/, "");

/** What the Files panel needs to know about the board it browses. */
export interface FilesBoard {
  readonly environmentId: EnvironmentId;
  readonly mediaThreadId: string;
  readonly orchestratorThreadId: string | null;
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
  readonly orchestratorThreadId: string | null;
  /** Whether the orchestrator may need to read this file again after a save. */
  readonly tellable: boolean;
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

/** The target of a file under a root, where a save under the board's store or a worktree is one the orchestrator reads. */
export function fileTarget(board: FilesBoard, root: FilesRoot, path: string): FileTarget {
  const isProject = root.cwd === board.roots[0]?.cwd;
  return {
    environmentId: board.environmentId,
    cwd: root.cwd,
    path,
    mediaThreadId: board.mediaThreadId,
    orchestratorThreadId: board.orchestratorThreadId,
    tellable: !isProject || path.startsWith(`${BOARDS_DIR}/`),
  };
}
