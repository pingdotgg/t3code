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
/** The parts of a row whose text is counted; row chrome such as the hidden author heading is not. */
const BODY_SELECTOR =
  "[data-user-message-body], [data-assistant-citation-source], [data-chat-find-body]";
const REVEAL_EDGE_MARGIN = 48;
/** Frames to wait for a pinned row to be measured before giving up on the fine scroll. */
const MAX_REVEAL_ATTEMPTS = 60;

/**
 * Find-in-thread over the loaded timeline. Matches come from entry text so
 * unmounted and folded rows count; highlights are painted onto whatever rows
 * the virtualized list has mounted, and the active match is revealed by
 * unfolding its turn, pinning its row, and scrolling the range into view.
 * Rows read `activeEntryId` from the row context to expand clipped bodies.
 */
export function useChatFind({
  enabled,
  entries,
  rows,
  listRef,
  viewport,
  cwd,
  bottomInset,
  onExpandTurn,
  onManualNavigation,
}: {
  enabled: boolean;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  viewport: HTMLElement | null;
  cwd: string | undefined;
  /** Height of the composer overlay covering the bottom of the scroll node. */
  bottomInset: number;
  onExpandTurn: (turnId: TurnId) => void;
  onManualNavigation: () => void;
}) {
  const [query, setQueryState] = useState("");
  const pattern = useMemo(() => (enabled ? buildChatFindPattern(query) : null), [enabled, query]);
  const matches = useMemo(
    () => collectChatFindMatches(entries, pattern, cwd),
    [cwd, entries, pattern],
  );
  // The stepped-to match, kept by identity while history prepends or streams.
  const [selection, setSelection] = useState<ChatFindMatch | null>(null);
  // Each step is its own reveal request, so Enter re-reveals a lone result
  // and re-unfolds a turn that folded again since the last visit.
  const [revealRequest, setRevealRequest] = useState(0);
  // A new query restarts from the first match; stepping picks one explicitly.
  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setSelection(null);
  }, []);
  // The first match is adopted as the selection so a prepended page cannot move it.
  if (selection === null && matches.length > 0) setSelection(matches[0]!);
  const activeIndex = resolveActiveMatchIndex(matches, selection);
  const activeMatch = activeIndex >= 0 ? (matches[activeIndex] ?? null) : null;
  const targetKey = activeMatch
    ? JSON.stringify([query, activeMatch.entryId, activeMatch.occurrence, revealRequest])
    : null;

  const navigatedKeyRef = useRef<string | null>(null);
  const expandedKeyRef = useRef<string | null>(null);
  const pendingRevealRef = useRef<{ rowId: string; attempts: number } | null>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const paintStateRef = useRef({ pattern, matches, activeMatch, bottomInset });
  // The painter reads the latest matches at frame time instead of re-subscribing per update.
  useEffect(() => {
    paintStateRef.current = { pattern, matches, activeMatch, bottomInset };
    scheduleRef.current();
  }, [activeMatch, bottomInset, matches, pattern]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const next = stepChatFindIndex(activeIndex, matches.length, direction);
      const match = next >= 0 ? matches[next] : undefined;
      if (!match) return;
      setSelection(match);
      setRevealRequest((request) => request + 1);
    },
    [activeIndex, matches],
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
        const bodies = rowElement.querySelectorAll<HTMLElement>(BODY_SELECTOR);
        const rowRanges = collectChatFindRanges(
          bodies.length > 0 ? bodies : [rowElement],
          state.pattern,
        );
        if (state.activeMatch !== null && rowId === state.activeMatch.entryId) {
          // Source text can count hits the renderer never shows; fall back to
          // the last painted one so stepping still lands in the right row.
          const exact = rowRanges[state.activeMatch.occurrence];
          activeRange = exact ?? rowRanges[rowRanges.length - 1] ?? null;
          const pending = pendingRevealRef.current;
          if (pending?.rowId === rowId) {
            const listState = list.getState();
            const index = listState.indexByKey(rowId);
            const settled = index !== undefined && listState.sizeAtIndex(index) > 0;
            // Wait until the row is measured and the exact range exists: a
            // clipped body may still be expanding and a code block may still
            // show its loading fallback.
            if (
              settled &&
              exact !== undefined &&
              revealRange(exact, scrollNode, list, state.bottomInset)
            ) {
              pendingRevealRef.current = null;
            } else if (pending.attempts++ < MAX_REVEAL_ATTEMPTS) {
              schedule();
            } else {
              pendingRevealRef.current = null;
              if (activeRange) revealRange(activeRange, scrollNode, list, state.bottomInset);
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
    // The user taking over the scroll position ends a pending reveal.
    const cancelReveal = () => {
      pendingRevealRef.current = null;
    };
    const cancelEvents = ["wheel", "touchmove", "pointerdown"] as const;
    for (const type of cancelEvents) {
      scrollNode.addEventListener(type, cancelReveal, { passive: true });
    }
    schedule();
    return () => {
      stopped = true;
      scheduleRef.current = () => {};
      observer.disconnect();
      for (const type of cancelEvents) scrollNode.removeEventListener(type, cancelReveal);
      if (frame !== null) cancelAnimationFrame(frame);
      clearChatFindHighlights();
    };
  }, [enabled, listRef, viewport]);

  const alwaysRender = useMemo(
    () => (enabled && activeMatch ? { keys: [activeMatch.entryId] } : undefined),
    [enabled, activeMatch],
  );

  return {
    query,
    setQuery,
    matches,
    activeIndex,
    activeEntryId: activeMatch?.entryId ?? null,
    step,
    alwaysRender,
  };
}

/**
 * Scrolls the range into the part of the viewport not covered by the composer.
 * Returns false while the target is not reachable yet, because the list has
 * not measured the row's expanded size, so the caller retries next frame.
 */
function revealRange(
  range: Range,
  scrollNode: HTMLElement,
  list: LegendListRef,
  bottomInset: number,
): boolean {
  const rect = range.getBoundingClientRect();
  const scrollRect = scrollNode.getBoundingClientRect();
  if (rect.height <= 0 || scrollNode.clientHeight <= 0) return false;
  const visibleTop = scrollRect.top + REVEAL_EDGE_MARGIN;
  const visibleBottom = scrollRect.bottom - bottomInset - REVEAL_EDGE_MARGIN;
  if (rect.top >= visibleTop && rect.bottom <= visibleBottom) return true;
  const maxOffset = scrollNode.scrollHeight - scrollNode.clientHeight;
  const current = list.getState().scroll;
  const wanted = current + rect.top - scrollRect.top - Math.min(160, scrollNode.clientHeight / 3);
  const offset = Math.max(0, Math.min(maxOffset, wanted));
  if (Math.abs(offset - current) >= 1) void list.scrollToOffset({ offset, animated: false });
  // A clamped scroll from anywhere but the end means the row is not measured yet.
  return wanted <= maxOffset || current >= maxOffset - 1;
}
