import { type LegendListRef } from "@legendapp/list/react";
import { type RefObject, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { type ThreadId } from "@t3tools/contracts";
import {
  buildChatFindRows,
  type ChatFindMatch,
  type ChatFindRow,
  findChatFindMatches,
} from "./chatFind";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { useChatFindHighlight } from "./useChatFindHighlight";

const EMPTY_CHAT_FIND_ROWS: ChatFindRow[] = [];
const EMPTY_CHAT_FIND_MATCHES: ChatFindMatch[] = [];
const TIMELINE_ROW_ESTIMATED_SIZE_PX = 90;

function escapeAttributeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export interface ChatFindController {
  open: boolean;
  inputId: string;
  query: string;
  setQuery: (nextValue: string) => void;
  matches: ChatFindMatch[];
  activeMatchIndex: number;
  activeMatch: ChatFindMatch | null;
  openFind: () => void;
  closeFind: () => void;
  cycleMatch: (direction: -1 | 1) => void;
}

interface UseChatFindInput {
  timelineRows: ReadonlyArray<MessagesTimelineRow>;
  messagesViewportRef: RefObject<HTMLElement | null>;
  legendListRef: RefObject<LegendListRef | null>;
  routeThreadKey: string;
  /** Resets find state whenever the active thread changes. */
  activeThreadId: ThreadId | null;
}

/**
 * Owns the "find in chat" feature: search state, derived matches, DOM
 * highlighting, active-match scrolling, focus management, and reset on thread
 * change. The host component renders the search bar via {@link ChatFindController}
 * and wires keyboard shortcuts to {@link ChatFindController.openFind} etc.
 */
export function useChatFind(input: UseChatFindInput): ChatFindController {
  const { timelineRows, messagesViewportRef, legendListRef, routeThreadKey, activeThreadId } =
    input;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const inputId = useMemo(
    () => `chat-find-${routeThreadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    [routeThreadKey],
  );

  const rows = useMemo(
    () => (open ? buildChatFindRows(timelineRows) : EMPTY_CHAT_FIND_ROWS),
    [open, timelineRows],
  );
  const matches = useMemo(
    () =>
      deferredQuery.length > 0 ? findChatFindMatches(rows, deferredQuery) : EMPTY_CHAT_FIND_MATCHES,
    [rows, deferredQuery],
  );
  const activeMatchIndex = useMemo(
    () => matches.findIndex((match) => match.id === activeMatchId),
    [activeMatchId, matches],
  );
  const activeMatch = activeMatchIndex >= 0 ? (matches[activeMatchIndex] ?? null) : null;

  // DOM-based highlighting via CSS Custom Highlight API.
  useChatFindHighlight(
    messagesViewportRef,
    open ? deferredQuery : "",
    activeMatch?.rowId ?? null,
    activeMatch?.matchIndexInRow ?? 0,
  );

  const focusInput = useCallback(() => {
    const element = document.getElementById(inputId) as HTMLInputElement | null;
    if (!element) {
      return;
    }
    element.focus();
    element.select();
  }, [inputId]);

  const openFind = useCallback(() => {
    setOpen(true);
    focusInput();
  }, [focusInput]);

  const closeFind = useCallback(() => {
    setOpen(false);
  }, []);

  const cycleMatch = useCallback(
    (direction: -1 | 1) => {
      if (matches.length === 0) {
        return;
      }
      const nextIndex =
        activeMatchIndex >= 0
          ? (activeMatchIndex + direction + matches.length) % matches.length
          : direction > 0
            ? 0
            : matches.length - 1;
      setActiveMatchId(matches[nextIndex]?.id ?? null);
    },
    [activeMatchIndex, matches],
  );

  const scrollMatchIntoView = useCallback(
    (match: ChatFindMatch | null) => {
      if (!match) {
        return;
      }

      const rowSelector = `[data-timeline-row-id="${escapeAttributeSelectorValue(match.rowId)}"]`;
      const tryScroll = (attempt: number, offsetScrolled: boolean) => {
        const rowElement = document.querySelector<HTMLElement>(rowSelector);
        if (rowElement) {
          rowElement.scrollIntoView({ block: "nearest" });
          return;
        }

        if (!offsetScrolled) {
          legendListRef.current?.scrollToOffset?.({
            offset: match.rowIndex * TIMELINE_ROW_ESTIMATED_SIZE_PX,
            animated: false,
          });
        }

        if (attempt <= 0) {
          return;
        }
        window.requestAnimationFrame(() => tryScroll(attempt - 1, true));
      };

      window.requestAnimationFrame(() => tryScroll(3, false));
    },
    [legendListRef],
  );

  // Focus the input whenever the bar opens.
  useEffect(() => {
    if (!open) {
      return;
    }
    const element = document.getElementById(inputId) as HTMLInputElement | null;
    if (!element) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      element.focus();
      element.select();
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [inputId, open]);

  // Keep the active match valid as the match set changes.
  useEffect(() => {
    if (!open) {
      return;
    }
    if (matches.length === 0) {
      if (activeMatchId !== null) {
        setActiveMatchId(null);
      }
      return;
    }
    if (activeMatchId && matches.some((match) => match.id === activeMatchId)) {
      return;
    }
    setActiveMatchId(matches[0]?.id ?? null);
  }, [activeMatchId, matches, open]);

  // Scroll the active match into view.
  useEffect(() => {
    if (!open) {
      return;
    }
    scrollMatchIntoView(activeMatch);
  }, [activeMatch, open, scrollMatchIntoView]);

  // Reset whenever the active thread changes.
  useEffect(() => {
    setOpen(false);
    setQuery("");
    setActiveMatchId(null);
  }, [activeThreadId]);

  return {
    open,
    inputId,
    query,
    setQuery,
    matches,
    activeMatchIndex,
    activeMatch,
    openFind,
    closeFind,
    cycleMatch,
  };
}
