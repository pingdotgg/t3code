import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";

import type { ChatPaneId, DropZone } from "./chatPanes.logic";
import type { ChatPaneContent } from "./chatPanesStore";

export interface ChatPaneDropTarget {
  readonly paneId: ChatPaneId;
  readonly zone: DropZone;
  /** Set by the layout's edge band, which outranks the pane under the pointer. */
  readonly priority?: boolean;
}

/**
 * Content being carried over the chat area. The sidebar's dnd-kit gesture, a
 * pane header's pointer drag, and a right-panel tab all publish here, so the
 * pane drop overlays have one source to read and never care where the drag
 * began. The gesture owner reads `target` on release and applies the drop.
 */
interface ChatPaneDragState {
  content: ChatPaneContent | null;
  title: string;
  /** Pane the content came from, when rearranging an open pane. */
  sourcePaneId: ChatPaneId | null;
  /**
   * For launcher cards: runs the card's normal add action on drop, and the
   * tab it adds to the right panel is the one that becomes the pane.
   */
  create: (() => void) | null;
  target: ChatPaneDropTarget | null;
  start: (input: {
    content: ChatPaneContent;
    title: string;
    sourcePaneId?: ChatPaneId;
    create?: () => void;
  }) => void;
  setTarget: (paneId: ChatPaneId, zone: DropZone | null, priority?: boolean) => void;
  end: () => void;
}

export const useChatPaneDragStore = create<ChatPaneDragState>((set, get) => ({
  content: null,
  title: "",
  sourcePaneId: null,
  create: null,
  target: null,
  start: ({ content, title, sourcePaneId, create }) =>
    set({
      content,
      title,
      sourcePaneId: sourcePaneId ?? null,
      create: create ?? null,
      target: null,
    }),
  setTarget: (paneId, zone, priority = false) =>
    set((state) => {
      if (state.content === null) return state;
      if (zone === null) {
        return state.target?.paneId === paneId ? { target: null } : state;
      }
      // A pane never overrides the layout edge while the pointer is in the band.
      if (!priority && state.target?.priority && state.target.paneId !== paneId) return state;
      return state.target?.paneId === paneId && state.target.zone === zone
        ? state
        : { target: { paneId, zone, priority } };
    }),
  end: () => {
    if (get().content !== null) {
      set({ content: null, title: "", sourcePaneId: null, create: null, target: null });
    }
  },
}));

export function isChatPaneDragActive(): boolean {
  return useChatPaneDragStore.getState().content !== null;
}

/**
 * Called by a gesture owner on release. The pane layout applies a target
 * from its own pointerup handler in a microtask; the drag ends after that
 * either way, so a release the layout never sees cannot strand the ghost.
 */
export function releaseChatPaneDrag() {
  const drag = useChatPaneDragStore.getState();
  if (drag.target === null) drag.end();
  else setTimeout(drag.end);
}

/** Pointer slop before a press turns into a drag, so plain clicks still land. */
const DRAG_DISTANCE = 6;

/**
 * Starts carrying `input` once the pointer moves past the slop. The chat area
 * applies a release over a pane; a release anywhere else, Escape, or window
 * blur ends the gesture here. Returns a cancel for an unmounting owner.
 */
export function startChatPaneDrag(
  event: ReactPointerEvent<Element>,
  input: Parameters<ChatPaneDragState["start"]>[0],
): (() => void) | null {
  if (event.button !== 0 || !event.isPrimary) return null;
  const start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  let started = false;
  const finish = () => {
    document.removeEventListener("pointermove", onMove, { capture: true });
    document.removeEventListener("pointerup", onUp, { capture: true });
    document.removeEventListener("pointercancel", onCancel, { capture: true });
    document.removeEventListener("keydown", onKey, { capture: true });
    window.removeEventListener("blur", onCancel);
    if (started) {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    }
  };
  const onMove = (move: PointerEvent) => {
    if (move.pointerId !== start.pointerId) return;
    // A release outside the window is never delivered; the next move says so.
    if ((move.buttons & 1) === 0) return onCancel();
    if (!started) {
      if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_DISTANCE) return;
      started = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      chatPaneDragPointer.current = { x: move.clientX, y: move.clientY };
      useChatPaneDragStore.getState().start(input);
    }
    move.preventDefault();
  };
  const onUp = (up: PointerEvent) => {
    if (up.pointerId !== start.pointerId) return;
    finish();
    releaseChatPaneDrag();
  };
  const onCancel = () => {
    finish();
    useChatPaneDragStore.getState().end();
  };
  const onKey = (key: KeyboardEvent) => {
    if (key.key === "Escape") onCancel();
  };
  document.addEventListener("pointermove", onMove, { capture: true });
  document.addEventListener("pointerup", onUp, { capture: true });
  document.addEventListener("pointercancel", onCancel, { capture: true });
  document.addEventListener("keydown", onKey, { capture: true });
  window.addEventListener("blur", onCancel);
  return onCancel;
}

/**
 * Where the primary pointer last was during a drag. Overlays mount after
 * the gesture starts, so they read this to resolve a zone before the next
 * move; without it, a pickup that lands directly on a pane has no target.
 */
export const chatPaneDragPointer: { current: { x: number; y: number } | null } = { current: null };
