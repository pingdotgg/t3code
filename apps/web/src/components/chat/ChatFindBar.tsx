"use client";

import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Separator } from "../ui/separator";
import { Toggle } from "../ui/toggle";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { cn } from "~/lib/utils";
import {
  type ChatFindMatch,
  type ChatFindOptions,
  buildChatFindPattern,
  chatFindMatchKey,
  DEFAULT_CHAT_FIND_OPTIONS,
  deriveChatFindMatches,
  resolveChatFindActiveIndex,
  resolveChatFindStartIndex,
  stepChatFindIndex,
} from "./ChatFindBar.logic";
import {
  applyChatFindHighlights,
  clearChatFindHighlights,
  findMountedChatRow,
} from "./chatFindHighlight";
import { onOpenChatFind } from "./chatFindBus";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

const EMPTY_MATCHES: ReadonlyArray<ChatFindMatch> = [];
const REVEAL_VIEW_OFFSET = 96;
const REVEAL_TOP_MARGIN = 24;
const REVEAL_BOTTOM_FRACTION = 0.6;
const MAX_PREFILL_LENGTH = 200;

function readSelectionPrefill(): string | null {
  const selection = window.getSelection()?.toString() ?? "";
  const line = selection.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (line.length === 0 || line.length > MAX_PREFILL_LENGTH) return null;
  return line;
}

interface ChatFindBarProps {
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  topFadeEnabled: boolean;
  onManualNavigation: () => void;
}

interface ChatFindHighlightState {
  open: boolean;
  pattern: RegExp | null;
  matchRowIds: ReadonlySet<string>;
  activeMatch: ChatFindMatch | null;
}

export const ChatFindBar = memo(function ChatFindBar({
  rows,
  listRef,
  topFadeEnabled,
  onManualNavigation,
}: ChatFindBarProps) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ChatFindOptions>(DEFAULT_CHAT_FIND_OPTIONS);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusToken, setFocusToken] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef(false);
  const queryRef = useRef("");
  const activeMatchRef = useRef<ChatFindMatch | null>(null);
  const revealKeyRef = useRef<string | null>(null);
  const revealFirstMatchRef = useRef(false);
  const scrollingRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const highlightStateRef = useRef<ChatFindHighlightState>({
    open: false,
    pattern: null,
    matchRowIds: new Set(),
    activeMatch: null,
  });

  const trimmedQuery = query.trim();
  const pattern = useMemo(
    () => buildChatFindPattern(trimmedQuery, options),
    [options, trimmedQuery],
  );
  const matches = useMemo(
    () => (open && pattern !== null ? deriveChatFindMatches(rows, pattern) : EMPTY_MATCHES),
    [open, pattern, rows],
  );
  const matchRowIds = useMemo(() => new Set(matches.map((match) => match.rowId)), [matches]);
  const activeMatch = matches[activeIndex] ?? null;

  const runHighlight = useCallback(() => {
    frameRef.current = null;
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    if (!list || !(scrollNode instanceof HTMLElement)) return;
    const state = highlightStateRef.current;
    if (!state.open || state.pattern === null) {
      clearChatFindHighlights();
      return;
    }
    const activeRange = applyChatFindHighlights({
      scrollNode,
      pattern: state.pattern,
      matchRowIds: state.matchRowIds,
      active: state.activeMatch,
    });
    if (revealKeyRef.current === null || scrollingRef.current) return;
    if (
      state.activeMatch === null ||
      revealKeyRef.current !== chatFindMatchKey(state.activeMatch)
    ) {
      revealKeyRef.current = null;
      return;
    }
    if (activeRange === null) return;
    const rect = activeRange.getBoundingClientRect();
    if (rect.height <= 0) return;
    revealKeyRef.current = null;
    const scrollRect = scrollNode.getBoundingClientRect();
    const inView =
      rect.top >= scrollRect.top + REVEAL_TOP_MARGIN &&
      rect.bottom <= scrollRect.top + scrollNode.clientHeight * REVEAL_BOTTOM_FRACTION;
    if (inView) return;
    const listState = list.getState();
    const offset = Math.max(
      0,
      (listState.scroll ?? scrollNode.scrollTop) + rect.top - scrollRect.top - REVEAL_VIEW_OFFSET,
    );
    scrollingRef.current = true;
    void list.scrollToOffset({ offset, animated: true }).finally(() => {
      scrollingRef.current = false;
    });
  }, [listRef]);

  const scheduleHighlight = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(runHighlight);
  }, [runHighlight]);

  useLayoutEffect(() => {
    highlightStateRef.current = { open, pattern, matchRowIds, activeMatch };
    activeMatchRef.current = activeMatch;
    openRef.current = open;
    queryRef.current = trimmedQuery;
    if (open) scheduleHighlight();
  });

  const reveal = useCallback(
    (match: ChatFindMatch) => {
      const list = listRef.current;
      if (!list) return;
      onManualNavigation();
      revealKeyRef.current = chatFindMatchKey(match);
      const scrollNode = list.getScrollableNode();
      const mounted =
        scrollNode instanceof HTMLElement && findMountedChatRow(scrollNode, match.rowId) !== null;
      if (!mounted) {
        scrollingRef.current = true;
        void list
          .scrollToIndex({
            index: match.rowIndex,
            animated: true,
            viewOffset: REVEAL_VIEW_OFFSET,
          })
          .catch(() => {})
          .finally(() => {
            scrollingRef.current = false;
            scheduleHighlight();
          });
      }
      scheduleHighlight();
    },
    [listRef, onManualNavigation, scheduleHighlight],
  );

  useEffect(() => {
    setActiveIndex((current) =>
      resolveChatFindActiveIndex(matches, current, activeMatchRef.current),
    );
    if (!revealFirstMatchRef.current) return;
    revealFirstMatchRef.current = false;
    if (matches.length === 0) return;
    const scrollNode = listRef.current?.getScrollableNode();
    let fromRowIndex: number | null = null;
    if (scrollNode instanceof HTMLElement) {
      const top = scrollNode.getBoundingClientRect().top;
      for (const element of scrollNode.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
        if (element.getBoundingClientRect().bottom <= top) continue;
        const rowId = element.dataset.timelineRowId;
        const rowIndex = rows.findIndex((row) => row.id === rowId);
        if (rowIndex !== -1) fromRowIndex = rowIndex;
        break;
      }
    }
    const startIndex = resolveChatFindStartIndex(matches, fromRowIndex);
    setActiveIndex(startIndex);
    const match = matches[startIndex];
    if (match) reveal(match);
  }, [listRef, matches, reveal, rows]);

  useEffect(() => {
    if (!open) {
      clearChatFindHighlights();
      return;
    }
    const scrollNode = listRef.current?.getScrollableNode();
    if (!(scrollNode instanceof HTMLElement)) return;
    const observer = new MutationObserver(scheduleHighlight);
    observer.observe(scrollNode, { childList: true, characterData: true, subtree: true });
    const cancelReveal = () => {
      revealKeyRef.current = null;
    };
    scrollNode.addEventListener("wheel", cancelReveal, { passive: true });
    scrollNode.addEventListener("touchstart", cancelReveal, { passive: true });
    return () => {
      observer.disconnect();
      scrollNode.removeEventListener("wheel", cancelReveal);
      scrollNode.removeEventListener("touchstart", cancelReveal);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      clearChatFindHighlights();
    };
  }, [listRef, open, scheduleHighlight]);

  const restartFromQuery = useCallback((value: string) => {
    setQuery(value);
    setActiveIndex(0);
    activeMatchRef.current = null;
    revealFirstMatchRef.current = value.trim().length > 0;
  }, []);

  const openBar = useCallback(() => {
    const prefill = readSelectionPrefill();
    if (prefill !== null) {
      restartFromQuery(prefill);
    } else if (!openRef.current && queryRef.current.length > 0) {
      activeMatchRef.current = null;
      revealFirstMatchRef.current = true;
    }
    setOpen(true);
    setFocusToken((token) => token + 1);
  }, [restartFromQuery]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "chat.find") return;
      event.preventDefault();
      event.stopPropagation();
      openBar();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, openBar]);

  useEffect(() => onOpenChatFind(openBar), [openBar]);

  useEffect(() => {
    if (!open || focusToken === 0) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusToken, open]);

  const close = useCallback(() => {
    setOpen(false);
    revealKeyRef.current = null;
    revealFirstMatchRef.current = false;
  }, []);

  const step = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      const nextIndex = stepChatFindIndex(activeIndex, matches.length, direction);
      setActiveIndex(nextIndex);
      const match = matches[nextIndex];
      if (match) reveal(match);
    },
    [activeIndex, matches, reveal],
  );

  const toggleOption = useCallback((key: keyof ChatFindOptions) => {
    setOptions((current) => ({ ...current, [key]: !current[key] }));
    setActiveIndex(0);
    activeMatchRef.current = null;
    revealFirstMatchRef.current = queryRef.current.length > 0;
  }, []);

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        step(event.shiftKey ? -1 : 1);
      }
    },
    [close, step],
  );

  if (!open) return null;

  const hasQuery = trimmedQuery.length > 0;
  const countLabel = !hasQuery
    ? null
    : matches.length === 0
      ? "No matches"
      : `${activeIndex + 1} of ${matches.length}`;

  return (
    <div
      role="search"
      aria-label="Find in chat"
      data-chat-find-bar="true"
      className={cn(
        "absolute right-4 z-30 flex h-8 w-[24rem] max-w-[calc(100%-2rem)] items-center gap-0.5 rounded-lg border border-border/70 bg-popover/95 p-0.5 shadow-md/10 backdrop-blur",
        topFadeEnabled ? "top-[var(--workspace-titlebar-scroll-fade-height)]" : "top-2",
      )}
    >
      <SearchIcon aria-hidden className="ms-1.5 size-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        unstyled
        type="search"
        size="sm"
        value={query}
        onChange={(event) => restartFromQuery(event.currentTarget.value)}
        onKeyDown={onInputKeyDown}
        placeholder="Find in chat"
        aria-label="Find in chat"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="min-w-0 flex-1 text-sm [&_input]:px-1.5"
      />
      <span
        className={cn(
          "min-w-[4.75rem] shrink-0 whitespace-nowrap px-1.5 text-end text-xs tabular-nums text-muted-foreground",
          hasQuery && matches.length === 0 && "text-destructive-foreground",
        )}
        aria-live="polite"
      >
        {countLabel}
      </span>
      <Separator orientation="vertical" className="mx-0.5 h-4 bg-border/70" />
      <Toggle
        variant="ghost"
        size="xs"
        aria-label="Match case"
        title="Match case"
        pressed={options.caseSensitive}
        onPressedChange={() => toggleOption("caseSensitive")}
        className="size-7 min-w-0 px-0 font-mono text-xs text-muted-foreground data-pressed:text-foreground sm:size-6"
      >
        Aa
      </Toggle>
      <Toggle
        variant="ghost"
        size="xs"
        aria-label="Match whole word"
        title="Match whole word"
        pressed={options.wholeWord}
        onPressedChange={() => toggleOption("wholeWord")}
        className="size-7 min-w-0 px-0 font-mono text-xs text-muted-foreground data-pressed:text-foreground sm:size-6"
      >
        <span className="underline decoration-2 underline-offset-2">ab</span>
      </Toggle>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={matches.length === 0}
        onClick={() => step(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={matches.length === 0}
        onClick={() => step(1)}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label="Close find"
        title="Close (Esc)"
        onClick={close}
      >
        <XIcon />
      </Button>
    </div>
  );
});
