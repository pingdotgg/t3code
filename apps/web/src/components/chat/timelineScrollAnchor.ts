import type { RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";

export interface TimelineScrollAnchor {
  readonly rowId: string;
  readonly offsetTop: number;
}

export interface ScheduledTimelineScrollAnchorRestore {
  readonly cancel: () => void;
}

interface TimelineScrollAnchorScheduler {
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
  readonly setTimeout: (callback: () => void, delay: number) => number;
  readonly clearTimeout: (handle: number) => void;
}

interface ScheduleTimelineScrollAnchorRestoreInput {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly anchor: TimelineScrollAnchor;
  readonly shouldCancel?: () => boolean;
  readonly frameCount?: number;
  readonly settleDelaysMs?: readonly number[];
  readonly scheduler?: TimelineScrollAnchorScheduler;
}

const TIMELINE_ROW_SELECTOR = "[data-timeline-row-id]";
const TIMELINE_ANCHOR_RESTORE_FRAME_COUNT = 4;
const TIMELINE_ANCHOR_RESTORE_SETTLE_DELAYS_MS = [80, 180] as const;

const defaultScheduler: TimelineScrollAnchorScheduler = {
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

function getScrollableNode(listRef: LegendListRef | null): HTMLElement | null {
  return listRef?.getScrollableNode?.() ?? null;
}

function getTimelineRows(scrollableNode: HTMLElement): HTMLElement[] {
  return Array.from(scrollableNode.querySelectorAll<HTMLElement>(TIMELINE_ROW_SELECTOR));
}

function getRowId(row: HTMLElement): string | null {
  const rowId = row.dataset.timelineRowId;
  return rowId && rowId.length > 0 ? rowId : null;
}

function getRelativeTop(row: HTMLElement, scrollableNode: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollableNode.getBoundingClientRect().top;
}

function findTimelineRowById(scrollableNode: HTMLElement, rowId: string): HTMLElement | null {
  for (const row of getTimelineRows(scrollableNode)) {
    if (getRowId(row) === rowId) {
      return row;
    }
  }
  return null;
}

export function captureTimelineScrollAnchor(
  listRef: LegendListRef | null,
): TimelineScrollAnchor | null {
  const scrollableNode = getScrollableNode(listRef);
  if (!scrollableNode) {
    return null;
  }

  const scrollableRect = scrollableNode.getBoundingClientRect();
  let anchorRow: HTMLElement | null = null;
  let anchorTop = Number.POSITIVE_INFINITY;

  for (const row of getTimelineRows(scrollableNode)) {
    const rowId = getRowId(row);
    if (!rowId) {
      continue;
    }

    const rowRect = row.getBoundingClientRect();
    if (rowRect.height <= 0 || rowRect.bottom <= scrollableRect.top) {
      continue;
    }
    if (rowRect.top >= scrollableRect.bottom) {
      continue;
    }
    if (rowRect.top < anchorTop) {
      anchorTop = rowRect.top;
      anchorRow = row;
    }
  }

  if (!anchorRow) {
    return null;
  }

  const rowId = getRowId(anchorRow);
  if (!rowId) {
    return null;
  }

  return {
    rowId,
    offsetTop: getRelativeTop(anchorRow, scrollableNode),
  };
}

export function restoreTimelineScrollAnchor(
  listRef: LegendListRef | null,
  anchor: TimelineScrollAnchor,
): boolean {
  const scrollableNode = getScrollableNode(listRef);
  if (!scrollableNode) {
    return false;
  }

  const anchorRow = findTimelineRowById(scrollableNode, anchor.rowId);
  if (!anchorRow) {
    return false;
  }

  const delta = getRelativeTop(anchorRow, scrollableNode) - anchor.offsetTop;
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) {
    return true;
  }

  scrollableNode.scrollTop += delta;
  return true;
}

export function scheduleTimelineScrollAnchorRestore({
  listRef,
  anchor,
  shouldCancel,
  frameCount = TIMELINE_ANCHOR_RESTORE_FRAME_COUNT,
  settleDelaysMs = TIMELINE_ANCHOR_RESTORE_SETTLE_DELAYS_MS,
  scheduler = defaultScheduler,
}: ScheduleTimelineScrollAnchorRestoreInput): ScheduledTimelineScrollAnchorRestore {
  let cancelled = false;
  const frameHandles = new Set<number>();
  const timeoutHandles = new Set<number>();

  const cancel = () => {
    cancelled = true;
    for (const frameHandle of frameHandles) {
      scheduler.cancelAnimationFrame(frameHandle);
    }
    frameHandles.clear();
    for (const timeoutHandle of timeoutHandles) {
      scheduler.clearTimeout(timeoutHandle);
    }
    timeoutHandles.clear();
  };

  const isCancelled = () => {
    if (cancelled || shouldCancel?.()) {
      cancel();
      return true;
    }
    return false;
  };

  const scheduleFrameLoop = (remainingFrames: number) => {
    if (remainingFrames <= 0 || isCancelled()) {
      return;
    }

    const frameHandle = scheduler.requestAnimationFrame(() => {
      frameHandles.delete(frameHandle);
      if (isCancelled()) {
        return;
      }

      restoreTimelineScrollAnchor(listRef.current, anchor);
      scheduleFrameLoop(remainingFrames - 1);
    });
    frameHandles.add(frameHandle);
  };

  scheduleFrameLoop(frameCount);
  if (isCancelled()) {
    return { cancel };
  }

  for (const delay of settleDelaysMs) {
    const timeoutHandle = scheduler.setTimeout(() => {
      timeoutHandles.delete(timeoutHandle);
      scheduleFrameLoop(Math.max(1, Math.min(2, frameCount)));
    }, delay);
    timeoutHandles.add(timeoutHandle);
  }

  return { cancel };
}
