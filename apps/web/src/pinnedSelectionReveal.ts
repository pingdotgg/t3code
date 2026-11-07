import type { ScopedThreadRef } from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

import { registerMenuAction } from "./shortcuts/dispatcher";

import {
  capturePinnedMessageSelection,
  selectionViewport,
  type PinnedSelection,
  type PinnedSelectionDraft,
} from "./pinnedSelections";
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
  requestPinnedSelectionReveal({ threadKey, pinId: pin.id, messageId: pin.messageId });
  return pin;
}

let pendingPin: { readonly threadKey: string; readonly draft: PinnedSelectionDraft } | null = null;
let pinMenuInstalled = false;

function rememberPinnedSelectionFromContextMenu(preserveOnMiss = false): void {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  const viewport = selectionViewport(selection);
  const threadKey = viewport?.dataset.pinnedSelectionThread;
  const draft = viewport && threadKey ? capturePinnedMessageSelection(viewport, selection) : null;
  if (draft && threadKey) {
    pendingPin = { threadKey, draft };
    return;
  }
  if (!preserveOnMiss) pendingPin = null;
}

function commitContextMenuPin(): boolean {
  const pending = pendingPin;
  pendingPin = null;
  if (pending) {
    const threadRef = parseScopedThreadKey(pending.threadKey);
    if (!threadRef) return false;
    commitPinnedSelection(threadRef, pending.draft);
    return true;
  }
  const selection = window.getSelection();
  const viewport = selectionViewport(selection);
  const threadKey = viewport?.dataset.pinnedSelectionThread;
  const threadRef = threadKey ? parseScopedThreadKey(threadKey) : null;
  if (!threadRef) return false;
  return pinMessageSelection(threadRef);
}

export function installPinnedSelectionContextMenu(): void {
  if (pinMenuInstalled || typeof window === "undefined") return;
  pinMenuInstalled = true;
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button === 2) rememberPinnedSelectionFromContextMenu();
    },
    true,
  );
  window.addEventListener("contextmenu", () => rememberPinnedSelectionFromContextMenu(true), true);
  if (typeof window.desktopBridge?.onMenuAction === "function") {
    registerMenuAction("thread.pinSelection", () => {
      commitContextMenuPin();
    });
  }
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
