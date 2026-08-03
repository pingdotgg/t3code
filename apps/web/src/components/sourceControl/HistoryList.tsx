/**
 * The History tab: lane graph, virtualized rows, drawer, load-more.
 *
 * The lane graph is folded ONCE over the full contiguous newest-first page —
 * `history.page.entries`, never `history.entries` (the filtered/merged view)
 * and never the visible window. When the list is filtered, sorted oldest-first
 * or grouped by day the graph is *suppressed* with a visible notice and a
 * one-click restore, because a graph folded over a non-contiguous sequence is
 * silently wrong, which is worse than no graph.
 *
 * fork: f4 redesign (audit §8) — three changes here:
 *
 *  1. The toolbar is gone. Search, author and the view options moved into the
 *     panel's ONE filter row and ONE View menu, so History and Changes stop
 *     having two different toolbars at two different insets.
 *  2. Keyboard. History had no arrow keys at all while Changes had a full
 *     model, in the same panel (M9). It now runs the same roving-focus model:
 *     the listbox owns the tab stop and points `aria-activedescendant` at the
 *     focused row.
 *  3. Designed empty / loading states. An empty or filtered-to-nothing history
 *     used to render a blank rectangle (M7).
 *
 * fork: f4 source-control panel
 */
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { HistoryFilter } from "@t3tools/client-runtime/state/working-copy-logic";
import type { WorkingCopyCommitDetail, WorkingCopyLogEntry } from "@t3tools/contracts";
import { AlertCircle, GitCommitHorizontal, SearchX, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  HISTORY_DAY_ROW_HEIGHT,
  HISTORY_DEFAULT_DRAWER_HEIGHT,
  HISTORY_LOAD_MORE_ROW_HEIGHT,
  buildHistoryRows,
  clampHistoryDrawerHeight,
  historyDayLabel,
  historyRowHeight,
  type HistoryDensity,
  type HistoryRow,
} from "~/lib/sourceControl/historyRows";
import {
  buildLaneGraph,
  cappedLaneGraphWidth,
  laneGraphSuppression,
  laneGraphWidth,
  plainLaneNode,
  type LaneNode,
} from "~/lib/sourceControl/laneGraph";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

import { CommitDrawer } from "./CommitDrawer";
import { CommitRow } from "./CommitRow";
import { historyWidthBucket } from "./sourceControlPanel.logic";
import type { WorkingCopyHistoryView } from "./useWorkingCopyHistory";

/**
 * fork: f4 focus model — the keys this listbox consumes, mirroring
 * `CHANGES_LIST_OWNED_KEYS`. A key this list owns stops here rather than
 * bubbling into the surfaces above the panel.
 */
export const HISTORY_LIST_OWNED_KEYS: ReadonlySet<string> = new Set([
  "j",
  "k",
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "Enter",
  "Escape",
]);

export function historyRowDomId(hash: string): string {
  return `sc-commit-${hash.slice(0, 12)}`;
}

export interface HistoryListProps {
  readonly history: WorkingCopyHistoryView;
  readonly filter: HistoryFilter;
  readonly onFilterChange: (filter: HistoryFilter) => void;
  readonly grouped: boolean;
  readonly onGroupedChange: (grouped: boolean) => void;
  readonly sort: "newest" | "oldest";
  readonly onSortChange: (sort: "newest" | "oldest") => void;
  readonly density: HistoryDensity;
  readonly detached: boolean;
  readonly dirty: boolean;
  readonly commitDetail: WorkingCopyCommitDetail | null;
  readonly commitDetailLoading: boolean;
  readonly expandedHash: string | null;
  readonly onExpandedHashChange: (hash: string | null) => void;
  readonly onCopy: (text: string, label?: string) => void;
  /** fork: f4 F-06 — per-commit in-flight state for the row context menu. */
  readonly isBusy: (key: string) => boolean;
  readonly onTag: (entry: WorkingCopyLogEntry) => void;
  readonly onCherryPick: (entry: WorkingCopyLogEntry) => void;
  readonly onCheckout: (entry: WorkingCopyLogEntry) => void;
  readonly onReset: (entry: WorkingCopyLogEntry, mode: "soft" | "mixed" | "hard") => void;
  readonly onRevert: (entry: WorkingCopyLogEntry) => void;
  readonly onOpenCommitFile: (hash: string, path: string, oldPath: string | undefined) => void;
}

export function HistoryList(props: HistoryListProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const [widthPx, setWidthPx] = useState(480);
  const [focusedHash, setFocusedHash] = useState<string | null>(null);
  /** fork: f4 M6 — the measured drawer, kept per hash so a stale measurement
   *  from the previous commit cannot size the next one. */
  const [drawer, setDrawer] = useState<{ hash: string; height: number } | null>(null);

  // Bucketed off the timeline element, not the window: the panel can be narrow
  // inside a wide window and vice versa.
  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((observed) => {
      const entry = observed[0];
      if (entry) setWidthPx(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const width = historyWidthBucket(widthPx);
  const { history } = props;

  const suppression = laneGraphSuppression({
    filtered: history.filterActive,
    sort: props.sort,
    grouped: props.grouped,
  });

  // The fold runs over the FULL page array, not the rendered/filtered one.
  const laneNodes = useMemo(
    () => (suppression === null ? buildLaneGraph(history.page.entries) : []),
    [history.page.entries, suppression],
  );
  const nodeByHash = useMemo(() => {
    const map = new Map<string, LaneNode>();
    for (const node of laneNodes) map.set(node.hash, node);
    return map;
  }, [laneNodes]);
  // fork: f4 M14 — the gutter is capped; the fold above keeps its true columns.
  const graphWidth = useMemo(() => cappedLaneGraphWidth(laneGraphWidth(laneNodes)), [laneNodes]);

  const entries = useMemo(() => {
    const list = history.entries;
    return props.sort === "oldest" ? list.toReversed() : list;
  }, [history.entries, props.sort]);

  const rows = useMemo(
    () =>
      buildHistoryRows({
        entries,
        grouped: props.grouped,
        expandedHash: props.expandedHash,
        canLoadMore: history.canLoadMore,
      }),
    [entries, history.canLoadMore, props.expandedHash, props.grouped],
  );

  const commitHashes = useMemo(
    () => rows.filter((row) => row.kind === "commit").map((row) => row.hash ?? ""),
    [rows],
  );

  // Drop a focus whose commit is gone (a filter change, a new page).
  useEffect(() => {
    setFocusedHash((current) =>
      current !== null && commitHashes.includes(current) ? current : null,
    );
  }, [commitHashes]);

  const drawerHeight =
    drawer !== null && drawer.hash === props.expandedHash
      ? clampHistoryDrawerHeight(drawer.height)
      : HISTORY_DEFAULT_DRAWER_HEIGHT;

  const handleMeasureDrawer = useCallback(
    (height: number) => {
      const hash = props.expandedHash;
      if (hash === null) return;
      setDrawer((current) =>
        current !== null && current.hash === hash && Math.abs(current.height - height) < 2
          ? current
          : { hash, height },
      );
    },
    [props.expandedHash],
  );

  const focusCommit = useCallback(
    (hash: string | null) => {
      if (hash === null) return;
      setFocusedHash(hash);
      rootRef.current?.focus({ preventScroll: true });
      const index = rows.findIndex((row) => row.kind === "commit" && row.hash === hash);
      if (index >= 0) listRef.current?.scrollToIndex({ index, viewPosition: 0.5 });
    },
    [rows],
  );

  const moveFocus = useCallback(
    (move: "next" | "previous" | "first" | "last"): string | null => {
      if (commitHashes.length === 0) return null;
      if (move === "first") return commitHashes[0] ?? null;
      if (move === "last") return commitHashes[commitHashes.length - 1] ?? null;
      const index = focusedHash === null ? -1 : commitHashes.indexOf(focusedHash);
      if (index === -1) {
        return move === "next"
          ? (commitHashes[0] ?? null)
          : (commitHashes[commitHashes.length - 1] ?? null);
      }
      const nextIndex = move === "next" ? index + 1 : index - 1;
      if (nextIndex < 0 || nextIndex >= commitHashes.length) return focusedHash;
      return commitHashes[nextIndex] ?? null;
    },
    [commitHashes, focusedHash],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, [contenteditable='true']") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      if (HISTORY_LIST_OWNED_KEYS.has(event.key)) {
        event.stopPropagation();
      }
      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          focusCommit(moveFocus("next"));
          return;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          focusCommit(moveFocus("previous"));
          return;
        case "Home":
          event.preventDefault();
          focusCommit(moveFocus("first"));
          return;
        case "End":
          event.preventDefault();
          focusCommit(moveFocus("last"));
          return;
        case "Enter":
          if (focusedHash === null) return;
          event.preventDefault();
          props.onExpandedHashChange(props.expandedHash === focusedHash ? null : focusedHash);
          return;
        case "Escape":
          if (props.expandedHash !== null) {
            event.preventDefault();
            props.onExpandedHashChange(null);
            return;
          }
          if (history.filterActive) {
            event.preventDefault();
            props.onFilterChange({ query: "", author: "" });
          }
          return;
        default:
          return;
      }
    },
    [focusCommit, focusedHash, history.filterActive, moveFocus, props],
  );

  const handleContainerFocus = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (focusedHash !== null) return;
      const first = commitHashes[0];
      if (first !== undefined) setFocusedHash(first);
    },
    [commitHashes, focusedHash],
  );

  const renderRow = useCallback(
    (row: HistoryRow) => {
      if (row.kind === "day") {
        return (
          <div
            style={{ height: HISTORY_DAY_ROW_HEIGHT }}
            className="flex items-center bg-background px-3 font-medium text-[11px] text-muted-foreground/70 uppercase tracking-[0.08em]"
          >
            {row.label ?? historyDayLabel(row.entry?.authoredAt ?? "")}
          </div>
        );
      }
      if (row.kind === "load-more") {
        return (
          <div
            style={{ height: HISTORY_LOAD_MORE_ROW_HEIGHT }}
            className="flex items-center justify-center"
          >
            {/* fork: f4 F-16 — disabled while ANY read is in flight, but the
                label only says "Loading…" for the page read this row owns. */}
            <Button
              size="sm"
              variant="outline"
              disabled={history.isLoading}
              onClick={history.loadMore}
            >
              {history.isLoadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        );
      }
      if (row.kind === "drawer") {
        return (
          <CommitDrawer
            detail={props.commitDetail}
            isLoading={props.commitDetailLoading}
            height={drawerHeight}
            onMeasure={handleMeasureDrawer}
            onCopy={props.onCopy}
            onOpenFile={(path, oldPath) =>
              props.onOpenCommitFile(row.entry?.hash ?? "", path, oldPath)
            }
          />
        );
      }
      const entry = row.entry;
      if (!entry) return null;
      return (
        <CommitRow
          entry={entry}
          domId={historyRowDomId(entry.hash)}
          focused={focusedHash === entry.hash}
          node={
            suppression === null ? (nodeByHash.get(entry.hash) ?? null) : plainLaneNode(entry.hash)
          }
          graphWidth={suppression === null ? graphWidth : 1}
          density={props.density}
          width={width}
          selected={props.expandedHash === entry.hash}
          detached={props.detached}
          dirty={props.dirty}
          isBusy={props.isBusy}
          onToggleDrawer={(hash) => {
            setFocusedHash(hash);
            props.onExpandedHashChange(props.expandedHash === hash ? null : hash);
          }}
          onCopy={props.onCopy}
          onFilterAuthor={(author) => props.onFilterChange({ ...props.filter, author })}
          onTag={props.onTag}
          onCherryPick={props.onCherryPick}
          onCheckout={props.onCheckout}
          onReset={props.onReset}
          onRevert={props.onRevert}
        />
      );
    },
    [
      drawerHeight,
      focusedHash,
      graphWidth,
      handleMeasureDrawer,
      history,
      nodeByHash,
      props,
      suppression,
      width,
    ],
  );

  const firstLoad = history.isLoading && history.entries.length === 0;
  const empty = !firstLoad && history.entries.length === 0;

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-ring/60"
      onKeyDown={handleKeyDown}
      onFocus={handleContainerFocus}
      tabIndex={0}
      role="listbox"
      aria-label="Commit history"
      aria-activedescendant={focusedHash === null ? undefined : historyRowDomId(focusedHash)}
    >
      {suppression ? (
        <div className="flex flex-none items-center gap-2 border-border/60 border-b bg-muted/60 px-3 py-1 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1">
            The graph is hidden while the list is {suppression}.
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0"
            onClick={() => {
              props.onFilterChange({ query: "", author: "" });
              props.onSortChange("newest");
              props.onGroupedChange(false);
            }}
          >
            <X />
            Restore graph
          </Button>
        </div>
      ) : null}

      {history.error ? (
        <div className="flex-none px-3 py-2">
          <Alert variant="error" className="px-3 py-2">
            <AlertCircle />
            <AlertTitle className="text-xs">The history could not be read</AlertTitle>
            <AlertDescription className="text-xs">
              <span className="line-clamp-3 break-words">{history.error}</span>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {firstLoad ? (
        <div className="min-h-0 flex-1 space-y-1 p-3" role="status" aria-live="polite">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="flex items-center gap-2">
              <Skeleton className="size-3 shrink-0 rounded-full" />
              <Skeleton className="h-3.5 flex-1 rounded-full" />
            </div>
          ))}
          <span className="sr-only">Loading commit history…</span>
        </div>
      ) : empty ? (
        <Empty className="min-h-0 flex-1 justify-center gap-4 p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {history.filterActive ? <SearchX /> : <GitCommitHorizontal />}
            </EmptyMedia>
            <EmptyTitle className="text-base">
              {history.filterActive ? "No commits match" : "No commits yet"}
            </EmptyTitle>
            <EmptyDescription className="text-xs">
              {history.filterActive
                ? describeHistoryFilter(props.filter)
                : "This branch has no history to show."}
            </EmptyDescription>
          </EmptyHeader>
          {history.filterActive ? (
            <EmptyContent>
              <Button
                size="sm"
                variant="outline"
                onClick={() => props.onFilterChange({ query: "", author: "" })}
              >
                Clear filters
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <div className={cn("min-h-0 flex-1", history.isSearching && "opacity-80")}>
          <LegendList<HistoryRow>
            ref={listRef}
            data={rows as HistoryRow[]}
            keyExtractor={(row) => row.key}
            getItemType={(row) => row.kind}
            getFixedItemSize={(row) =>
              historyRowHeight(row, { density: props.density, width, drawerHeight })
            }
            estimatedItemSize={44}
            drawDistance={600}
            recycleItems
            renderItem={({ item }) => renderRow(item)}
            className="size-full overflow-x-hidden"
          />
        </div>
      )}
    </div>
  );
}

function describeHistoryFilter(filter: HistoryFilter): string {
  const query = filter.query.trim();
  if (query.length > 0 && filter.author.length > 0) {
    return `Nothing by ${filter.author} matches “${query}”.`;
  }
  if (query.length > 0) {
    return `No commits match “${query}”.`;
  }
  if (filter.author.length > 0) {
    return `No commits by ${filter.author}.`;
  }
  return "No commits match the current filters.";
}
