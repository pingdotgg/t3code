import { create } from "zustand";

import type { DraftId } from "../composerDraftStore.ts";

/**
 * Which session the board is pointed at, shared with the sidebar.
 *
 * The sidebar and the board render the same sessions, so clicking a sidebar row
 * while the board is open must move the board rather than route away from it —
 * there is nowhere to navigate to when the card already *is* the chat.
 *
 * The sidebar cannot see the board's viewport, so it only ever *requests*
 * focus. A card acknowledges a request only after its composer owns DOM focus;
 * the board may open it on a later request. Deliberately not persisted: focus
 * is about this glance at this screen.
 */

export interface BoardFocusRequest {
  readonly threadKey: string;
  /** Bumped per request so clicking the same row twice re-runs the effect. */
  readonly nonce: number;
}

export interface BoardFocusAcknowledgement {
  readonly threadKey: string;
  readonly requestNonce: number;
}

export type BoardExpandedTarget =
  | { readonly kind: "thread"; readonly threadKey: string }
  | { readonly kind: "draft"; readonly draftId: DraftId };

function expandedTargetsEqual(
  left: BoardExpandedTarget | null,
  right: BoardExpandedTarget | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null || left.kind !== right.kind) return false;
  if (left.kind === "thread" && right.kind === "thread") {
    return left.threadKey === right.threadKey;
  }
  return left.kind === "draft" && right.kind === "draft" && left.draftId === right.draftId;
}

interface BoardFocusStoreState {
  readonly request: BoardFocusRequest | null;
  readonly acknowledgedFocus: BoardFocusAcknowledgement | null;
  readonly focusedThreadKey: string | null;
  readonly expandedTarget: BoardExpandedTarget | null;
  readonly requestFocus: (threadKey: string) => void;
  readonly acknowledgeFocus: (threadKey: string, requestNonce: number) => void;
  readonly clearRequest: (threadKey: string, requestNonce: number) => void;
  readonly setFocused: (threadKey: string | null) => void;
  readonly setExpanded: (target: BoardExpandedTarget | null) => void;
}

export const useBoardFocusStore = create<BoardFocusStoreState>()((set) => ({
  request: null,
  acknowledgedFocus: null,
  focusedThreadKey: null,
  expandedTarget: null,
  requestFocus: (threadKey) =>
    set((state) => ({
      request: {
        threadKey,
        nonce: Math.max(state.request?.nonce ?? 0, state.acknowledgedFocus?.requestNonce ?? 0) + 1,
      },
      acknowledgedFocus:
        state.acknowledgedFocus?.threadKey === threadKey ? state.acknowledgedFocus : null,
    })),
  acknowledgeFocus: (threadKey, requestNonce) =>
    set((state) => {
      if (state.request?.threadKey !== threadKey || state.request.nonce !== requestNonce) {
        return state;
      }
      if (
        state.acknowledgedFocus?.threadKey === threadKey &&
        state.acknowledgedFocus.requestNonce === requestNonce
      ) {
        return state;
      }
      return {
        request: null,
        acknowledgedFocus: { threadKey, requestNonce },
        focusedThreadKey: threadKey,
      };
    }),
  clearRequest: (threadKey, requestNonce) =>
    set((state) =>
      state.request?.threadKey === threadKey && state.request.nonce === requestNonce
        ? { request: null }
        : state,
    ),
  setFocused: (threadKey) =>
    set((state) => {
      const acknowledgedFocus =
        state.acknowledgedFocus?.threadKey === threadKey ? state.acknowledgedFocus : null;
      if (state.focusedThreadKey === threadKey && state.acknowledgedFocus === acknowledgedFocus) {
        return state;
      }
      return { focusedThreadKey: threadKey, acknowledgedFocus };
    }),
  setExpanded: (target) =>
    set((state) =>
      expandedTargetsEqual(state.expandedTarget, target) ? state : { expandedTarget: target },
    ),
}));

/** Points the board at a session from outside it (the sidebar, today). */
export function requestBoardFocus(threadKey: string): void {
  useBoardFocusStore.getState().requestFocus(threadKey);
}
