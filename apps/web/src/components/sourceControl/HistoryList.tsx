/**
 * The History tab: toolbar, lane graph, virtualized rows, drawer, load-more.
 *
 * The lane graph is folded ONCE over the full contiguous newest-first page —
 * `history.page.entries`, never `history.entries` (the filtered/merged view)
 * and never the visible window. When the list is filtered, sorted oldest-first
 * or grouped by day the graph is *suppressed* with a visible notice and a
 * one-click restore, because a graph folded over a non-contiguous sequence is
 * silently wrong, which is worse than no graph.
 *
 * fork: f4 source-control panel
 */
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  historyAuthorFacets,
  type HistoryFilter,
} from "@t3tools/client-runtime/state/working-copy-logic";
import type { WorkingCopyCommitDetail, WorkingCopyLogEntry } from "@t3tools/contracts";
import { Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  HISTORY_DAY_ROW_HEIGHT,
  HISTORY_DEFAULT_DRAWER_HEIGHT,
  HISTORY_LOAD_MORE_ROW_HEIGHT,
  buildHistoryRows,
  historyDayLabel,
  historyRowHeight,
  type HistoryDensity,
  type HistoryRow,
} from "~/lib/sourceControl/historyRows";
import {
  buildLaneGraph,
  laneGraphSuppression,
  laneGraphWidth,
  plainLaneNode,
  type LaneNode,
} from "~/lib/sourceControl/laneGraph";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { CommitDrawer } from "./CommitDrawer";
import { CommitRow } from "./CommitRow";
import { historyWidthBucket } from "./sourceControlPanel.logic";
import type { WorkingCopyHistoryView } from "./useWorkingCopyHistory";

export interface HistoryListProps {
  readonly history: WorkingCopyHistoryView;
  readonly filter: HistoryFilter;
  readonly onFilterChange: (filter: HistoryFilter) => void;
  readonly grouped: boolean;
  readonly onGroupedChange: (grouped: boolean) => void;
  readonly sort: "newest" | "oldest";
  readonly onSortChange: (sort: "newest" | "oldest") => void;
  readonly density: HistoryDensity;
  readonly onDensityChange: (density: HistoryDensity) => void;
  readonly detached: boolean;
  readonly dirty: boolean;
  readonly commitDetail: WorkingCopyCommitDetail | null;
  readonly commitDetailLoading: boolean;
  readonly expandedHash: string | null;
  readonly onExpandedHashChange: (hash: string | null) => void;
  readonly onCopy: (text: string) => void;
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
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [widthPx, setWidthPx] = useState(480);

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
  const graphWidth = useMemo(() => laneGraphWidth(laneNodes), [laneNodes]);

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

  const authors = useMemo(() => historyAuthorFacets(history.page.entries), [history.page.entries]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, [contenteditable='true']") !== null;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        if (props.expandedHash !== null) {
          props.onExpandedHashChange(null);
          return;
        }
        if (history.filterActive) {
          props.onFilterChange({ query: "", author: "" });
        }
      }
    },
    [history.filterActive, props],
  );

  const renderRow = useCallback(
    (row: HistoryRow) => {
      if (row.kind === "day") {
        return (
          <div
            style={{ height: HISTORY_DAY_ROW_HEIGHT }}
            className="flex items-center bg-background px-2 font-medium text-[10px] text-muted-foreground uppercase tracking-wide"
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
            <Button
              size="sm"
              variant="outline"
              disabled={history.isLoading}
              onClick={history.loadMore}
            >
              {history.isLoading ? "Loading…" : "Load more"}
            </Button>
          </div>
        );
      }
      if (row.kind === "drawer") {
        return (
          <CommitDrawer
            detail={props.commitDetail}
            isLoading={props.commitDetailLoading}
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
          node={
            suppression === null ? (nodeByHash.get(entry.hash) ?? null) : plainLaneNode(entry.hash)
          }
          graphWidth={suppression === null ? graphWidth : 1}
          density={props.density}
          width={width}
          selected={props.expandedHash === entry.hash}
          detached={props.detached}
          dirty={props.dirty}
          onToggleDrawer={(hash) =>
            props.onExpandedHashChange(props.expandedHash === hash ? null : hash)
          }
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
    [graphWidth, history, nodeByHash, props, suppression, width],
  );

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="listbox"
      aria-label="Commit history"
    >
      <div className="flex flex-none items-center gap-1.5 border-border/60 border-b p-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={props.filter.query}
            onChange={(event) =>
              props.onFilterChange({ ...props.filter, query: event.target.value })
            }
            placeholder="Search commits ( / )"
            className="h-7 pl-7 text-xs"
            aria-label="Search commits"
          />
        </div>
        <Menu>
          <MenuTrigger className="h-7 shrink-0 rounded-md px-2 text-muted-foreground text-xs hover:bg-accent hover:text-foreground">
            {props.filter.author || "Author"}
          </MenuTrigger>
          <MenuPopup
            align="end"
            side="bottom"
            sideOffset={6}
            className="max-h-64 min-w-44 overflow-auto"
          >
            <MenuItem onClick={() => props.onFilterChange({ ...props.filter, author: "" })}>
              All authors
            </MenuItem>
            {authors.map((author) => (
              <MenuItem
                key={author.name}
                onClick={() => props.onFilterChange({ ...props.filter, author: author.name })}
              >
                {author.name}
                <span className="ml-auto text-muted-foreground">{author.count}</span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            className="h-7 shrink-0 rounded-md px-2 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
            aria-label="History view options"
          >
            View
          </MenuTrigger>
          <MenuPopup align="end" side="bottom" sideOffset={6} className="min-w-48">
            <MenuItem onClick={() => props.onGroupedChange(!props.grouped)}>
              {props.grouped ? "Ungroup" : "Group by day"}
            </MenuItem>
            <MenuItem
              onClick={() => props.onSortChange(props.sort === "newest" ? "oldest" : "newest")}
            >
              Sort {props.sort === "newest" ? "oldest first" : "newest first"}
            </MenuItem>
            <MenuItem
              onClick={() =>
                props.onDensityChange(props.density === "compact" ? "comfort" : "compact")
              }
            >
              {props.density === "compact" ? "Comfortable rows" : "Compact rows"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      {suppression ? (
        <div className="flex flex-none items-center gap-2 border-border/60 border-b bg-muted/32 px-2 py-1 text-[11px] text-muted-foreground">
          <span>The graph is hidden while the list is {suppression}.</span>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 rounded-sm px-1 hover:bg-accent hover:text-foreground"
            onClick={() => {
              props.onFilterChange({ query: "", author: "" });
              props.onSortChange("newest");
              props.onGroupedChange(false);
            }}
          >
            <X className="size-3" />
            Restore graph
          </button>
        </div>
      ) : null}

      {history.error ? (
        <p className="flex-none px-2 py-1 text-destructive-foreground text-xs">{history.error}</p>
      ) : null}

      <div className={cn("min-h-0 flex-1", history.isSearching && "opacity-80")}>
        <LegendList<HistoryRow>
          ref={listRef}
          data={rows as HistoryRow[]}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.kind}
          getFixedItemSize={(row) =>
            historyRowHeight(row, {
              density: props.density,
              width,
              drawerHeight: HISTORY_DEFAULT_DRAWER_HEIGHT,
            })
          }
          estimatedItemSize={52}
          drawDistance={600}
          recycleItems
          renderItem={({ item }) => renderRow(item)}
          className="size-full overflow-x-hidden"
        />
      </div>
    </div>
  );
}
