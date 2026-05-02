import { scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  QUICK_THREAD_SEARCH_RECENT_LIMIT,
  buildHighlightSegments,
  buildQuickThreadSearchIndex,
  buildQuickThreadSearchResults,
  findTextOccurrences,
} from "../lib/quickThreadSearch";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { Project, Thread } from "../types";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "~/lib/utils";

interface QuickThreadSearchDialogProps {
  open: boolean;
  focusRequestId: number;
  threads: readonly Thread[];
  projects: readonly Project[];
  activeThreadRef: ScopedThreadRef | null;
  onOpenChange: (open: boolean) => void;
}

function formatExactResultTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function resultFieldLabel(field: "title" | "prompt") {
  return field === "title" ? "Title" : "Prompt";
}

export function QuickThreadSearchDialog(props: QuickThreadSearchDialogProps) {
  const navigate = useNavigate();
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

  const index = useMemo(
    () =>
      buildQuickThreadSearchIndex({
        threads: props.threads,
        projects: props.projects,
      }),
    [props.projects, props.threads],
  );

  const searchResults = useMemo(
    () =>
      buildQuickThreadSearchResults({
        index,
        query: deferredQuery,
      }),
    [deferredQuery, index],
  );

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setHighlightedIndex(0);
  }, [deferredQuery, props.open]);

  useEffect(() => {
    if (searchResults.results.length === 0) {
      setHighlightedIndex(0);
      return;
    }

    setHighlightedIndex((current) => Math.min(current, searchResults.results.length - 1));
  }, [searchResults.results.length]);

  const openResult = async (resultIndex: number) => {
    const result = searchResults.results[resultIndex];
    if (!result) {
      return;
    }

    props.onOpenChange(false);

    if (
      props.activeThreadRef &&
      scopedThreadKey(props.activeThreadRef) === scopedThreadKey(result.threadRef)
    ) {
      return;
    }

    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(result.threadRef),
    });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onOpenChange(false);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (searchResults.results.length === 0) return;
      setHighlightedIndex((current) => (current + 1) % searchResults.results.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (searchResults.results.length === 0) return;
      setHighlightedIndex(
        (current) => (current - 1 + searchResults.results.length) % searchResults.results.length,
      );
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    void openResult(highlightedIndex);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-5xl" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>Quick Thread Search</DialogTitle>
          <DialogDescription>
            Search the {QUICK_THREAD_SEARCH_RECENT_LIMIT} most recent threads by title and opening
            prompt for a faster jump-to-thread flow.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-2">
            <Input
              ref={inputRef}
              type="search"
              placeholder="Search recent threads"
              data-testid="quick-thread-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
            <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
              <span>
                {searchResults.totalResults === 0
                  ? "No results"
                  : searchResults.truncated
                    ? `Showing ${searchResults.results.length} of ${searchResults.totalResults} results`
                    : `${searchResults.totalResults} results`}
              </span>
              <span>Enter opens • Up/Down moves • Esc closes</span>
            </div>
          </div>

          <div className="min-h-[28rem] overflow-hidden rounded-xl border">
            <ScrollArea>
              <div className="divide-y">
                {deferredQuery.trim().length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Start typing to search the {QUICK_THREAD_SEARCH_RECENT_LIMIT} most recent thread
                    titles and opening prompts.
                  </div>
                ) : searchResults.results.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No recent threads matched this search.
                  </div>
                ) : (
                  searchResults.results.map((result, index) => {
                    const titleSegments = buildHighlightSegments(
                      result.threadTitle,
                      findTextOccurrences(result.threadTitle, deferredQuery),
                    );
                    const snippetSegments = buildHighlightSegments(
                      result.displaySnippet,
                      findTextOccurrences(result.displaySnippet, deferredQuery),
                    );
                    const isHighlighted = index === highlightedIndex;

                    return (
                      <button
                        key={result.resultId}
                        type="button"
                        data-quick-thread-search-result="true"
                        data-highlighted={isHighlighted ? "true" : undefined}
                        className={cn(
                          "flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors",
                          isHighlighted ? "bg-accent/70" : "hover:bg-accent/40",
                        )}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        onClick={() => {
                          void openResult(index);
                        }}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium text-sm">
                            {titleSegments.map((segment) =>
                              segment.highlighted ? (
                                <mark
                                  key={`quick-thread-search-title-highlight:${result.resultId}:${segment.key}`}
                                  className="rounded bg-amber-400/35 px-0.5 text-foreground"
                                >
                                  {segment.text}
                                </mark>
                              ) : (
                                <span
                                  key={`quick-thread-search-title-segment:${result.resultId}:${segment.key}`}
                                >
                                  {segment.text}
                                </span>
                              ),
                            )}
                          </span>
                          <Badge variant="outline">{resultFieldLabel(result.matchedField)}</Badge>
                          {result.matchCount > 1 ? (
                            <Badge variant="secondary">{result.matchCount} matches</Badge>
                          ) : null}
                          <span className="text-muted-foreground text-xs">
                            {result.projectName}
                          </span>
                          <span
                            className="ml-auto text-muted-foreground text-[11px]"
                            title={formatExactResultTimestamp(result.sourceCreatedAt)}
                          >
                            {formatRelativeTimeLabel(result.sourceCreatedAt)}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-foreground/80 text-sm">
                          {snippetSegments.map((segment) =>
                            segment.highlighted ? (
                              <mark
                                key={`quick-thread-search-snippet-highlight:${result.resultId}:${segment.key}`}
                                className="rounded bg-amber-400/35 px-0.5 text-foreground"
                              >
                                {segment.text}
                              </mark>
                            ) : (
                              <span
                                key={`quick-thread-search-snippet-segment:${result.resultId}:${segment.key}`}
                              >
                                {segment.text}
                              </span>
                            ),
                          )}
                        </p>
                      </button>
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
