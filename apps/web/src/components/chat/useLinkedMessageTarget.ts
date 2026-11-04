import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import type { TimelineEntry } from "../../session-logic";
import type { LinkedMessageRequest } from "../promptLinks/ThreadLinkParams";
import { toastManager } from "../ui/toast";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** Room above the linked message, so it does not sit flush against the top edge. */
const LINKED_MESSAGE_TOP_MARGIN = 24;
/** Index scrolling starts from estimates; stop correcting after about two seconds. */
const MAX_SETTLE_FRAMES = 120;

// Keep the deferred getter outside the hook: React Compiler cannot lower object getters.
function scrollToCurrentOffset(list: LegendListRef, scrollNode: HTMLElement) {
  return list.scrollToOffset({
    get offset() {
      return scrollNode.scrollTop;
    },
    animated: false,
  });
}

/**
 * Opens the timeline at a linked message: loads history through it, unfolds what hides it, and
 * scrolls it to the top. A scroll, key, or click from the user ends the navigation at any step.
 */
export function useLinkedMessageTarget({
  request,
  entries,
  rows,
  listRef,
  listReady,
  viewport,
  historyLoading,
  synced,
  onHandled,
  historyControls,
  onRevealEntry,
  onManualNavigation,
}: {
  request: LinkedMessageRequest | null;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  listReady: boolean;
  /** Receives the user's scroll, key, and pointer input. */
  viewport: HTMLElement | null;
  historyLoading: boolean;
  synced: boolean;
  onHandled?: ((key: string) => void) | undefined;
  historyControls: MessagesTimelineHistoryControls | undefined;
  /** Opens the folds that hide an entry. False when none does. */
  onRevealEntry: (entryId: string) => boolean;
  onManualNavigation: () => void;
}) {
  const [finishedKey, setFinishedKey] = useState<string | null>(null);
  const progressRef = useRef<{
    key: string;
    requestedPages: Set<string>;
    revealed: boolean;
  } | null>(null);
  const handledKeyRef = useRef<string | null>(null);
  const finishTarget = useStableCallback((handledKey: string) => {
    if (handledKeyRef.current === handledKey) return;
    handledKeyRef.current = handledKey;
    setFinishedKey(handledKey);
    onHandled?.(handledKey);
  });
  const positioning = request !== null && finishedKey !== request.key;
  const key = positioning ? request.key : null;
  const rowId = positioning
    ? (rows.find(
        (candidate) => candidate.kind === "message" && candidate.message.id === request.messageId,
      )?.id ?? null)
    : null;

  // Without a row yet, load history through the message or unfold what hides it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load remote history and reveal a target before imperative list positioning.
  useEffect(() => {
    if (!request || !positioning || rowId !== null || !synced) return;
    if (progressRef.current?.key !== request.key) {
      progressRef.current = { key: request.key, requestedPages: new Set(), revealed: false };
      onManualNavigation();
    }
    if (historyLoading) return;
    const progress = progressRef.current;
    const fail = (description: string) => {
      finishTarget(request.key);
      toastManager.add({
        type: "warning",
        title: "Could not open the linked message",
        description,
      });
    };
    const entry = entries.find(
      (candidate) => candidate.kind === "message" && candidate.message.id === request.messageId,
    );
    if (entry) {
      if (progress.revealed || !onRevealEntry(entry.id)) fail("Its turn could not be shown.");
      progress.revealed = true;
      return;
    }
    // An error from before this link's own load is not about the linked message.
    if (historyControls?.error && progress.requestedPages.size > 0) {
      fail(historyControls.error);
      return;
    }
    if (!historyControls?.hasMoreHistory) {
      fail("It is no longer in this thread.");
      return;
    }
    if (historyControls.loading) return;
    // Each page lands before the next request, so a cursor already asked for is still loading.
    const cursor = historyControls.historyCursor ?? "first";
    if (progress.requestedPages.has(cursor)) return;
    if (progress.requestedPages.size >= 20) {
      fail("Load earlier turns, then open the link again.");
      return;
    }
    progress.requestedPages.add(cursor);
    historyControls.onLoadEarlier(request.messageId);
  }, [
    entries,
    finishTarget,
    historyControls,
    historyLoading,
    onManualNavigation,
    onRevealEntry,
    positioning,
    request,
    rowId,
    synced,
  ]);

  // The user takes over at any step, including while history loads.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to native input that cancels pending list navigation.
  useEffect(() => {
    if (key === null || !viewport) return;
    const cancel = () => {
      finishTarget(key);
      const list = listRef.current;
      const scrollNode = list?.getScrollableNode();
      // Supersede a queued list scroll before the user's gesture runs. Legend may defer this
      // call too, so it reads the user's position when it executes.
      if (list && scrollNode instanceof HTMLElement) void scrollToCurrentOffset(list, scrollNode);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable=true]")
      )
        return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        cancel();
    };
    viewport.addEventListener("wheel", cancel, { passive: true });
    viewport.addEventListener("touchmove", cancel, { passive: true });
    viewport.addEventListener("pointerdown", cancel, { passive: true });
    viewport.ownerDocument.addEventListener("keydown", onKeyDown);
    return () => {
      viewport.removeEventListener("wheel", cancel);
      viewport.removeEventListener("touchmove", cancel);
      viewport.removeEventListener("pointerdown", cancel);
      viewport.ownerDocument.removeEventListener("keydown", onKeyDown);
    };
  }, [finishTarget, key, listRef, viewport]);

  // Scroll the row to the top, then correct for measured row sizes until it holds still.
  // History lands in stages, so a row shown mid-load can still move: wait for the last stage.
  const historySettled = synced && !historyLoading && historyControls?.loading !== true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Position the virtual list and correct offsets after DOM measurement.
  useEffect(() => {
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    if (key === null || rowId === null || !listReady || !historySettled || !list) return;
    if (!(scrollNode instanceof HTMLElement)) return;
    let stopped = false;
    let frame: number | null = null;
    let frames = 0;
    let stableFrames = 0;
    const finish = () => {
      stopped = true;
      finishTarget(key);
    };
    const settle = () => {
      frame = null;
      if (stopped) return;
      frames += 1;
      if (frames > MAX_SETTLE_FRAMES) {
        finish();
        return;
      }
      const state = list.getState();
      const index = state.indexByKey(rowId);
      const element = index === undefined ? undefined : state.elementAtIndex(index);
      if (!element) {
        frame = requestAnimationFrame(settle);
        return;
      }
      const offset = Math.max(
        0,
        Math.min(
          scrollNode.scrollTop +
            element.getBoundingClientRect().top -
            scrollNode.getBoundingClientRect().top -
            LINKED_MESSAGE_TOP_MARGIN,
          scrollNode.scrollHeight - scrollNode.clientHeight,
        ),
      );
      if (Math.abs(scrollNode.scrollTop - offset) > 1) {
        stableFrames = 0;
        void list.scrollToOffset({ offset, animated: false }).then(() => {
          if (!stopped) frame = requestAnimationFrame(settle);
        });
      } else {
        stableFrames += 1;
        if (stableFrames >= 2) {
          finish();
          // ChatView's thread-open effect can run after the opt-out at the start.
          onManualNavigation();
        } else {
          frame = requestAnimationFrame(settle);
        }
      }
    };
    const index = list.getState().indexByKey(rowId);
    void Promise.resolve(
      index === undefined
        ? undefined
        : list.scrollToIndex({
            index,
            animated: false,
            viewPosition: 0,
            viewOffset: LINKED_MESSAGE_TOP_MARGIN,
          }),
    ).then(() => {
      if (!stopped) frame = requestAnimationFrame(settle);
    });
    return () => {
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [finishTarget, historySettled, key, listReady, listRef, onManualNavigation, rowId]);

  return {
    positioning,
    pinnedRowId: rowId,
    alwaysRender: rowId === null ? undefined : { keys: [rowId] },
  };
}
