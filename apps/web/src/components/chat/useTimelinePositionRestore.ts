import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { RememberedTimelinePosition } from "./timelineScrollAnchoring";
import type { TimelineViewport } from "./timelineViewport";

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
 * and reports the thread positioned once the saved row settles. Any navigation
 * on the viewport cancels it where it is. Returns the cancel for the
 * operation's owner.
 */
export function startTimelinePositionRestore({
  list,
  viewport,
  listIdentityKey,
  listOpenedOn,
  rememberedPosition: position,
  citationPending,
  releaseForFind,
  onPositioned,
}: {
  readonly list: LegendListRef;
  readonly viewport: TimelineViewport;
  readonly listIdentityKey: string;
  /** The identity the mounted list opened on, until it shows another; see nextListOpening. */
  readonly listOpenedOn: string | null;
  readonly rememberedPosition: RememberedTimelinePosition | undefined;
  readonly citationPending: boolean;
  /**
   * Find was open when the list started showing the thread. Opening find is
   * navigation, so follow lets go; the thread still opens where it was left,
   * and MessagesTimeline holds find's reveal until this reports it positioned.
   */
  readonly releaseForFind: boolean;
  readonly onPositioned: (identity: string) => void;
}): () => void {
  if (citationPending) {
    // The citation scroll owns positioning once the list has mounted.
    onPositioned(listIdentityKey);
    return () => {};
  }
  let cancelled = false;
  const rows = list.getState().data as ReadonlyArray<MessagesTimelineRow>;
  const index = position ? rows.findIndex((row) => row.id === position.rowId) : -1;
  // Reading history or finding: follow lets go before the restore claims the viewport.
  if (position?.atEnd === false || releaseForFind) viewport.navigate({ releasesFollow: true });
  const releaseScrollHold = viewport.holdProgrammaticScroll();
  const stop = () => {
    cancelled = true;
    releaseScrollHold();
    unsubscribe();
  };
  const unsubscribe = viewport.subscribe(() => {
    if (cancelled) return;
    stop();
    void list.scrollToOffset({ offset: viewport.scrollNode.scrollTop, animated: false });
    onPositioned(listIdentityKey);
  });
  const finish = () => {
    stop();
    onPositioned(listIdentityKey);
  };
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
      : // initialScrollAtEnd measured this target; scrollToEnd would replace it with an estimate.
        listOpenedOn === listIdentityKey
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
    if (!cancelled) finish();
  });
  return stop;
}
