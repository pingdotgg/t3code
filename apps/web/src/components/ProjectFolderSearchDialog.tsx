import { scopeProjectRef } from "@t3tools/client-runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { buildProjectFolderSearchResults } from "../lib/projectFolderSearch";
import type { Project } from "../types";
import { cn } from "~/lib/utils";
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

interface ProjectFolderSearchDialogProps {
  open: boolean;
  focusRequestId: number;
  projects: readonly Project[];
  onSelectProject: (projectRef: ScopedProjectRef) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
}

export function ProjectFolderSearchDialog(props: ProjectFolderSearchDialogProps) {
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

  const searchResults = useMemo(
    () =>
      buildProjectFolderSearchResults({
        projects: props.projects,
        query: deferredQuery,
      }),
    [deferredQuery, props.projects],
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
    await props.onSelectProject(scopeProjectRef(result.project.environmentId, result.project.id));
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
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
      <DialogPopup className="max-w-3xl" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>Search Project Folders</DialogTitle>
          <DialogDescription>
            Fuzzy-search the project folders in the sidebar, then open a new thread in the selected
            project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-2">
            <Input
              ref={inputRef}
              type="search"
              placeholder="Search project folders"
              data-testid="project-folder-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
            <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
              <span>
                {searchResults.totalResults === 0
                  ? "No results"
                  : searchResults.truncated
                    ? `Showing ${searchResults.results.length} of ${searchResults.totalResults} projects`
                    : `${searchResults.totalResults} projects`}
              </span>
              <span>Enter opens new thread • Up/Down moves • Esc closes</span>
            </div>
          </div>

          <div className="min-h-[22rem] overflow-hidden rounded-xl border">
            <ScrollArea>
              <div className="divide-y">
                {props.projects.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No project folders are available in the sidebar yet.
                  </div>
                ) : searchResults.results.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No project folders matched this search.
                  </div>
                ) : (
                  searchResults.results.map((result, index) => {
                    const isHighlighted = index === highlightedIndex;

                    return (
                      <button
                        key={`${result.project.environmentId}:${result.project.id}`}
                        type="button"
                        data-project-folder-search-result="true"
                        data-highlighted={isHighlighted ? "true" : undefined}
                        className={cn(
                          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
                          isHighlighted ? "bg-accent/70" : "hover:bg-accent/40",
                        )}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        onClick={() => {
                          void openResult(index);
                        }}
                      >
                        <span className="mt-0.5 rounded-md border bg-muted/50 p-1.5 text-muted-foreground">
                          <FolderIcon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-sm">
                            {result.project.name}
                          </span>
                          <span className="mt-1 block truncate text-muted-foreground text-xs">
                            {result.project.cwd}
                          </span>
                        </span>
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
