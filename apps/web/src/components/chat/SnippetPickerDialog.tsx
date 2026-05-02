import { FileTextIcon, Trash2Icon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "~/lib/utils";
import {
  searchComposerSnippets,
  summarizeComposerSnippetDescription,
  type ComposerSnippet,
} from "./composerSnippets";

interface SnippetPickerDialogProps {
  open: boolean;
  snippets: ReadonlyArray<ComposerSnippet>;
  focusRequestId: number;
  currentDraftText: string;
  onOpenChange: (open: boolean) => void;
  onSaveDraftAsSnippet: () => void;
  onSelectSnippet: (snippet: ComposerSnippet) => void;
  onDeleteSnippet: (snippet: ComposerSnippet) => void;
}

function formatSnippetTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SnippetPickerDialog(props: SnippetPickerDialogProps) {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    if (!props.open) {
      setQuery("");
      setHighlightedIndex(0);
      return;
    }
    setQuery("");
    setHighlightedIndex(0);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [props.focusRequestId, props.open]);

  const filteredSnippets = useMemo(
    () => searchComposerSnippets(props.snippets, deferredQuery),
    [deferredQuery, props.snippets],
  );

  useEffect(() => {
    if (filteredSnippets.length === 0) {
      setHighlightedIndex(0);
      return;
    }
    setHighlightedIndex((current) => Math.min(current, filteredSnippets.length - 1));
  }, [filteredSnippets.length]);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onOpenChange(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredSnippets.length === 0) return;
      setHighlightedIndex((current) => (current + 1) % filteredSnippets.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredSnippets.length === 0) return;
      setHighlightedIndex(
        (current) => (current - 1 + filteredSnippets.length) % filteredSnippets.length,
      );
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const snippet = filteredSnippets[highlightedIndex];
    if (!snippet) {
      return;
    }
    props.onSelectSnippet(snippet);
  };

  const saveDraftDisabled = props.currentDraftText.trim().length === 0;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-3xl" bottomStickOnMobile={false}>
        <DialogHeader className="gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3 pr-8">
            <div className="space-y-1">
              <DialogTitle>Snippets</DialogTitle>
              <DialogDescription>
                Browse saved and built-in snippets, then press Enter to insert one.
              </DialogDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saveDraftDisabled}
              data-testid="snippet-picker-save-draft"
              onClick={props.onSaveDraftAsSnippet}
              title="Save current draft as a snippet"
            >
              <FileTextIcon className="size-4" />
              Save draft
            </Button>
          </div>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-2">
            <Input
              ref={inputRef}
              type="search"
              placeholder="Search snippets"
              data-testid="snippet-picker-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
            <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
              <span>
                {filteredSnippets.length === 0
                  ? "No snippets matched this search."
                  : `${filteredSnippets.length} snippet${filteredSnippets.length === 1 ? "" : "s"}`}
              </span>
              <span>Enter inserts • Up/Down moves • Esc closes</span>
            </div>
          </div>

          <div className="min-h-[24rem] overflow-hidden rounded-xl border">
            <ScrollArea>
              <div className="divide-y">
                {filteredSnippets.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No snippets matched this search.
                  </div>
                ) : (
                  filteredSnippets.map((snippet, index) => {
                    const isHighlighted = index === highlightedIndex;
                    const updatedAtLabel = formatSnippetTimestamp(snippet.updatedAt);

                    return (
                      <div
                        key={snippet.id}
                        data-snippet-picker-result="true"
                        data-highlighted={isHighlighted ? "true" : undefined}
                        className={cn(
                          "flex items-start gap-3 px-4 py-3 transition-colors",
                          isHighlighted ? "bg-accent/70" : "hover:bg-accent/40",
                        )}
                        onMouseEnter={() => setHighlightedIndex(index)}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 space-y-2 text-left"
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => props.onSelectSnippet(snippet)}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">
                              {snippet.source === "saved" ? "Saved" : "Built in"}
                            </Badge>
                            <span className="font-medium text-sm text-foreground">
                              {snippet.title}
                            </span>
                            {updatedAtLabel ? (
                              <span className="text-muted-foreground text-[11px]">
                                {updatedAtLabel}
                              </span>
                            ) : null}
                          </div>
                          <p className="whitespace-pre-wrap break-words text-muted-foreground text-sm">
                            {summarizeComposerSnippetDescription(snippet.body)}
                          </p>
                        </button>
                        {snippet.deletable ? (
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            className="mt-0.5 shrink-0"
                            aria-label="Delete snippet"
                            data-testid={`snippet-picker-delete-${snippet.id}`}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              props.onDeleteSnippet(snippet);
                            }}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
