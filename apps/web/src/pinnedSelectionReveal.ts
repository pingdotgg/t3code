import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

import {
  capturePinnedMessageSelection,
  selectionViewport,
  type PinnedSelection,
  type PinnedSelectionDraft,
} from "./pinnedSelections";
import { selectActiveRightPanel, useRightPanelStore } from "./rightPanelStore";
import { useUiStateStore } from "./uiStateStore";

export interface PinnedSelectionReveal {
  readonly threadKey: string;
  readonly pinId: string;
  readonly messageId: string;
  readonly nonce: number;
}

type RevealStore = {
  reveal: PinnedSelectionReveal | null;
  request: (input: Omit<PinnedSelectionReveal, "nonce">) => void;
  clear: (pinId?: string) => void;
};

export const usePinnedSelectionRevealStore = create<RevealStore>((set) => ({
  reveal: null,
  request: (input) =>
    set((state) => ({
      reveal: { ...input, nonce: (state.reveal?.nonce ?? 0) + 1 },
    })),
  clear: (pinId) =>
    set((state) =>
      pinId !== undefined && state.reveal?.pinId !== pinId ? state : { reveal: null },
    ),
}));

export function requestPinnedSelectionReveal(input: Omit<PinnedSelectionReveal, "nonce">) {
  usePinnedSelectionRevealStore.getState().request(input);
}

function clearPinnedSelectionReveal(pinId?: string) {
  usePinnedSelectionRevealStore.getState().clear(pinId);
}

export function commitPinnedSelection(
  threadRef: ScopedThreadRef,
  draft: PinnedSelectionDraft,
): PinnedSelection {
  const threadKey = scopedThreadKey(threadRef);
  const pin = useUiStateStore.getState().addPinnedSelection(threadKey, draft);
  const panels = useRightPanelStore.getState();
  if (selectActiveRightPanel(panels.byThreadKey, threadRef) !== "diff") {
    panels.open(threadRef, "diff");
  }
  requestPinnedSelectionReveal({ threadKey, pinId: pin.id, messageId: pin.messageId });
  return pin;
}

export function pinMessageSelection(threadRef: ScopedThreadRef): boolean {
  const selection = window.getSelection();
  const viewport = selectionViewport(selection);
  if (!viewport || viewport.dataset.pinnedSelectionThread !== scopedThreadKey(threadRef)) {
    return false;
  }
  const draft = capturePinnedMessageSelection(viewport, selection);
  if (!draft) return false;
  commitPinnedSelection(threadRef, draft);
  return true;
}

export function unpinSelection(threadKey: string, pinId: string) {
  useUiStateStore.getState().removePinnedSelection(threadKey, pinId);
  clearPinnedSelectionReveal(pinId);
}
