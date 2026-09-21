import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "../ui/button";
import { formatChatFindCount } from "./ChatFind.logic";
import type { CitationHistoryPage } from "./useAssistantCitationTarget";

const MAX_PREFILL_LENGTH = 200;

/** Text selected inside the timeline becomes the query, as in browser find. */
function selectedTimelineText(): string | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const anchor = selection.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  if (!element?.closest("[data-timeline-row-id]")) return null;
  const text = selection.toString().trim();
  return text.length > 0 && text.length <= MAX_PREFILL_LENGTH && !text.includes("\n") ? text : null;
}

export function ChatFindBar({
  query,
  onQueryChange,
  matchCount,
  activeIndex,
  onStep,
  onClose,
  focusRequestId,
  loadEarlier,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  matchCount: number;
  activeIndex: number;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
  /** Bumps when the shortcut or palette asks for the bar, even if already open. */
  focusRequestId: number;
  /** Non-null when older turns exist beyond the loaded window. */
  loadEarlier: CitationHistoryPage | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const handledFocusRequestRef = useRef<number | null>(null);

  // Only a new request refocuses; query edits must not move the caret.
  useEffect(() => {
    if (handledFocusRequestRef.current === focusRequestId) return;
    handledFocusRequestRef.current = focusRequestId;
    const selected = selectedTimelineText();
    if (selected !== null) onQueryChange(selected);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequestId, onQueryChange]);

  const hasQuery = query.trim().length > 0;

  return (
    <div
      role="search"
      aria-label="Find in thread"
      className="surface-glass absolute top-2 right-4 z-30 flex items-center gap-0.5 rounded-lg border border-border/60 p-1 shadow-sm"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Enter" && event.target === inputRef.current) {
          event.preventDefault();
          event.stopPropagation();
          onStep(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Find in thread"
        aria-label="Find text"
        autoComplete="off"
        spellCheck={false}
        className="h-7 w-40 bg-transparent px-2 text-sm outline-none placeholder:text-placeholder sm:w-48"
      />
      <span
        aria-live="polite"
        className="min-w-12 px-1 text-right text-muted-foreground text-xs tabular-nums"
      >
        {hasQuery ? formatChatFindCount(activeIndex, matchCount) : null}
      </span>
      {loadEarlier ? (
        <Button
          type="button"
          size="compact"
          variant="ghost-muted"
          disabled={loadEarlier.loading}
          onClick={loadEarlier.onLoadEarlier}
        >
          {loadEarlier.loading ? "Loading…" : "Load earlier"}
        </Button>
      ) : null}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost-muted"
        aria-label="Previous match"
        disabled={matchCount === 0}
        onClick={() => onStep(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost-muted"
        aria-label="Next match"
        disabled={matchCount === 0}
        onClick={() => onStep(1)}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost-muted"
        aria-label="Close find"
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  );
}
