// Where T3 talks to a board, in either layout (slot mode's layout and project messages stay in
// WhiteboardSidebar.tsx and useWhiteboardProject.ts):
//   slot mode:  this T3 is the chat panel of the board page, and the board is window.parent;
//   panel mode: this T3 is the top window on a board host, and the board is a right-panel frame.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { rightPanelHostRef, useRightPanelStore } from "../../rightPanelStore";
import {
  deliverableHighlight,
  hoverOriginInFrame,
  isFromBoardFrame,
  keepPendingFor,
  type PendingHighlight,
  insertCandidates,
} from "./boardChannel.logic";
import { isEmbeddedInWhiteboard } from "./build";
import { boardOfferedFor, readThreadProjectRoot } from "./role";

interface RegisteredFrame {
  readonly element: HTMLIFrameElement;
  readonly threadKey: string;
  readonly onReady: () => void;
}

interface BoardComposer {
  readonly root: HTMLElement;
  readonly threadKey: string;
  /** The thread's own composer, not a sub-thread's. */
  readonly main: boolean;
  /** False when the composer cannot take text now, such as a question with fixed choices. */
  readonly insert: (ref: string, focus: boolean) => boolean;
}

// Only the main chat's right panel shows a board, so one frame at a time.
let frame: RegisteredFrame | null = null;
// By element, so registering the same frame again keeps its board's one `wb-ready`.
const readyFrames = new WeakSet<HTMLIFrameElement>();
let pending: PendingHighlight | null = null;
const composers = new Set<BoardComposer>();
let lastFocused: BoardComposer | null = null;
let listening = false;

function postToFrame(message: { type: string; ref: string | null; origin?: unknown }) {
  frame?.element.contentWindow?.postMessage(message, location.origin);
}

const frameReady = () => frame !== null && readyFrames.has(frame.element);

function deliverPending() {
  const ref = deliverableHighlight(
    pending,
    frame && { threadKey: frame.threadKey, ready: frameReady() },
  );
  if (ref === null) return;
  pending = null;
  postToFrame({ type: "wb-highlight", ref });
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
  const current = frame;
  if (
    current === null ||
    !isFromBoardFrame({
      origin: event.origin,
      ownOrigin: location.origin,
      source: event.source,
      frameWindow: current.element.contentWindow,
    })
  )
    return;
  const { type, ref } = (event.data ?? {}) as { type?: unknown; ref?: unknown };
  if (type === "wb-ready") {
    readyFrames.add(current.element);
    current.onReady();
    deliverPending();
  }
  if (type === "wb-insert-ref" && typeof ref === "string") insertRef(ref, current.threadKey);
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
}

/** Tell the board which reference the pointer is over (null: none), and where on screen it is. */
export function postWhiteboardHover(ref: string | null, element?: Element): void {
  if (isEmbeddedInWhiteboard()) {
    const rect = element?.getBoundingClientRect();
    window.parent.postMessage({ type: "wb-hover", ref, rect }, "*");
    return;
  }
  if (frame === null || !frameReady() || !frame.element.isConnected) return;
  const origin =
    ref !== null && element !== undefined
      ? hoverOriginInFrame(element.getBoundingClientRect(), frame.element.getBoundingClientRect())
      : undefined;
  postToFrame({ type: "wb-hover", ref, ...(origin === undefined ? {} : { origin }) });
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

/** For the panel's board frame while it is mounted; returns its unregister. */
export function registerBoardFrame(
  element: HTMLIFrameElement,
  threadKey: string,
  onReady: () => void,
): () => void {
  listen();
  const entry: RegisteredFrame = { element, threadKey, onReady };
  frame = entry;
  pending = keepPendingFor(pending, threadKey);
  if (readyFrames.has(element)) {
    onReady();
    deliverPending();
  }
  return () => {
    if (frame !== entry) return;
    frame = null;
    // The tab closed or the thread changed before its board was ready: drop the click.
    pending = null;
  };
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
