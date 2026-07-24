import { BookmarkIcon, XIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { type PromptStashEntry } from "../../promptStashStore";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import { Button } from "../ui/button";

const SNIPPET_MAX_CHARS = 90;

function stashEntrySnippet(entry: PromptStashEntry): string {
  const trimmed = entry.prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) {
    return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed;
  }
  const imageCount = entry.attachments.length + entry.droppedImageNames.length;
  return imageCount > 0 ? `(${imageCount} image${imageCount === 1 ? "" : "s"})` : "(empty)";
}

/**
 * Popover listing the current connection method's stashed prompts.
 * Keyboard-first: opened by ⌘S on an empty composer, navigated with
 * arrows, restored with Enter, dismissed with Escape. The listener runs
 * capture-phase on window so it wins over the Lexical editor's handlers
 * while the menu is open.
 */
export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  providerLabel: string;
  otherScopesCount: number;
  onRestore: (entry: PromptStashEntry) => void;
  onDelete: (entry: PromptStashEntry) => void;
  onClose: () => void;
}) {
  const { entries, onRestore, onDelete, onClose } = props;
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null);

  const highlightedEntry = entries.find((entry) => entry.id === highlightedId) ?? entries[0];

  useEffect(() => {
    if (entries.length === 0) return;
    if (!entries.some((entry) => entry.id === highlightedId)) {
      setHighlightedId(entries[0]?.id ?? null);
    }
  }, [entries, highlightedId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (entries.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = entries.findIndex((entry) => entry.id === highlightedId);
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const normalizedIndex = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0;
        const nextIndex = (normalizedIndex + offset + entries.length) % entries.length;
        setHighlightedId(entries[nextIndex]?.id ?? null);
        return;
      }
      if (event.key === "Enter") {
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onRestore(highlightedEntry);
        return;
      }
      if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onDelete(highlightedEntry);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [entries, highlightedEntry, highlightedId, onClose, onDelete, onRestore]);

  return (
    <Command autoHighlight={false} mode="none">
      <div className="dropdown-glass relative w-full overflow-hidden rounded-[20px]">
        <CommandList className="max-h-72">
          <CommandGroup>
            <CommandGroupLabel className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/55">
              <BookmarkIcon className="size-3" aria-hidden="true" />
              Stashed prompts — {props.providerLabel}
            </CommandGroupLabel>
            {entries.length === 0 ? (
              <p className="px-3 pb-3 pt-1 text-muted-foreground/70 text-xs">
                Nothing stashed for this method yet. Press ⌘S with a prompt in the composer to stash
                it.
              </p>
            ) : (
              entries.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  className={cn(
                    "group/stash cursor-pointer select-none gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
                    highlightedId === entry.id && "bg-accent! text-accent-foreground!",
                  )}
                  onMouseMove={() => {
                    if (highlightedId !== entry.id) setHighlightedId(entry.id);
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    onRestore(entry);
                  }}
                >
                  {entry.attachments.length > 0 ? (
                    <span className="flex shrink-0 items-center -space-x-1.5">
                      {entry.attachments.slice(0, 3).map((attachment) => (
                        <img
                          key={attachment.id}
                          src={attachment.dataUrl}
                          alt=""
                          aria-hidden="true"
                          className="size-5 rounded border border-border/70 object-cover"
                        />
                      ))}
                    </span>
                  ) : (
                    <BookmarkIcon className="size-4 shrink-0 text-muted-foreground/60" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {stashEntrySnippet(entry)}
                  </span>
                  {entry.droppedImageNames.length > 0 ? (
                    <span className="shrink-0 text-[10px] text-amber-600">
                      {entry.droppedImageNames.length} image
                      {entry.droppedImageNames.length === 1 ? "" : "s"} dropped
                    </span>
                  ) : null}
                  <span className="shrink-0 text-muted-foreground/60 text-xs">
                    {formatRelativeTimeLabel(entry.createdAt)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 opacity-0 transition-opacity group-hover/stash:opacity-100"
                    aria-label="Delete stashed prompt"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(entry);
                    }}
                  >
                    <XIcon />
                  </Button>
                </CommandItem>
              ))
            )}
          </CommandGroup>
          {props.otherScopesCount > 0 ? (
            <p className="border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground/60">
              {props.otherScopesCount} more stashed under other connection methods — switch provider
              to see them.
            </p>
          ) : null}
        </CommandList>
      </div>
    </Command>
  );
});
