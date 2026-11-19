// Where T3 talks to a board (slot mode's layout and project messages stay in
// WhiteboardSidebar.tsx and useWhiteboardProject.ts):
//   slot mode:  this T3 is the chat panel of the board page, and the board is window.parent;
//   panel mode: the board is a right-panel frame this module owns, kept loaded while hidden.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { rightPanelHostRef, useRightPanelStore } from "../../rightPanelStore";
import {
  deliverableHighlight,
  hoverOriginInFrame,
  isFromBoardFrame,
  keepPendingFor,
  liveBoardsToKeep,
  type PendingHighlight,
  insertCandidates,
} from "./boardChannel.logic";
import { isEmbeddedInWhiteboard } from "./build";
import { boardOfferedFor, readThreadProjectRoot } from "./role";

/** A board page kept loaded in this window. Only this module creates, moves or removes its frame. */
interface LiveBoard {
  /** One live board per page URL, so a frame's room never changes. */
  readonly url: string;
  readonly frame: HTMLIFrameElement;
  /** The threads that showed it; it stays loaded while one of them lists its tab. */
  readonly owners: Set<string>;
  /** Its page sent wb-ready, and has not unloaded since. */
  ready: boolean;
  /** Its last on-screen size, which it keeps while parked so the board's view does not change. */
  size: { readonly width: number; readonly height: number } | null;
}

/** The board on screen. Only it gets highlights and hover, and only it may insert references. */
interface ShownBoard {
  readonly board: LiveBoard;
  readonly slot: HTMLElement;
  readonly threadKey: string;
  /** Told whether the board can be used, when it is shown and whenever that changes. */
  readonly onReady: (ready: boolean) => void;
}

interface BoardComposer {
  readonly root: HTMLElement;
  readonly threadKey: string;
  /** The thread's own composer, not a sub-thread's. */
  readonly main: boolean;
  /** False when the composer cannot take text now, such as a question with fixed choices. */
  readonly insert: (ref: string, focus: boolean) => boolean;
}

const MAX_LIVE_BOARDS = 2;
// Without an atomic move, moving a frame reloads it, so such a browser parks nothing: the frame
// unloads with its slot.
const canMove = typeof Element !== "undefined" && "moveBefore" in Element.prototype;

let boards: LiveBoard[] = []; // most recently shown first
let shown: ShownBoard | null = null;
/** A board parked because its sheet is going away; it comes back if its slot is still there. */
let setAside: ShownBoard | null = null;
let parkingLot: HTMLElement | null = null;
let pending: PendingHighlight | null = null;
const composers = new Set<BoardComposer>();
let lastFocused: BoardComposer | null = null;
let listening = false;

/** The board page a project's Whiteboard tab shows. */
export const boardUrl = (projectRoot: string): string =>
  `/?embed=panel&room=${encodeURIComponent(projectRoot)}`;

function postTo(
  board: LiveBoard,
  message:
    | { type: "wb-highlight" | "wb-hover"; ref: string | null; origin?: unknown }
    | { type: "wb-visible"; visible: boolean },
) {
  board.frame.contentWindow?.postMessage(message, location.origin);
}

function deliverPending() {
  const ref = deliverableHighlight(
    pending,
    shown && { threadKey: shown.threadKey, ready: shown.board.ready },
  );
  if (ref === null || shown === null) return;
  pending = null;
  postTo(shown.board, { type: "wb-highlight", ref });
}

function insertRef(ref: string, panelThreadKey: string) {
  const candidates = [...composers].map((composer) => ({
    composer,
    threadKey: composer.threadKey,
    main: composer.main,
    connected: composer.root.isConnected,
  }));
  const ordered = insertCandidates(
    candidates,
    candidates.find((candidate) => candidate.composer === lastFocused) ?? null,
    panelThreadKey,
  );
  for (const { composer } of ordered) {
    // A maximized panel (inert) or an open sheet (Base UI marks the page behind it) covers the
    // chat; focus stays on the board then.
    const covered = composer.root.closest('[inert],[data-base-ui-inert],[aria-hidden="true"]');
    if (composer.insert(ref, covered === null)) return;
  }
}

function receive(event: MessageEvent) {
  const board = boards.find((live) =>
    isFromBoardFrame({
      origin: event.origin,
      ownOrigin: location.origin,
      source: event.source,
      frameWindow: live.frame.contentWindow,
    }),
  );
  if (board === undefined) return;
  const { type, ref } = (event.data ?? {}) as { type?: unknown; ref?: unknown };
  if (type === "wb-ready") {
    board.ready = true;
    if (shown?.board === board) {
      shown.onReady(true);
      deliverPending();
    } else postTo(board, { type: "wb-visible", visible: false });
  }
  if (type === "wb-unload") {
    board.ready = false;
    if (shown?.board === board) shown.onReady(false);
  }
  if (type === "wb-insert-ref" && typeof ref === "string" && shown?.board === board)
    insertRef(ref, shown.threadKey);
}

function noteFocus(event: FocusEvent) {
  if (!(event.target instanceof Node)) return;
  for (const composer of composers) {
    if (composer.root.contains(event.target)) lastFocused = composer;
  }
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", receive);
  document.addEventListener("focusin", noteFocus);
  useRightPanelStore.subscribe(followPanels);
}

/**
 * A sheet removes its portal node before the refs inside it detach, which would unload its board.
 * So a board shown in a sheet is parked as soon as the store closes the panel or maximizes it (the
 * sheet gives way to the inline panel), and goes back if the same sheet opens again.
 */
function followPanels() {
  const panels = useRightPanelStore.getState().byThreadKey;
  const sheetGoes = (entry: ShownBoard) =>
    entry.slot.closest('[data-slot="sheet-popup"]') !== null &&
    (panels[entry.threadKey]?.isOpen !== true || panels[entry.threadKey]?.maximized === true);
  if (shown !== null && sheetGoes(shown)) {
    park(shown.board);
    setAside = shown;
    shown = null;
  } else if (setAside !== null && shown === null && !sheetGoes(setAside)) {
    const entry = setAside;
    setAside = null;
    place(entry);
  }
  prune();
}

/**
 * Unloads every board that is neither shown nor kept for a thread that still lists its tab, and
 * drops a click whose thread closed its tab.
 */
function prune() {
  const { byThreadKey } = useRightPanelStore.getState();
  const lists = (threadKey: string) =>
    byThreadKey[threadKey]?.surfaces.some((surface) => surface.kind === "whiteboard") === true;
  for (const board of boards) {
    for (const owner of board.owners) if (!lists(owner)) board.owners.delete(owner);
  }
  const keep = liveBoardsToKeep(
    boards.map((board) => ({
      board,
      shown: board === shown?.board,
      // A frame out of the document has already unloaded.
      listed: board.owners.size > 0 && board.frame.isConnected,
    })),
    MAX_LIVE_BOARDS,
  ).map(({ board }) => board);
  for (const board of boards) if (!keep.includes(board)) board.frame.remove();
  boards = keep;
  if (setAside !== null && !keep.includes(setAside.board)) setAside = null;
  if (pending !== null && !lists(pending.threadKey)) pending = null;
}

function createBoard(url: string): LiveBoard {
  const frame = document.createElement("iframe");
  frame.title = "Whiteboard";
  frame.src = url;
  frame.style.cssText = "display: block; width: 100%; height: 100%; border: 0";
  return { url, frame, owners: new Set(), ready: false, size: null };
}

function measure(board: LiveBoard, element: Element) {
  const { width, height } = element.getBoundingClientRect();
  if (width > 0 && height > 0) board.size = { width, height };
}

function park(board: LiveBoard) {
  // An ancestor that left the document first (a portal removes its own node) took the page with it.
  if (!board.frame.isConnected) board.ready = false;
  if (!canMove || !board.frame.isConnected) return;
  if (parkingLot === null) {
    parkingLot = document.createElement("div");
    parkingLot.inert = true;
    parkingLot.setAttribute("aria-hidden", "true");
    // Off screen but laid out: a frame with no size would give the board an empty viewport.
    parkingLot.style.cssText =
      "position: fixed; left: -100000px; top: 0; visibility: hidden; pointer-events: none";
    document.body.append(parkingLot);
  }
  measure(board, board.frame);
  if (board.size !== null) {
    board.frame.style.width = `${board.size.width}px`;
    board.frame.style.height = `${board.size.height}px`;
  }
  parkingLot.moveBefore(board.frame, null);
  if (board.ready) postTo(board, { type: "wb-visible", visible: false });
}

function place(entry: ShownBoard) {
  const { board, slot } = entry;
  board.frame.style.width = "100%";
  board.frame.style.height = "100%";
  if (board.frame.parentNode !== slot) {
    if (canMove && board.frame.isConnected && slot.isConnected) slot.moveBefore(board.frame, null);
    else {
      // Inserting a frame that was out of the document, or moving one without moveBefore, loads it.
      slot.append(board.frame);
      board.ready = false;
    }
  }
  measure(board, slot);
  shown = entry;
  pending = keepPendingFor(pending, entry.threadKey);
  entry.onReady(board.ready);
  if (board.ready) {
    postTo(board, { type: "wb-visible", visible: true });
    deliverPending();
  }
}

/**
 * For the Whiteboard tab's slot while it is mounted: shows the live board for `url` in `slot`,
 * loading it on its first show, and returns the cleanup that parks it.
 */
export function showBoard(
  slot: HTMLElement,
  input: {
    readonly url: string;
    readonly threadKey: string;
    readonly onReady: (ready: boolean) => void;
  },
): () => void {
  listen();
  const board = boards.find((live) => live.url === input.url) ?? createBoard(input.url);
  board.owners.add(input.threadKey);
  boards = [board, ...boards.filter((live) => live !== board)];
  const entry: ShownBoard = { board, slot, threadKey: input.threadKey, onReady: input.onReady };
  place(entry);
  prune();
  return () => {
    // Outside a portal, React detaches refs inside a removed subtree before it removes the
    // subtree's top node, so the frame can still move out without reloading.
    if (board.frame.parentNode === slot) park(board);
    if (shown === entry) shown = null;
    if (setAside === entry) setAside = null;
    prune();
  };
}

/** Tell the board which reference the pointer is over (null: none), and where on screen it is. */
export function postWhiteboardHover(ref: string | null, element?: Element): void {
  if (isEmbeddedInWhiteboard()) {
    const rect = element?.getBoundingClientRect();
    window.parent.postMessage({ type: "wb-hover", ref, rect }, "*");
    return;
  }
  if (shown === null || !shown.board.ready) return;
  const origin =
    ref !== null && element !== undefined
      ? hoverOriginInFrame(
          element.getBoundingClientRect(),
          shown.board.frame.getBoundingClientRect(),
        )
      : undefined;
  postTo(shown.board, { type: "wb-hover", ref, ...(origin === undefined ? {} : { origin }) });
}

/** A `board://` link in `threadRef`'s chat was clicked: show that region on the board. */
export function showBoardRef(ref: string, threadRef: ScopedThreadRef | undefined): void {
  if (isEmbeddedInWhiteboard()) {
    window.parent.postMessage({ type: "wb-highlight", ref }, "*");
    return;
  }
  if (threadRef === undefined) return;
  const host = rightPanelHostRef(threadRef);
  if (!boardOfferedFor(host, readThreadProjectRoot(host))) return;
  listen();
  pending = { threadKey: scopedThreadKey(host), ref };
  useRightPanelStore.getState().open(threadRef, "whiteboard");
  deliverPending();
}

/** For each chat composer of a board host's top window; returns its unregister. */
export function registerBoardComposer(composer: BoardComposer): () => void {
  listen();
  composers.add(composer);
  return () => {
    composers.delete(composer);
    if (lastFocused === composer) lastFocused = null;
  };
}
