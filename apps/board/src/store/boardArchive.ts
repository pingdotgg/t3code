import type { Board } from "../domain/board";
import { type ProjectFiles, writeBoard } from "./boardFiles";

export interface FamilyThread {
  readonly id: string;
  /** Whether the thread's latest run is still going. */
  readonly working: boolean;
  /** The root of a thread family is the orchestrator; its children are its delegated tasks. */
  readonly isRoot: boolean;
}

/** The engine's thread calls the archive flow needs. */
export interface BoardThreads {
  /** `thread.stop` with `stopDelegatedTasks`, so Stop also ends every task under the thread. */
  readonly stop: (threadId: string) => Promise<void>;
  /** `orchestration.getThreadFamily`, which lists only threads that are not archived. */
  readonly activeFamily: (threadId: string) => Promise<ReadonlyArray<FamilyThread>>;
  /** The archived threads that share the thread's root, which `getThreadFamily` no longer lists. */
  readonly archivedFamily: (threadId: string) => Promise<ReadonlyArray<FamilyThread>>;
  readonly archive: (threadId: string) => Promise<void>;
  readonly unarchive: (threadId: string) => Promise<void>;
}

export interface BoardTarget {
  readonly cwd: string;
  readonly folder: string;
  readonly board: Board;
}

export interface ArchiveOptions {
  readonly sleep: (ms: number) => Promise<void>;
  /** How long stopped agents get to wind down before the archive gives up. */
  readonly stopTimeoutMs?: number;
}

const POLL_MS = 500;
const DEFAULT_STOP_TIMEOUT_MS = 60_000;

/**
 * The engine refuses to archive a thread whose tasks still run, and a stop takes a moment to
 * reach them, so this waits until none of the family is working.
 */
async function stoppedFamily(threads: BoardThreads, threadId: string, options: ArchiveOptions) {
  const polls = Math.ceil((options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS) / POLL_MS);
  for (let poll = 0; ; poll += 1) {
    const family = await threads.activeFamily(threadId);
    if (!family.some((thread) => thread.working)) return family;
    if (poll >= polls) {
      throw new Error("The board's agents are still running, so it was not archived.");
    }
    await options.sleep(POLL_MS);
  }
}

/**
 * Stops the orchestrator and its tasks, archives every thread of its family with the children
 * first, then marks the board archived. A board with no orchestrator only gets the mark. The mark
 * comes last, so a failure part way leaves the board listed and archiving it again resumes.
 */
export async function archiveBoard(
  files: ProjectFiles,
  threads: BoardThreads,
  target: BoardTarget,
  options: ArchiveOptions,
): Promise<void> {
  const { cwd, folder, board } = target;
  if (board.orchestratorThreadId !== null) {
    await threads.stop(board.orchestratorThreadId);
    const family = await stoppedFamily(threads, board.orchestratorThreadId, options);
    for (const thread of family.toSorted((a, b) => Number(a.isRoot) - Number(b.isRoot))) {
      await threads.archive(thread.id);
    }
  }
  await writeBoard(files, cwd, folder, { ...board, archived: true });
}

/** Reverses the archive: unarchives the family, then clears the mark. Stopped agents stay stopped. */
export async function restoreBoard(
  files: ProjectFiles,
  threads: BoardThreads,
  target: BoardTarget,
): Promise<void> {
  const { cwd, folder, board } = target;
  if (board.orchestratorThreadId !== null) {
    const family = await threads.archivedFamily(board.orchestratorThreadId);
    for (const thread of family.toSorted((a, b) => Number(b.isRoot) - Number(a.isRoot))) {
      await threads.unarchive(thread.id);
    }
  }
  await writeBoard(files, cwd, folder, { ...board, archived: false });
}
