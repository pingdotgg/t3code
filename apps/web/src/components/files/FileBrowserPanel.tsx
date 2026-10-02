import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import type { ContextMenuItem, ContextMenuOpenContext } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { ChevronsDownUp, ChevronsUpDown, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import { useDirectoryEntries } from "./useDirectoryEntries";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File open in the preview pane; highlighted and revealed in the tree. */
  selectedPath: string | null;
  /** Bumped by breadcrumb clicks to reveal a directory without changing selection. */
  revealRequest: { path: string; nonce: number } | null;
  onOpenFile: (relativePath: string) => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    /* Opaque: the truncation fade markers paint this base first and state
       colors on top, so a transparent base lets measure text bleed through. */
    --trees-bg-override: var(--chat-background);
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  /* The panel owns the filter input below; the tree's built-in search overlay
     opens on the same model value and would render a second, competing box. */
  div[data-file-tree-search-container] { display: none !important; }
  button[data-type='item'] { border-radius: 5px; font-weight: 400; }
  button[data-type='item']:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }
  button[data-type='item'] svg[data-icon-name='file-tree-icon-chevron'] {
    opacity: 0.9;
  }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  revealRequest,
  onOpenFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const listing = useDirectoryEntries(environmentId, cwd);
  const { loadDirectory } = listing;
  const { copyToClipboard } = useCopyToClipboard();
  const [searchResults, setSearchResults] = useState<ReadonlyArray<ProjectEntry>>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchRetry, setSearchRetry] = useState(0);
  const entries = useMemo(() => {
    const merged = new Map(listing.entries.map((entry) => [entry.path, entry]));
    for (const entry of searchResults) {
      merged.set(entry.path, entry);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const path = segments.slice(0, index).join("/");
        if (!merged.has(path)) merged.set(path, { path, kind: "directory" });
      }
    }
    return [...merged.values()];
  }, [listing.entries, searchResults]);
  const isIndexing = !listing.rootLoaded && listing.pending > 0;
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const directoryPaths = useMemo(
    () => entries.filter((entry) => entry.kind === "directory").map(treePath),
    [entries],
  );
  const previousPathsRef = useRef<ReadonlySet<string> | null>(null);
  const syncingSelectionRef = useRef(false);
  const lastRevealedSelectionRef = useRef<string | null>(null);
  const lastRevealRequestRef = useRef<number | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  const expandedPathsRef = useRef(new Set<string>());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;

  const { model } = useFileTree({
    density: "compact",
    // Filter the view down to matches plus their ancestor chain: the list
    // must read as the search result, not the whole workspace with a count.
    // (`collapse-non-matches` is type-only with no runtime branch; avoid it.)
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    stickyFolders: true,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // Programmatic reveals below echo back through here; ignore them.
      if (syncingSelectionRef.current) return;
      const next = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (next && entryKindsRef.current.get(next) === "file") {
        openFileRef.current(next);
      }
    },
    paths: [],
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  const search = useFileTreeSearch(model);
  const searchValue = search.value;
  const matchCount = search.matchingPaths.length;

  const allExpanded = useFileTreeSelector(
    model,
    (tree) =>
      directoryPaths.length > 0 &&
      directoryPaths.every((path) => {
        const item = tree.getItem(path);
        return item && "isExpanded" in item && item.isExpanded();
      }),
  );

  useEffect(() => {
    if (!searchValue.trim()) {
      setSearchResults([]);
      setSearchError(null);
      setSearchPending(false);
      setSearchTruncated(false);
      return;
    }
    let active = true;
    setSearchResults([]);
    setSearchPending(true);
    setSearchError(null);
    setSearchTruncated(false);
    const timer = setTimeout(() => {
      void ensureEnvironmentApi(environmentId)
        .projects.searchEntries({
          cwd,
          query: searchValue.trim(),
          kind: "file",
          limit: 200,
        })
        .then(
          (result) => {
            if (!active) return;
            setSearchResults(result.entries);
            setSearchTruncated(result.truncated);
            setSearchPending(false);
          },
          (cause: unknown) => {
            if (!active) return;
            setSearchError(
              cause instanceof Error ? cause.message : "Could not search workspace files.",
            );
            setSearchPending(false);
          },
        );
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [cwd, environmentId, searchRetry, searchValue]);

  useEffect(() => {
    entryKindsRef.current = entryKinds;
    const next = new Set(treePaths);
    const previous = previousPathsRef.current;
    previousPathsRef.current = next;
    if (previous === null) {
      model.resetPaths(treePaths);
      return;
    }
    const removed = [...previous]
      .filter((path) => !next.has(path))
      .sort((a, b) => a.length - b.length);
    // Removing a directory removes its descendants; do not remove them twice.
    const removedDirectories = new Set(removed.filter((path) => path.endsWith("/")));
    const removalRoots = removed.filter((path) => {
      let boundary = path.replace(/\/$/, "").lastIndexOf("/");
      while (boundary >= 0) {
        if (removedDirectories.has(path.slice(0, boundary + 1))) return false;
        boundary = path.lastIndexOf("/", boundary - 1);
      }
      return true;
    });
    const added = [...next]
      .filter((path) => !previous.has(path))
      .sort((a, b) => a.length - b.length);
    if (removed.length === 0 && added.length === 0) return;
    model.batch([
      ...removalRoots.map((path) => ({ type: "remove" as const, path, recursive: true })),
      ...added.map((path) => ({ type: "add" as const, path })),
    ]);
  }, [entryKinds, model, treePaths]);

  useEffect(() => {
    model.setGitStatus(
      entries
        .filter((entry) => entry.ignored)
        .map((entry) => ({
          path: treePath(entry),
          status: "ignored" as const,
        })),
    );
  }, [entries, model]);

  useEffect(() => {
    const currentPaths = new Set(directoryPaths);
    for (const path of expandedPathsRef.current) {
      if (!currentPaths.has(path)) expandedPathsRef.current.delete(path);
    }
    const loadExpanded = () => {
      if (model.isSearchOpen()) return;
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (item && "isExpanded" in item && item.isExpanded()) {
          expandedPathsRef.current.add(path);
          void loadDirectory(path.replace(/\/$/, ""));
        } else if (expandedPathsRef.current.delete(path)) {
          setExpandAll(false);
        }
      }
    };
    if (expandAll) {
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (item && "expand" in item) item.expand();
      }
    }
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [directoryPaths, expandAll, loadDirectory, model]);

  useEffect(() => {
    const target = revealRequest?.path ?? selectedPath;
    if (!target) return;
    let active = true;
    void (async () => {
      await loadDirectory("");
      const parts = target.replace(/\/$/, "").split("/");
      const length = revealRequest ? parts.length : parts.length - 1;
      for (let index = 1; index <= length; index++) {
        if (!active) break;
        await loadDirectory(parts.slice(0, index).join("/"));
      }
    })();
    return () => {
      active = false;
    };
  }, [loadDirectory, revealRequest, selectedPath]);

  // Returns true when the target was revealed, false when the tree does not
  // contain it yet so callers can retry after entries load.
  const reveal = useCallback(
    (path: string, select: boolean): boolean => {
      const normalized = path.replace(/\/$/, "");
      if (select) {
        const kind = entryKindsRef.current.get(normalized);
        // Entries still loading: retry once the tree is populated.
        if (kind === undefined) return false;
        if (kind !== "file") return true;
      }
      if (
        model.getSelectedPaths().some((candidate) => candidate.replace(/\/$/, "") === normalized)
      ) {
        model.scrollToPath(select ? normalized : path, { focus: false, offset: "nearest" });
        return true;
      }
      const segments = normalized.split("/").filter(Boolean);
      let ancestor = "";
      for (const segment of segments.slice(0, -1)) {
        ancestor = ancestor ? `${ancestor}/${segment}` : segment;
        const item = model.getItem(`${ancestor}/`) ?? model.getItem(ancestor);
        if (item && "expand" in item) item.expand();
      }
      if (!select) {
        const target =
          model.getItem(path) ?? model.getItem(normalized) ?? model.getItem(`${normalized}/`);
        if (!target) return false;
        model.scrollToPath(path, { focus: false, offset: "nearest" });
        return true;
      }
      const item = model.getItem(normalized);
      if (!item) return false;
      syncingSelectionRef.current = true;
      for (const selected of model.getSelectedPaths()) {
        if (selected.replace(/\/$/, "") !== normalized) model.getItem(selected)?.deselect();
      }
      item.select();
      model.scrollToPath(normalized, { focus: false, offset: "nearest" });
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
      return true;
    },
    [model],
  );

  // Follow the open file, but only when the selection itself changes.
  // Refreshing entries must not steal scroll/focus or close an active search.
  // Retries while indexing so files opened before the listing completes are
  // still revealed; once loaded, a missing path is accepted as-is instead of
  // retrying on every refresh.
  useEffect(() => {
    if (!selectedPath || lastRevealedSelectionRef.current === selectedPath) return;
    if (!reveal(selectedPath, true)) return;
    lastRevealedSelectionRef.current = selectedPath;
  }, [model, reveal, selectedPath, treePaths, isIndexing]);

  // Breadcrumb clicks reveal a directory without touching file selection.
  // Retries while indexing so clicks during loading are not lost.
  useEffect(() => {
    if (!revealRequest || lastRevealRequestRef.current === revealRequest.nonce) return;
    if (!reveal(revealRequest.path, false)) return;
    lastRevealRequestRef.current = revealRequest.nonce;
  }, [model, reveal, revealRequest, treePaths, isIndexing]);

  const toggleAllDirectories = () => {
    const next = !(expandAll || allExpanded);
    setExpandAll(next);
    for (const dir of directoryPaths) {
      const item = model.getItem(dir);
      if (item && "expand" in item) {
        if (next) item.expand();
        else item.collapse();
      }
    }
  };

  const closeSearch = () => {
    search.setValue(null);
    search.close();
    searchInputRef.current?.focus();
  };

  const hasNoMatches = searchValue.length > 0 && matchCount === 0 && !searchPending;

  const renderContextMenu = useCallback(
    (item: ContextMenuItem, context: ContextMenuOpenContext) => {
      const relativePath = item.path.replace(/\/$/, "");
      const fileName = relativePath.split("/").at(-1) ?? relativePath;
      return (
        <div className="min-w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 text-xs shadow-md">
          {item.kind === "file" ? (
            <button
              type="button"
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-popover-foreground hover:bg-accent"
              onClick={() => {
                context.close({ restoreFocus: false });
                onOpenFile(relativePath);
              }}
            >
              Open file
            </button>
          ) : null}
          <button
            type="button"
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-popover-foreground hover:bg-accent"
            onClick={() => {
              copyToClipboard(relativePath, undefined);
              context.close();
            }}
          >
            Copy path
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-popover-foreground hover:bg-accent"
            onClick={() => {
              copyToClipboard(fileName, undefined);
              context.close();
            }}
          >
            Copy file name
          </button>
        </div>
      );
    },
    [copyToClipboard, onOpenFile],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-chat-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent">
        <button
          type="button"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh workspace files"
          title="Refresh workspace files"
          onClick={listing.refresh}
          disabled={listing.pending > 0}
        >
          <RefreshCw className={cn("size-3.5", listing.pending > 0 && "animate-spin")} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 focus-within:bg-accent/40">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={searchInputRef}
            type="text"
            maxLength={256}
            value={searchValue}
            onChange={(event) => search.setValue(event.target.value || null)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeSearch();
              }
              if (event.key === "Enter") {
                event.stopPropagation();
                if (event.shiftKey) {
                  search.focusPreviousMatch();
                } else {
                  search.focusNextMatch();
                }
              }
            }}
            placeholder="Search files"
            aria-label="Filter workspace files"
            title="Enter jumps to the next match, Shift+Enter to the previous, Esc clears"
            data-file-browser-search
            className="h-8 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          {searchValue.length > 0 && (
            <span
              className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
              title="Enter jumps to the next match, Shift+Enter to the previous"
            >
              {searchPending
                ? "Searching…"
                : matchCount === 0
                  ? "No matches"
                  : `${matchCount.toLocaleString()} match${matchCount === 1 ? "" : "es"} · Enter ↵`}
            </span>
          )}
          {searchValue.length > 0 ? (
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Clear file filter"
              title="Clear file filter"
              onClick={closeSearch}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={expandAll || allExpanded ? "Collapse all folders" : "Expand all folders"}
          title={expandAll || allExpanded ? "Collapse all folders" : "Expand all folders"}
          onClick={toggleAllDirectories}
          disabled={directoryPaths.length === 0}
        >
          {expandAll || allExpanded ? (
            <ChevronsDownUp className="size-3.5" />
          ) : (
            <ChevronsUpDown className="size-3.5" />
          )}
        </button>
      </div>
      {(listing.truncated || searchTruncated) && !isIndexing ? (
        <div className="shrink-0 border-b border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-300">
          Showing a partial list. Narrow your search to find more files.
        </div>
      ) : null}
      {listing.error || searchError ? (
        <div className="flex shrink-0 items-start gap-2 p-3" role="alert">
          <p className="min-w-0 flex-1 whitespace-pre-line text-xs leading-relaxed text-destructive">
            {listing.error || searchError}
          </p>
          <button
            type="button"
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
            onClick={() => {
              if (listing.error) listing.refresh();
              else setSearchRetry((previous) => previous + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {isIndexing ? (
        <div
          className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-2.5"
          aria-label="Indexing workspace files"
        >
          {Array.from({ length: 12 }, (_, index) => (
            <div
              key={`skeleton-${index}`}
              className="h-5 shrink-0 animate-pulse rounded-md bg-accent/60"
              style={{ width: `${92 - ((index * 37) % 40)}%` }}
            />
          ))}
        </div>
      ) : entries.length === 0 || hasNoMatches ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-center">
          <p className="text-xs font-medium text-foreground">No files found</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {searchPending
              ? "Searching workspace…"
              : searchValue.length > 0
                ? "Try a different search."
                : listing.error
                  ? "Refresh to try again."
                  : "This workspace looks empty."}
          </p>
          {searchValue.length > 0 ? (
            <button
              type="button"
              className="mt-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
              onClick={closeSearch}
            >
              Clear filter
            </button>
          ) : null}
        </div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          renderContextMenu={renderContextMenu}
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--foreground)",
          }}
        />
      )}
    </div>
  );
}
