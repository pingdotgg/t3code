import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTreeRowDecorationRenderer,
} from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { ChevronsDownUp, ChevronsUpDown, FolderSearch, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildFileParentSuffixByPath } from "~/filePathDisambiguation";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import { useProjectEntriesQuery } from "./projectFilesQueryState";

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
    --trees-bg-override: var(--background);
    --trees-selected-bg-override: color-mix(in srgb, var(--primary) 18%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 10%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: var(--app-sidebar-font-size);
  }
  /* The panel owns the filter input below; the tree's built-in search overlay
     opens on the same model value and would render a second, competing box. */
  div[data-file-tree-search-container] { display: none !important; }
  div[data-item-section='decoration'] { min-width: 0; overflow: hidden; }
  div[data-item-section='decoration'] span {
    opacity: 0.55;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button[data-type='item'] { border-radius: 6px; }
  button[data-type='item']:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }
  button[data-type='item'][aria-selected='true'] {
    box-shadow: inset 2px 0 0 var(--primary);
  }
  button[data-type='item'][data-item-type='folder'] { font-weight: 550; }
  button[data-type='item'] svg[data-icon-name='file-tree-icon-chevron'] {
    opacity: 0.9;
  }
`;

// Full resets collapse every expanded folder. Most refreshes only add or
// remove a few paths, so apply those as mutations and keep expansion.
const BATCH_UPDATE_FALLBACK_THRESHOLD = 200;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
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
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const entries = entriesQuery.data?.entries ?? [];
  const isIndexing = entriesQuery.isPending && entriesQuery.data === null;
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
  const [allExpanded, setAllExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Tree options are captured at model construction; live data flows through refs.
  const parentSuffixByPathRef = useRef<ReadonlyMap<string, string>>(new Map());
  const renderRowDecoration = useCallback<FileTreeRowDecorationRenderer>(({ item }) => {
    if (item.kind !== "file") return null;
    const suffix = parentSuffixByPathRef.current.get(item.path);
    if (!suffix) return null;
    return { text: `· ${suffix}`, title: item.path };
  }, []);

  const { model } = useFileTree({
    density: "compact",
    // Filter the view down to matches plus their ancestor chain: the list
    // must read as the search result, not the whole workspace with a count.
    // (`collapse-non-matches` is type-only with no runtime branch; avoid it.)
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    stickyFolders: true,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // Programmatic reveals below echo back through here; ignore them.
      if (syncingSelectionRef.current) return;
      const next = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (next && entryKindsRef.current.get(next) === "file") {
        onOpenFile(next);
      }
    },
    paths: [],
    renderRowDecoration,
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  const search = useFileTreeSearch(model);
  const searchValue = search.value;
  const matchCount = search.matchingPaths.length;

  const parentSuffixByPath = useMemo(
    () =>
      buildFileParentSuffixByPath(
        entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
      ),
    [entries],
  );

  useEffect(() => {
    entryKindsRef.current = entryKinds;
    parentSuffixByPathRef.current = parentSuffixByPath;
    const next = new Set(treePaths);
    const previous = previousPathsRef.current;
    previousPathsRef.current = next;
    if (previous === null) {
      model.resetPaths(treePaths);
      return;
    }
    const removed = [...previous]
      .filter((path) => !next.has(path))
      .sort((a, b) => b.length - a.length);
    const added = [...next]
      .filter((path) => !previous.has(path))
      .sort((a, b) => a.length - b.length);
    if (removed.length === 0 && added.length === 0) return;
    if (removed.length + added.length > BATCH_UPDATE_FALLBACK_THRESHOLD) {
      model.resetPaths(treePaths);
      return;
    }
    try {
      model.batch([
        ...removed.map((path) => ({ type: "remove" as const, path })),
        ...added.map((path) => ({ type: "add" as const, path })),
      ]);
    } catch {
      model.resetPaths(treePaths);
    }
  }, [entryKinds, model, treePaths]);

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
    if (!reveal(selectedPath, true) && isIndexing) return;
    lastRevealedSelectionRef.current = selectedPath;
  }, [model, reveal, selectedPath, treePaths, isIndexing]);

  // Breadcrumb clicks reveal a directory without touching file selection.
  // Retries while indexing so clicks during loading are not lost.
  useEffect(() => {
    if (!revealRequest || lastRevealRequestRef.current === revealRequest.nonce) return;
    if (!reveal(revealRequest.path, false) && isIndexing) return;
    lastRevealRequestRef.current = revealRequest.nonce;
  }, [model, reveal, revealRequest, treePaths, isIndexing]);

  const toggleAllDirectories = () => {
    const next = !allExpanded;
    setAllExpanded(next);
    for (const dir of directoryPaths) {
      const item = model.getItem(dir);
      if (item && "expand" in item) {
        if (next) item.expand();
        else item.collapse();
      }
    }
  };

  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const closeSearch = () => {
    search.setValue(null);
    setSearchOpen(false);
  };

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );
  const showSearchRow = searchOpen || searchValue.length > 0;
  const hasNoMatches = searchValue.length > 0 && matchCount === 0;

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
              copyText(relativePath);
              context.close();
            }}
          >
            Copy path
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-popover-foreground hover:bg-accent"
            onClick={() => {
              copyText(fileName);
              context.close();
            }}
          >
            Copy file name
          </button>
        </div>
      );
    },
    [onOpenFile],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-2.5">
        <div className="min-w-0 flex-1 px-0.5">
          <div className="truncate text-[13px] font-semibold text-foreground">{projectName}</div>
          <div className="truncate text-[11px] leading-tight text-muted-foreground">
            {isIndexing ? "Indexing workspace…" : `${fileCount.toLocaleString()} files`}
            {entriesQuery.data?.truncated ? " · showing partial list" : ""}
          </div>
        </div>
        {directoryPaths.length > 0 ? (
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={allExpanded ? "Collapse all folders" : "Expand all folders"}
            title={allExpanded ? "Collapse all folders" : "Expand all folders"}
            onClick={toggleAllDirectories}
          >
            {allExpanded ? (
              <ChevronsDownUp className="size-4" />
            ) : (
              <ChevronsUpDown className="size-4" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground",
            showSearchRow ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
          aria-label="Search workspace files"
          title="Search workspace files"
          aria-expanded={showSearchRow}
          onClick={() => (showSearchRow ? closeSearch() : openSearch())}
        >
          <Search className="size-4" />
        </button>
        <button
          type="button"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh workspace files"
          title="Refresh workspace files"
          onClick={entriesQuery.refresh}
        >
          <RefreshCw className={cn("size-4", entriesQuery.isPending && "animate-spin")} />
        </button>
      </div>
      {showSearchRow ? (
        <div className="shrink-0 border-b border-border/60 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2 py-1 transition-colors focus-within:border-ring/60 focus-within:bg-muted/60">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={searchInputRef}
              type="text"
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
              placeholder="Filter files…"
              aria-label="Filter workspace files"
              title="Enter jumps to the next match, Shift+Enter to the previous, Esc clears"
              data-file-browser-search
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            {searchValue.length > 0 && (
              <span
                className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[11px] tabular-nums text-muted-foreground"
                title="Enter jumps to the next match, Shift+Enter to the previous"
              >
                {matchCount === 0
                  ? "No matches"
                  : `${matchCount.toLocaleString()} match${matchCount === 1 ? "" : "es"} · Enter ↵`}
              </span>
            )}
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Clear file filter"
              title="Clear file filter"
              onClick={closeSearch}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ) : null}
      {entriesQuery.data?.truncated && !isIndexing ? (
        <div className="shrink-0 border-b border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-300">
          Showing a partial list. Search covers the listed entries only.
        </div>
      ) : null}
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="flex flex-1 flex-col items-start justify-center gap-2 p-4">
          <p className="text-xs leading-relaxed text-destructive">{entriesQuery.error}</p>
          <button
            type="button"
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
            onClick={entriesQuery.refresh}
          >
            Retry
          </button>
        </div>
      ) : isIndexing ? (
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
          <span className="mb-1 flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <FolderSearch className="size-4" aria-hidden />
          </span>
          <p className="text-xs font-medium text-foreground">No files found</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {searchValue.length > 0 ? "Try a different filter." : "This workspace looks empty."}
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
