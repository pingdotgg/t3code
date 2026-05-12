import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";

interface ThreadSearchBarProps {
  query: string;
  resultCount: number;
  activeResultIndex: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function ThreadSearchBar({
  query,
  resultCount,
  activeResultIndex,
  inputRef,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: ThreadSearchBarProps) {
  const countLabel =
    query.trim().length === 0
      ? "Type to search"
      : resultCount === 0
        ? "No matches"
        : `${Math.min(Math.max(activeResultIndex, 0) + 1, resultCount)} / ${resultCount}`;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      onPrevious();
      return;
    }
    onNext();
  };

  return (
    <div
      className="pointer-events-auto flex w-full max-w-xl items-center gap-2 rounded-2xl border border-border/80 bg-card/95 p-2 shadow-lg backdrop-blur-sm"
      data-testid="thread-search-bar"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
        <SearchIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find in thread"
          aria-label="Find in thread"
          nativeInput
          size="sm"
          type="search"
          data-testid="thread-search-input"
        />
      </div>
      <div className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex">
        <span className="min-w-12 text-right tabular-nums" data-testid="thread-search-count">
          {countLabel}
        </span>
        <Kbd>Enter</Kbd>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={resultCount === 0}
          aria-label="Previous search result"
          onClick={onPrevious}
        >
          <ChevronUpIcon className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={resultCount === 0}
          aria-label="Next search result"
          onClick={onNext}
        >
          <ChevronDownIcon className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Close search"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
