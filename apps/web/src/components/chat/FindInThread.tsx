import { useCallback, useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

interface FindInThreadProps {
  query: string;
  onQueryChange: (query: string) => void;
  matchIndex: number;
  totalMatches: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function FindInThread({
  query,
  onQueryChange,
  matchIndex,
  totalMatches,
  onNext,
  onPrevious,
  onClose,
}: FindInThreadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onQueryChange(e.target.value);
    },
    [onQueryChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          onPrevious();
        } else {
          onNext();
        }
        return;
      }
    },
    [onClose, onNext, onPrevious],
  );

  const hasMatches = totalMatches > 0;

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs sm:px-5",
      )}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <svg
        className="size-3.5 shrink-0 text-muted-foreground/60"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Find in thread..."
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
      />
      {query && (
        <span className="whitespace-nowrap tabular-nums text-muted-foreground/60">
          {hasMatches ? `${matchIndex + 1}/${totalMatches}` : "0/0"}
        </span>
      )}
      {query && (
        <>
          <button
            type="button"
            onClick={onPrevious}
            disabled={!hasMatches}
            className="flex size-5 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-30"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            <svg
              className="size-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!hasMatches}
            className="flex size-5 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-30"
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <svg
              className="size-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </>
      )}
      <button
        type="button"
        onClick={onClose}
        className="flex size-5 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-foreground"
        title="Close (Escape)"
        aria-label="Close find"
      >
        <svg
          className="size-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  );
}
