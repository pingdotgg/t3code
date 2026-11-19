// The board channel's decisions, apart from windows and frames (boardChannel.ts wires them).
import type { EnvironmentId } from "@t3tools/contracts";

/** Whether a thread may show its project's board in the right panel. */
export function isBoardOffered(input: {
  readonly boardHost: boolean;
  /** False inside the board page's chat slot, where the board already sits beside the chat. */
  readonly topWindow: boolean;
  readonly threadEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly projectRoot: string | null;
}): boolean {
  return (
    input.boardHost &&
    input.topWindow &&
    // A linked environment's project path would name a room on the wrong board server.
    input.primaryEnvironmentId !== null &&
    input.threadEnvironmentId === input.primaryEnvironmentId &&
    Boolean(input.projectRoot)
  );
}

/** A message is the board's only from this origin and from that board frame's window. */
export function isFromBoardFrame(input: {
  readonly origin: string;
  readonly ownOrigin: string;
  readonly source: unknown;
  readonly frameWindow: unknown;
}): boolean {
  return (
    input.origin === input.ownOrigin &&
    input.frameWindow != null &&
    input.source === input.frameWindow
  );
}

/** The latest `board://` click waiting for its thread's board; newer clicks replace it. */
export interface PendingHighlight {
  readonly threadKey: string;
  readonly ref: string;
}

interface BoardFrameState {
  readonly threadKey: string;
  readonly ready: boolean;
}

/** The highlight to send now: only to a ready frame of the thread that asked for it. */
export function deliverableHighlight(
  pending: PendingHighlight | null,
  frame: BoardFrameState | null,
): string | null {
  return pending !== null && frame?.ready === true && pending.threadKey === frame.threadKey
    ? pending.ref
    : null;
}

/** Showing a board for one thread drops a highlight waiting for another. */
export function keepPendingFor(
  pending: PendingHighlight | null,
  threadKey: string,
): PendingHighlight | null {
  return pending?.threadKey === threadKey ? pending : null;
}

interface InsertCandidate {
  readonly threadKey: string;
  /** The thread's own composer, not a sub-thread's. */
  readonly main: boolean;
  readonly connected: boolean;
}

/**
 * The composers that may take a board reference, best first: the one last focused, then the
 * panel thread's main composer. The first that accepts it takes it, so exactly one does.
 */
export function insertCandidates<C extends InsertCandidate>(
  composers: ReadonlyArray<C>,
  lastFocused: C | null,
  panelThreadKey: string,
): C[] {
  const main = composers.find(
    (composer) => composer.connected && composer.main && composer.threadKey === panelThreadKey,
  );
  const focused =
    lastFocused !== null && lastFocused.connected && composers.includes(lastFocused)
      ? lastFocused
      : undefined;
  return [...new Set([focused, main])].filter((composer) => composer !== undefined);
}

interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly height: number;
}

/** Where the hover arrow starts, in the frame's viewport: the chip's left edge at mid height. */
export function hoverOriginInFrame(chip: RectLike, frame: RectLike): { x: number; y: number } {
  return { x: chip.left - frame.left, y: chip.top + chip.height / 2 - frame.top };
}

/**
 * The live boards to keep, given most recently shown first: the shown board always, and a hidden
 * one while its thread still lists the Whiteboard tab, `max` boards in all.
 */
export function liveBoardsToKeep<B extends { readonly shown: boolean; readonly listed: boolean }>(
  mostRecentFirst: ReadonlyArray<B>,
  max: number,
): B[] {
  let room = max - mostRecentFirst.filter((board) => board.shown).length;
  return mostRecentFirst.filter((board) => board.shown || (board.listed && room-- > 0));
}
