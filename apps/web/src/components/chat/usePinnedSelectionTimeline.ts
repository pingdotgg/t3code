import type { LegendListRef } from "@legendapp/list/react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { readLocalApi } from "../../localApi";
import { commitPinnedSelection } from "../../pinnedSelectionReveal";
import type { PinnedSelectionReveal } from "../../pinnedSelectionReveal";
import {
  capturePinnedMessageSelection,
  PINNED_SELECTION_HIGHLIGHT_NAME,
  resolvePinnedSelectionRange,
  type PinnedSelection,
} from "../../pinnedSelections";
import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

interface PinnedHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly onLoadEarlier: (throughEntryId?: string) => void;
}

const PIN_SCROLL_ATTEMPTS = 8;

function messageElement(viewport: HTMLElement, messageId: string): HTMLElement | null {
  return viewport.querySelector<HTMLElement>(
    `[data-message-role][data-message-id="${CSS.escape(messageId)}"]`,
  );
}

function messageIsVisible(message: HTMLElement, viewport: HTMLElement): boolean {
  const rect = message.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  return rect.bottom > bounds.top + 8 && rect.top < bounds.bottom - 8 && rect.height > 0;
}

function paintPinnedSelection(viewport: HTMLElement, pin: PinnedSelection | null) {
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
  CSS.highlights.delete(PINNED_SELECTION_HIGHLIGHT_NAME);
  if (!pin) return;
  const message = messageElement(viewport, pin.messageId);
  if (!message) return;
  const range = resolvePinnedSelectionRange(message, pin);
  if (!range) return;
  CSS.highlights.set(PINNED_SELECTION_HIGHLIGHT_NAME, new Highlight(range));
}

export function usePinnedSelectionTimeline(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly rows: readonly MessagesTimelineRow[];
  readonly timelineEntries: readonly TimelineEntry[];
  readonly listRef: RefObject<LegendListRef | null>;
  readonly viewport: HTMLElement | null;
  readonly historyControls: PinnedHistoryControls | undefined;
  readonly reveal: PinnedSelectionReveal | null;
  readonly pin: PinnedSelection | null;
}): string | null {
  const pinRow = input.reveal
    ? input.rows.find((row) => row.kind === "message" && row.message.id === input.reveal?.messageId)
    : undefined;
  const historyLoads = useRef({ nonce: -1, count: 0 });
  const scrollAttempts = useRef({ nonce: -1, count: 0 });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pages earlier history until the pinned message is loaded
  useEffect(() => {
    const reveal = input.reveal;
    const history = input.historyControls;
    if (!reveal || !history?.hasMoreHistory || history.loading) return;
    const present = input.timelineEntries.some(
      (entry) => entry.kind === "message" && entry.message.id === reveal.messageId,
    );
    if (present) return;
    const bucket = historyLoads.current;
    if (bucket.nonce !== reveal.nonce) {
      bucket.nonce = reveal.nonce;
      bucket.count = 0;
    }
    if (bucket.count >= PIN_SCROLL_ATTEMPTS) return;
    bucket.count += 1;
    history.onLoadEarlier();
  }, [input.historyControls, input.reveal, input.timelineEntries]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the virtualized timeline to the pinned message
  useLayoutEffect(() => {
    const reveal = input.reveal;
    const viewport = input.viewport;
    if (!reveal || !viewport || !pinRow) return;
    const message = messageElement(viewport, reveal.messageId);
    if (message && messageIsVisible(message, viewport)) return;
    const attempts = scrollAttempts.current;
    if (attempts.nonce !== reveal.nonce) {
      attempts.nonce = reveal.nonce;
      attempts.count = 0;
    }
    if (attempts.count >= 4) return;
    const list = input.listRef.current;
    if (!list) return;
    const index = input.rows.indexOf(pinRow);
    if (index < 0) return;
    attempts.count += 1;
    void list.scrollToIndex({ index, animated: false, viewOffset: 72 });
  }, [input.listRef, input.reveal, input.rows, input.viewport, pinRow]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the CSS highlight for the pinned range and clears it on unmount
  useEffect(() => {
    const viewport = input.viewport;
    if (!viewport) return;
    const paint = () => paintPinnedSelection(viewport, input.pin);
    paint();
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        paint();
      });
    });
    observer.observe(viewport, { childList: true, subtree: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      if (typeof CSS !== "undefined" && CSS.highlights) {
        CSS.highlights.delete(PINNED_SELECTION_HIGHLIGHT_NAME);
      }
    };
  }, [input.pin, input.viewport]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for a message selection context menu while the timeline is mounted
  useEffect(() => {
    const viewport = input.viewport;
    const threadRef = input.threadRef;
    if (!viewport || !threadRef) return;
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest("a, button, [role=button]")) return;
      const draft = capturePinnedMessageSelection(viewport, window.getSelection());
      if (!draft) return;
      const api = readLocalApi();
      if (!api) return;
      event.preventDefault();
      void api.contextMenu
        .show(
          [
            { id: "pin", label: "Pin", icon: "pin" },
            { id: "copy", label: "Copy", icon: "copy" },
          ],
          { x: event.clientX, y: event.clientY },
        )
        .then((action) => {
          if (action === "pin") commitPinnedSelection(threadRef, draft);
          else if (action === "copy")
            void navigator.clipboard.writeText(draft.text).catch(() => {});
        })
        .catch(() => {});
    };
    viewport.addEventListener("contextmenu", onContextMenu);
    return () => viewport.removeEventListener("contextmenu", onContextMenu);
  }, [input.threadRef, input.viewport]);

  return pinRow?.id ?? null;
}
