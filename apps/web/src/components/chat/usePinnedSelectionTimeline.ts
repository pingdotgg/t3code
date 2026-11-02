import type { LegendListRef } from "@legendapp/list/react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";

import { readLocalApi } from "../../localApi";
import {
  commitPinnedSelection,
  installPinnedSelectionContextMenu,
} from "../../pinnedSelectionReveal";
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

const PIN_SCROLL_ATTEMPTS = 12;
const PIN_VIEW_MARGIN = 72;
const PIN_HIGHLIGHT_OPACITY = "--pinned-selection-highlight-opacity";
const PIN_HIGHLIGHT_PEAK = 0.55;
const PIN_HIGHLIGHT_FADE_MS = 400;
const PIN_HIGHLIGHT_TOTAL_MS = 1400;

export interface PinnedRevealRect {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

export type PinnedRevealPlan =
  | { readonly type: "settled" }
  | { readonly type: "wait" }
  | { readonly type: "give-up" }
  | { readonly type: "load"; readonly throughEntryId: string; readonly cursor: string }
  | { readonly type: "scroll-index"; readonly index: number }
  | { readonly type: "scroll-offset"; readonly offset: number };

/** Decides the next jump. A mounted row still needs a measured scroll when it is off-screen. */
export function planPinnedRevealScroll(input: {
  readonly messageId: string;
  readonly messageInEntries: boolean;
  readonly rowIndex: number;
  readonly hasMoreHistory: boolean;
  readonly historyLoading: boolean;
  readonly historyCursor: string | null;
  readonly target: PinnedRevealRect | null;
  readonly scrollportTop: number;
  readonly scrollportHeight: number;
  readonly scroll: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): PinnedRevealPlan {
  if (input.target && input.target.height > 0 && input.scrollportHeight > 0) {
    const margin = Math.min(PIN_VIEW_MARGIN, Math.max(0, input.scrollportHeight / 5));
    const top = input.scrollportTop + margin;
    const bottom = input.scrollportTop + input.scrollportHeight - margin;
    const coversViewport = input.target.height >= input.scrollportHeight - margin * 2;
    const visible = coversViewport
      ? Math.abs(input.target.top - top) <= 2
      : input.target.bottom > top && input.target.top < bottom;
    if (visible) return { type: "settled" };
    const maxOffset = Math.max(0, input.scrollHeight - input.clientHeight);
    const offset = Math.min(maxOffset, Math.max(0, input.scroll + input.target.top - top));
    if (Math.abs(offset - input.scroll) > 1) return { type: "scroll-offset", offset };
    if (input.rowIndex >= 0) return { type: "scroll-index", index: input.rowIndex };
    return { type: "give-up" };
  }
  if (input.rowIndex >= 0) return { type: "scroll-index", index: input.rowIndex };
  if (!input.messageInEntries) {
    if (input.historyLoading) return { type: "wait" };
    if (input.hasMoreHistory && input.historyCursor) {
      return {
        type: "load",
        throughEntryId: input.messageId,
        cursor: input.historyCursor,
      };
    }
    return { type: "give-up" };
  }
  return { type: "wait" };
}

function messageElement(root: ParentNode, messageId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    `[data-message-role][data-message-id="${CSS.escape(messageId)}"]`,
  );
}

function revealTarget(
  root: ParentNode,
  messageId: string,
  pin: PinnedSelection | null,
): PinnedRevealRect | null {
  const message = messageElement(root, messageId);
  if (!message) return null;
  const range = pin ? resolvePinnedSelectionRange(message, pin) : null;
  const rect = (range ?? message).getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, height: rect.height };
}

function paintPinnedSelection(root: ParentNode, pin: PinnedSelection | null) {
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined")
    return null;
  if (!pin) {
    CSS.highlights.delete(PINNED_SELECTION_HIGHLIGHT_NAME);
    return null;
  }
  const message = messageElement(root, pin.messageId);
  if (!message) return null;
  const range = resolvePinnedSelectionRange(message, pin);
  if (!range) return null;
  CSS.highlights.set(PINNED_SELECTION_HIGHLIGHT_NAME, new Highlight(range));
  return message;
}

export function usePinnedSelectionTimeline(
  listRef: RefObject<LegendListRef | null>,
  input: {
    readonly threadRef: ScopedThreadRef | null;
    readonly rows: readonly MessagesTimelineRow[];
    readonly timelineEntries: readonly TimelineEntry[];
    readonly viewport: HTMLElement | null;
    readonly historyControls: PinnedHistoryControls | undefined;
    readonly reveal: PinnedSelectionReveal | null;
    readonly pin: PinnedSelection | null;
    readonly holdProgrammaticScroll: () => () => void;
    readonly releaseFollow: () => void;
  },
): { readonly alwaysRenderKey: string | null; readonly positioning: boolean } {
  const {
    threadRef,
    rows,
    timelineEntries,
    viewport,
    historyControls,
    reveal,
    pin,
    holdProgrammaticScroll,
    releaseFollow,
  } = input;
  const revealNonce = reveal?.nonce ?? null;
  const rowIndex =
    reveal === null
      ? -1
      : rows.findIndex((row) => row.kind === "message" && row.message.id === reveal.messageId);
  const messageInEntries =
    reveal !== null &&
    timelineEntries.some(
      (entry) => entry.kind === "message" && entry.message.id === reveal.messageId,
    );
  const historyCursor = timelineEntries[0]?.id ?? null;
  const hasMoreHistory = historyControls?.hasMoreHistory ?? false;
  const historyLoading = historyControls?.loading ?? false;
  const [trackedNonce, setTrackedNonce] = useState(revealNonce);
  const [attempt, setAttempt] = useState(0);
  const [settledNonce, setSettledNonce] = useState<number | null>(null);
  const requestedPages = useRef(new Set<string>());
  const pagesNonce = useRef<number | null>(null);
  const callbacks = useRef({ historyControls, releaseFollow, holdProgrammaticScroll });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest history loader and scroll hold for the jump effect
  useEffect(() => {
    callbacks.current = { historyControls, releaseFollow, holdProgrammaticScroll };
  }, [historyControls, releaseFollow, holdProgrammaticScroll]);
  if (trackedNonce !== revealNonce) {
    setTrackedNonce(revealNonce);
    setAttempt(0);
  }
  if (
    trackedNonce === revealNonce &&
    revealNonce !== null &&
    attempt >= PIN_SCROLL_ATTEMPTS &&
    settledNonce !== revealNonce
  ) {
    setSettledNonce(revealNonce);
  }
  const positioning = revealNonce !== null && settledNonce !== revealNonce;
  const pinRowId = rowIndex >= 0 ? rows[rowIndex]?.id : undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the virtualized timeline until the pinned text is in view
  useEffect(() => {
    if (revealNonce === null || settledNonce === revealNonce || attempt >= PIN_SCROLL_ATTEMPTS) {
      return;
    }
    if (!reveal || reveal.nonce !== revealNonce) return;
    if (pagesNonce.current !== revealNonce) {
      pagesNonce.current = revealNonce;
      requestedPages.current = new Set();
    }
    let cancelled = false;
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    const retry = () => {
      if (!cancelled) setAttempt((value) => value + 1);
    };
    const settle = () => {
      const frame = requestAnimationFrame(() => {
        if (!cancelled) setSettledNonce(revealNonce);
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    };
    if (!list || !(scrollNode instanceof HTMLElement)) {
      const frame = requestAnimationFrame(retry);
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    const root = viewport ?? scrollNode;
    const scrollport = scrollNode.getBoundingClientRect();
    const plan = planPinnedRevealScroll({
      messageId: reveal.messageId,
      messageInEntries,
      rowIndex,
      hasMoreHistory,
      historyLoading,
      historyCursor,
      target: revealTarget(root, reveal.messageId, pin),
      scrollportTop: scrollport.top,
      scrollportHeight: scrollport.height,
      scroll: list.getState().scroll,
      scrollHeight: scrollNode.scrollHeight,
      clientHeight: scrollNode.clientHeight,
    });
    if (plan.type === "settled" || plan.type === "give-up") return settle();
    if (plan.type === "wait") {
      if (historyLoading) return;
      const frame = requestAnimationFrame(retry);
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    if (plan.type === "load") {
      if (
        requestedPages.current.has(plan.cursor) ||
        requestedPages.current.size >= PIN_SCROLL_ATTEMPTS
      ) {
        if (historyLoading) return;
        return settle();
      }
      requestedPages.current.add(plan.cursor);
      callbacks.current.historyControls?.onLoadEarlier(plan.throughEntryId);
      return;
    }
    callbacks.current.releaseFollow();
    const releaseHold = callbacks.current.holdProgrammaticScroll();
    const animated = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scrolled =
      plan.type === "scroll-offset"
        ? list.scrollToOffset({ offset: plan.offset, animated })
        : list.scrollToIndex({
            index: plan.index,
            animated,
            viewPosition: 0,
            viewOffset: PIN_VIEW_MARGIN,
          });
    void scrolled.then(retry, retry);
    return () => {
      cancelled = true;
      releaseHold();
    };
  }, [
    attempt,
    hasMoreHistory,
    historyCursor,
    historyLoading,
    listRef,
    messageInEntries,
    pin,
    reveal,
    revealNonce,
    rowIndex,
    settledNonce,
    viewport,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints a short highlight once the pinned range is mounted
  useEffect(() => {
    const root = viewport;
    if (!root) return;
    const nonce = reveal?.nonce ?? null;
    let faded = false;
    let pulsed = false;
    let frame: number | null = null;
    let pulse: Animation | null = null;
    const paint = () => {
      frame = null;
      if (faded || nonce === null) {
        if (typeof CSS !== "undefined" && CSS.highlights) {
          CSS.highlights.delete(PINNED_SELECTION_HIGHLIGHT_NAME);
        }
        return;
      }
      const message = paintPinnedSelection(root, pin);
      if (!message || pulsed) return;
      pulsed = true;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const holdEnd = (PIN_HIGHLIGHT_TOTAL_MS - PIN_HIGHLIGHT_FADE_MS) / PIN_HIGHLIGHT_TOTAL_MS;
      pulse = message.animate(
        reduced
          ? [
              { offset: 0, [PIN_HIGHLIGHT_OPACITY]: PIN_HIGHLIGHT_PEAK },
              { offset: holdEnd, [PIN_HIGHLIGHT_OPACITY]: PIN_HIGHLIGHT_PEAK },
              { offset: 1, [PIN_HIGHLIGHT_OPACITY]: 0 },
            ]
          : [
              { offset: 0, [PIN_HIGHLIGHT_OPACITY]: 0 },
              { offset: 0.2, [PIN_HIGHLIGHT_OPACITY]: PIN_HIGHLIGHT_PEAK },
              { offset: holdEnd, [PIN_HIGHLIGHT_OPACITY]: PIN_HIGHLIGHT_PEAK },
              { offset: 1, [PIN_HIGHLIGHT_OPACITY]: 0 },
            ],
        { duration: PIN_HIGHLIGHT_TOTAL_MS, easing: "ease-out", fill: "forwards" },
      );
      void pulse.finished.then(
        () => {
          faded = true;
          pulse = null;
          if (typeof CSS !== "undefined" && CSS.highlights) {
            CSS.highlights.delete(PINNED_SELECTION_HIGHLIGHT_NAME);
          }
        },
        () => {},
      );
    };
    paint();
    const observer = new MutationObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(paint);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      pulse?.cancel();
      if (typeof CSS !== "undefined" && CSS.highlights) {
        CSS.highlights.delete(PINNED_SELECTION_HIGHLIGHT_NAME);
      }
    };
  }, [pin, reveal?.nonce, viewport]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- captures the selection before the native menu replaces it
  useEffect(() => {
    installPinnedSelectionContextMenu();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- web has no native Pin item, so the page menu handles it
  useEffect(() => {
    if (!viewport || !threadRef || window.desktopBridge) return;
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
  }, [threadRef, viewport]);

  return {
    alwaysRenderKey: positioning && pinRowId !== undefined ? pinRowId : null,
    positioning,
  };
}
