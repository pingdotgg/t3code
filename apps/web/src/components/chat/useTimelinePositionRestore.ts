import { useLayoutEffect, useRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { AssistantCitationRequest } from "./AssistantCitationSource";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { RememberedTimelinePosition } from "./timelineScrollAnchoring";

// A streaming reply moves the end every frame, so the target may never hold
// still. Past this many frames the list's own end maintenance takes over.
const SETTLE_MAX_FRAMES = 60;

/**
 * Index and end scrolling start from estimated row sizes, so they can stop
 * short of a tall row. Corrects against the DOM until the viewport holds the
 * target for two layout frames, the frame budget runs out, the caller cancels,
 * or the target disappears.
 */
export function settleListScroll(
  list: Pick<LegendListRef, "getScrollableNode" | "scrollToOffset">,
  target: (element: HTMLElement) => number | undefined,
  isCancelled: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    let stableFrames = 0;
    let frames = 0;
    const reconcile = () => {
      if (isCancelled()) return resolve();
      const element = list.getScrollableNode();
      const offset = element ? target(element) : undefined;
      frames += 1;
      if (!element || offset === undefined || frames > SETTLE_MAX_FRAMES) return resolve();
      if (Math.abs(element.scrollTop - offset) > 1) {
        stableFrames = 0;
        void list.scrollToOffset({ offset, animated: false }).then(() => {
          requestAnimationFrame(reconcile);
        });
        return;
      }
      stableFrames += 1;
      if (stableFrames >= 2) resolve();
      else requestAnimationFrame(reconcile);
    };
    requestAnimationFrame(reconcile);
  });
}

export const measuredEndOffset = (element: HTMLElement) =>
  element.scrollHeight - element.clientHeight;

/**
 * Scrolls a newly shown thread back to where the user left it, or to its end,
 * and reports the thread positioned once the saved row settles.
 */
export function useTimelinePositionRestore({
  listRef,
  listIdentityKey,
  restoringThreadPosition,
  rememberedPosition,
  rows,
  citationRequest,
  cancelPositionRestoreRef,
  onManualNavigation,
  onPositioned,
}: {
  readonly listRef: React.RefObject<LegendListRef | null>;
  readonly listIdentityKey: string;
  readonly restoringThreadPosition: boolean;
  readonly rememberedPosition: RememberedTimelinePosition | undefined;
  readonly rows: MessagesTimelineRow[];
  readonly citationRequest: AssistantCitationRequest | null;
  readonly cancelPositionRestoreRef: React.RefObject<(() => void) | null> | undefined;
  readonly onManualNavigation: () => void;
  readonly onPositioned: (identity: string) => void;
}) {
  // Preserve initialScrollAtEnd's measured target until the list is reused
  // for another thread; scrollToEnd would replace it with an estimated offset.
  const listOpenedOnRef = useRef<{
    readonly list: LegendListRef;
    identity: string | null;
  } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const opened = listOpenedOnRef.current;
    if (!list) return;
    if (opened?.list !== list) {
      listOpenedOnRef.current = { list, identity: listIdentityKey };
    } else if (opened.identity !== listIdentityKey) {
      opened.identity = null;
    }
  });
  useLayoutEffect(() => {
    if (!restoringThreadPosition || rows.length === 0) return;
    const list = listRef.current;
    if (!list) return;
    if (citationRequest !== null) {
      // The citation scroll owns positioning once the list has mounted.
      onPositioned(listIdentityKey);
      return;
    }
    let cancelled = false;
    const viewport: HTMLElement | null = list.getScrollableNode();
    const cancelRestoration = () => {
      if (cancelled) return;
      cancelled = true;
      if (viewport) void list.scrollToOffset({ offset: viewport.scrollTop, animated: false });
      onPositioned(listIdentityKey);
    };
    const cancelForNavigation = () => {
      cancelRestoration();
      onManualNavigation();
    };
    const onScrollKey = (event: globalThis.KeyboardEvent) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, [contenteditable=true]")
        )
      )
        cancelForNavigation();
    };
    viewport?.addEventListener("wheel", cancelForNavigation, { passive: true });
    viewport?.addEventListener("touchmove", cancelForNavigation, { passive: true });
    viewport?.addEventListener("pointerdown", cancelForNavigation, { passive: true });
    viewport?.ownerDocument.addEventListener("keydown", onScrollKey);
    const position = rememberedPosition;
    const index = position ? rows.findIndex((row) => row.id === position.rowId) : -1;
    if (position?.atEnd === false) onManualNavigation();
    if (cancelPositionRestoreRef) cancelPositionRestoreRef.current = cancelRestoration;
    const scrolling =
      position?.atEnd === false
        ? index >= 0
          ? list.scrollToIndex({
              index,
              animated: false,
              viewPosition: 0,
              viewOffset: -position.offsetWithinRow,
            })
          : list.scrollToOffset({ offset: position.scrollOffset, animated: false })
        : listOpenedOnRef.current?.identity === listIdentityKey
          ? undefined
          : list.scrollToEnd({ animated: false });
    const settlesAtEnd = position?.atEnd !== false && scrolling !== undefined;
    void Promise.resolve(scrolling).then(async () => {
      if (cancelled) return;
      if (settlesAtEnd) {
        await settleListScroll(list, measuredEndOffset, () => cancelled);
      } else if (position?.atEnd === false && index >= 0) {
        // Keep the saved row mounted until its measured position and the DOM agree.
        await settleListScroll(
          list,
          (element) => {
            const state = list.getState();
            const rowIndex = state.indexByKey(position.rowId);
            const row = rowIndex === undefined ? undefined : state.elementAtIndex(rowIndex);
            if (!row) return undefined;
            return Math.max(
              0,
              Math.min(
                element.scrollTop +
                  row.getBoundingClientRect().top -
                  element.getBoundingClientRect().top +
                  position.offsetWithinRow,
                measuredEndOffset(element),
              ),
            );
          },
          () => cancelled,
        );
      }
      if (!cancelled) onPositioned(listIdentityKey);
    });
    return () => {
      cancelled = true;
      if (cancelPositionRestoreRef?.current === cancelRestoration) {
        cancelPositionRestoreRef.current = null;
      }
      viewport?.removeEventListener("wheel", cancelForNavigation);
      viewport?.removeEventListener("touchmove", cancelForNavigation);
      viewport?.removeEventListener("pointerdown", cancelForNavigation);
      viewport?.ownerDocument.removeEventListener("keydown", onScrollKey);
    };
  }, [
    citationRequest,
    cancelPositionRestoreRef,
    listIdentityKey,
    listRef,
    onManualNavigation,
    onPositioned,
    rememberedPosition,
    restoringThreadPosition,
    rows,
  ]);
}
