import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface FindInChatBarProps {
  inputId: string;
  query: string;
  onQueryChange: (nextValue: string) => void;
  matchCount: number;
  activeMatchIndex: number;
  shortcutLabel: string | null;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function FindInChatBar(props: FindInChatBarProps) {
  const {
    inputId,
    query,
    onQueryChange,
    matchCount,
    activeMatchIndex,
    shortcutLabel,
    onPrevious,
    onNext,
    onClose,
  } = props;
  const matchLabel =
    query.trim().length === 0
      ? "Type to search"
      : matchCount === 0
        ? "No matches"
        : `${activeMatchIndex + 1} of ${matchCount}`;

  return (
    <div className="border-b border-border px-3 py-2 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            id={inputId}
            nativeInput
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={shortcutLabel ? `Find in chat (${shortcutLabel})` : "Find in chat"}
            className="pl-8"
            aria-label="Find in chat"
            spellCheck={false}
          />
        </div>
        <p className="min-w-20 text-right text-xs text-muted-foreground/70">{matchLabel}</p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            onClick={onPrevious}
            disabled={matchCount === 0}
            aria-label="Previous match"
          >
            <ChevronUpIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            onClick={onNext}
            disabled={matchCount === 0}
            aria-label="Next match"
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            onClick={onClose}
            aria-label="Close find in chat"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
