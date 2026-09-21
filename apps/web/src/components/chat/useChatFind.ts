import type { LegendListRef } from "@legendapp/list/react";
import type { TurnId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { TimelineEntry } from "../../session-logic";
import {
  buildChatFindPattern,
  collectChatFindMatches,
  resolveActiveMatchIndex,
  stepChatFindIndex,
  type ChatFindMatch,
} from "./ChatFind.logic";
import {
  clearChatFindHighlights,
  collectChatFindRanges,
  paintChatFindHighlights,
} from "./chatFindHighlight";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

const ROW_SELECTOR = "[data-timeline-row-id]";
const REVEAL_EDGE_MARGIN = 48;
/** Frames to wait for a pinned row to be measured before giving up on the fine scroll. */
const MAX_REVEAL_ATTEMPTS = 60;

/**
 * Find-in-thread over the loaded timeline. Matches come from entry text so
 * unmounted and folded rows count; highlights are painted onto whatever rows
 * the virtualized list has mounted, and the active match is revealed by
 * unfolding its turn, pinning its row, and scrolling the range into view.
 */
export function useChatFind({
  enabled,
  query,
  entries,
  rows,
  listRef,
  viewport,
  onExpandTurn,
  onManualNavigation,
}: {
  enabled: boolean;
  query: string;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  viewport: HTMLElement | null;
  onExpandTurn: (turnId: TurnId) => void;
  onManualNavigation: () => void;
}) {
  const pattern = useMemo(() => (enabled ? buildChatFindPattern(query) : null), [enabled, query]);
  const matches = useMemo(() => collectChatFindMatches(entries, pattern), [entries, pattern]);
  // A new query restarts from the first match; the same query keeps its place.
  const [selection, setSelection] = useState<{ query: string; match: ChatFindMatch } | null>(null);
  const activeIndex = resolveActiveMatchIndex(
    matches,
    selection?.query === query ? selection.match : null,
  );
  const activeMatch = activeIndex >= 0 ? (matches[activeIndex] ?? null) : null;
  const targetKey = activeMatch
    ? JSON.stringify([query, activeMatch.entryId, activeMatch.occurrence])
    : null;

  const navigatedKeyRef = useRef<string | null>(null);
  const expandedKeyRef = useRef<string | null>(null);
  const pendingRevealRef = useRef<{ rowId: string; attempts: number } | null>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const paintStateRef = useRef({ pattern, matches, activeMatch });
  // The painter reads the latest matches at frame time instead of re-subscribing per update.
  useEffect(() => {
    paintStateRef.current = { pattern, matches, activeMatch };
    scheduleRef.current();
  }, [pattern, matches, activeMatch]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const next = stepChatFindIndex(activeIndex, matches.length, direction);
      const match = next >= 0 ? matches[next] : undefined;
      if (!match) return;
      // Re-reveal even when the match is unchanged, as with a single result.
      navigatedKeyRef.current = null;
      setSelection({ query, match });
    },
    [activeIndex, matches, query],
  );

  useEffect(() => {
    if (!enabled) {
      navigatedKeyRef.current = null;
      expandedKeyRef.current = null;
      pendingRevealRef.current = null;
    }
  }, [enabled]);

  // Reveal the active match: unfold its turn, then scroll its row near the top.
  useEffect(() => {
    if (!enabled || activeMatch === null || targetKey === null) return;
    if (navigatedKeyRef.current === targetKey) return;
    const list = listRef.current;
    if (!list) return;
    const rowIndex = rows.findIndex((row) => row.id === activeMatch.entryId);
    if (rowIndex < 0) {
      if (activeMatch.turnId !== null && expandedKeyRef.current !== targetKey) {
        expandedKeyRef.current = targetKey;
        onExpandTurn(activeMatch.turnId);
      }
      return;
    }
    navigatedKeyRef.current = targetKey;
    pendingRevealRef.current = { rowId: activeMatch.entryId, attempts: 0 };
    onManualNavigation();
    void list.scrollToIndex({ index: rowIndex, animated: false, viewPosition: 0.2 });
    scheduleRef.current();
  }, [activeMatch, enabled, listRef, onExpandTurn, onManualNavigation, rows, targetKey]);

  // Paint highlights over mounted rows; re-run as rows mount, unmount, or stream.
  useEffect(() => {
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    if (!enabled || !viewport || !list || !(scrollNode instanceof HTMLElement)) {
      scheduleRef.current = () => {};
      clearChatFindHighlights();
      return;
    }
    let frame: number | null = null;
    let stopped = false;
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(paint);
    };
    const paint = () => {
      frame = null;
      if (stopped) return;
      const state = paintStateRef.current;
      if (state.pattern === null || state.matches.length === 0) {
        clearChatFindHighlights();
        return;
      }
      const matchedEntryIds = new Set(state.matches.map((match) => match.entryId));
      const ranges: Range[] = [];
      let activeRange: Range | null = null;
      for (const rowElement of scrollNode.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
        const rowId = rowElement.dataset.timelineRowId;
        if (rowId === undefined || !matchedEntryIds.has(rowId)) continue;
        const rowRanges = collectChatFindRanges(rowElement, state.pattern);
        if (state.activeMatch !== null && rowId === state.activeMatch.entryId) {
          activeRange =
            rowRanges[Math.min(state.activeMatch.occurrence, rowRanges.length - 1)] ?? null;
          const pending = pendingRevealRef.current;
          if (pending?.rowId === rowId) {
            const listState = list.getState();
            const index = listState.indexByKey(rowId);
            // Estimated rows have not settled; try again after the next layout.
            if (
              (index === undefined || !(listState.sizeAtIndex(index) > 0)) &&
              pending.attempts++ < MAX_REVEAL_ATTEMPTS
            ) {
              schedule();
            } else {
              pendingRevealRef.current = null;
              if (activeRange) revealRange(activeRange, scrollNode, list);
            }
          }
        }
        for (const range of rowRanges) ranges.push(range);
      }
      paintChatFindHighlights(ranges, activeRange);
    };
    scheduleRef.current = schedule;
    const observer = new MutationObserver(schedule);
    observer.observe(scrollNode, { childList: true, characterData: true, subtree: true });
    schedule();
    return () => {
      stopped = true;
      scheduleRef.current = () => {};
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      clearChatFindHighlights();
    };
  }, [enabled, listRef, viewport]);

  const alwaysRender = useMemo(
    () => (enabled && activeMatch ? { keys: [activeMatch.entryId] } : undefined),
    [enabled, activeMatch],
  );

  return { matches, activeIndex, step, alwaysRender };
}

function revealRange(range: Range, scrollNode: HTMLElement, list: LegendListRef) {
  const rect = range.getBoundingClientRect();
  const scrollRect = scrollNode.getBoundingClientRect();
  if (rect.height <= 0 || scrollNode.clientHeight <= 0) return;
  const visible =
    rect.top >= scrollRect.top + REVEAL_EDGE_MARGIN &&
    rect.bottom <= scrollRect.bottom - REVEAL_EDGE_MARGIN;
  if (visible) return;
  const offset = Math.max(
    0,
    Math.min(
      scrollNode.scrollHeight - scrollNode.clientHeight,
      list.getState().scroll +
        rect.top -
        scrollRect.top -
        Math.min(160, scrollNode.clientHeight / 3),
    ),
  );
  void list.scrollToOffset({ offset, animated: false });
}
