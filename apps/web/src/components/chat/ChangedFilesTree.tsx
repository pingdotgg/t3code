import { type RunId } from "@t3tools/contracts";
import { type MouseEvent, type ReactNode, memo, useLayoutEffect, useRef, useState } from "react";
import { type TurnDiffFileChange } from "../../types";
import {
  buildTurnDiffTree,
  summarizeTurnDiffStats,
  type TurnDiffTreeNode,
} from "../../lib/turnDiffTree";
import { ChevronRightIcon, FileDiffIcon } from "lucide-react";
import { ChevronsDownUp, ChevronsUpDown, Folder, FolderClosed } from "lucide";
import { cn } from "~/lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import { MorphIcon } from "~/components/MorphIcon";
import { observeResize } from "~/lib/observeResize";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};
const VIRTUALIZE_AFTER_ROWS = 250;
const ROW_OVERSCAN = 8;

interface ChangedFileRow {
  node: TurnDiffTreeNode;
  depth: number;
}

export type ChangedFileContextMenuHandler = (filePath: string, event: MouseEvent) => void;

export const ChangedFilesCard = memo(function ChangedFilesCard(props: {
  runId: RunId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onToggleAllDirectories: () => void;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  onFileContextMenu?: ChangedFileContextMenuHandler | undefined;
}) {
  const {
    runId,
    files,
    allDirectoriesExpanded,
    resolvedTheme,
    onToggleAllDirectories,
    onOpenTurnDiff,
    onFileContextMenu,
  } = props;
  const summaryStat = summarizeTurnDiffStats(files);
  const hasDirectories = files.some((file) => /[/\\]/.test(file.path));

  return (
    <div
      className="@container/changed-files mt-4 rounded-lg bg-secondary dark:bg-input/20"
      data-changed-files-state="tree"
    >
      <div
        data-changed-files-header=""
        className="sticky top-2 z-10 flex items-center justify-between gap-2 rounded-t-lg bg-secondary px-3 py-2 dark:bg-background dark:bg-linear-to-b dark:from-input/20 dark:to-input/20"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-foreground">
          <span>
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          {hasNonZeroStat(summaryStat) && (
            <DiffStatLabel
              additions={summaryStat.additions}
              deletions={summaryStat.deletions}
              layout="inline"
              className="text-xs leading-4"
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasDirectories && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={
                      allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                    }
                    data-scroll-anchor-ignore
                    onClick={onToggleAllDirectories}
                  />
                }
              >
                <MorphIcon
                  className="size-3"
                  icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
              </TooltipPopup>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  aria-label="Open diff"
                  onClick={() => onOpenTurnDiff(runId, files[0]?.path)}
                />
              }
            >
              <FileDiffIcon className="size-3" />
              <span className="hidden @[24rem]/changed-files:inline">Open diff</span>
            </TooltipTrigger>
            <TooltipPopup side="top">Open the full diff</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <ChangedFilesTree
        key={`${runId}:${allDirectoriesExpanded}`}
        runId={runId}
        files={files}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
        onFileContextMenu={onFileContextMenu}
      />
    </div>
  );
});

const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  runId: RunId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  onFileContextMenu?: ChangedFileContextMenuHandler | undefined;
}) {
  const { files, allDirectoriesExpanded, onOpenTurnDiff, resolvedTheme, runId, onFileContextMenu } =
    props;
  // Overrides apply only while their key matches the current one, so starting from no key is
  // the same as starting with no overrides. That lets this hook run before the tree is built,
  // and the compiler caches the tree on `files`.
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string | null;
    overrides: Record<string, boolean>;
  }>({ key: null, overrides: {} });
  const treeNodes = buildTurnDiffTree(files);
  const directoryPathsKey = collectDirectoryPaths(treeNodes).join("\u0000");
  const hasDirectoryNodes = directoryPathsKey.length > 0;
  const expansionStateKey = `${allDirectoriesExpanded ? "expanded" : "collapsed"}\u0000${directoryPathsKey}`;
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = (pathValue: string) => {
    setDirectoryExpansionState((current) => {
      const nextOverrides = current.key === expansionStateKey ? current.overrides : {};
      return {
        key: expansionStateKey,
        overrides: {
          ...nextOverrides,
          [pathValue]: !(nextOverrides[pathValue] ?? allDirectoriesExpanded),
        },
      };
    });
  };

  const rows = collectExpandedRows(treeNodes, expandedDirectories, allDirectoriesExpanded);
  const virtualized = rows.length > VIRTUALIZE_AFTER_ROWS;

  const renderRow = ({ node, depth }: ChangedFileRow) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <button
          key={`dir:${node.path}`}
          type="button"
          data-scroll-anchor-ignore
          aria-expanded={isExpanded}
          className="group flex h-7 w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          style={{ paddingLeft: `${leftPadding}px` }}
          onClick={() => toggleDirectory(node.path)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
              isExpanded && "rotate-90",
            )}
          />
          <MorphIcon
            className="size-3.5 shrink-0 text-muted-foreground/75"
            icon={isExpanded ? Folder : FolderClosed}
          />
          <span className="truncate font-mono text-2xs text-muted-foreground/90 group-hover:text-foreground/90">
            {node.name}
          </span>
          {hasNonZeroStat(node.stat) && (
            <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
              <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
            </span>
          )}
        </button>
      );
    }

    return (
      <button
        key={`file:${node.path}`}
        type="button"
        className="group flex h-7 w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenTurnDiff(runId, node.path)}
        onContextMenu={
          onFileContextMenu
            ? (event) => {
                event.preventDefault();
                onFileContextMenu(node.path, event);
              }
            : undefined
        }
      >
        {hasDirectoryNodes || depth > 0 ? (
          <span aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        <PierreEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground/70"
        />
        <span className="flex min-w-0 font-mono text-xs text-foreground/85 group-hover:text-foreground">
          <MiddleTruncate value={node.name} />
        </span>
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return <ChangedFilesRows rows={rows} renderRow={renderRow} virtualized={virtualized} />;
});

function ChangedFilesRows({
  rows,
  renderRow,
  virtualized,
}: {
  rows: ReadonlyArray<ChangedFileRow>;
  renderRow: (row: ChangedFileRow) => ReactNode;
  virtualized: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowSizeRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 40, rowHeight: 28 });
  const [focusedPath, setFocusedPath] = useState<string | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const rowSize = rowSizeRef.current;
    if (!virtualized || !container || !rowSize) return;

    // The card is inside a virtualized timeline item, so its own scrollTop is always zero.
    // Observe its ancestors too: streaming text and timeline layout can move the card.
    const ancestors: HTMLElement[] = [container, rowSize];
    let scrollElement: HTMLElement | null = null;
    for (let parent = container.parentElement; parent; parent = parent.parentElement) {
      ancestors.push(parent);
      if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) {
        scrollElement = parent;
        break;
      }
    }

    const measure = () => {
      const rowHeight = rowSize.getBoundingClientRect().height;
      if (rowHeight <= 0) return;
      const listTop = container.getBoundingClientRect().top;
      const viewportTop = scrollElement
        ? scrollElement.getBoundingClientRect().top + scrollElement.clientTop
        : 0;
      const viewportHeight = scrollElement?.clientHeight ?? document.documentElement.clientHeight;
      const start = Math.max(
        0,
        Math.min(rows.length, Math.floor((viewportTop - listTop) / rowHeight) - ROW_OVERSCAN),
      );
      const end = Math.max(
        start,
        Math.min(
          rows.length,
          Math.ceil((viewportTop + viewportHeight - listTop) / rowHeight) + ROW_OVERSCAN,
        ),
      );
      setRange((current) =>
        current.start === start && current.end === end && current.rowHeight === rowHeight
          ? current
          : { start, end, rowHeight },
      );
    };
    measure();
    const scrollTarget = scrollElement ?? globalThis.window;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    globalThis.window.addEventListener("resize", onScroll);
    const stopObserving = observeResize(ancestors, measure);
    return () => {
      scrollTarget.removeEventListener("scroll", onScroll);
      globalThis.window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
      stopObserving();
    };
  }, [virtualized, rows.length]);

  const focusedIndex =
    focusedPath === null ? -1 : rows.findIndex((row) => row.node.path === focusedPath);
  const start = virtualized ? range.start : 0;
  const end = virtualized ? Math.min(rows.length, range.end) : rows.length;
  const indices = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
  // Keep keyboard focus on its row when mouse scrolling moves it outside the render window.
  if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
  if (focusedIndex >= end) indices.push(focusedIndex);
  return (
    <div className="p-2">
      <div
        ref={containerRef}
        className="relative"
        style={virtualized ? { height: rows.length * range.rowHeight } : undefined}
        onFocusCapture={(event) => {
          const row = event.target.closest<HTMLElement>("[data-changed-file-row]");
          setFocusedPath(row?.dataset.changedFileRow ?? null);
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedPath(null);
        }}
      >
        {virtualized && (
          <div
            ref={rowSizeRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute h-7"
          />
        )}
        {indices.map((index) => {
          const row = rows[index]!;
          return (
            <div
              key={`${row.node.kind}:${row.node.path}`}
              data-changed-file-row={row.node.path}
              className={virtualized ? "absolute inset-x-0" : undefined}
              style={virtualized ? { top: index * range.rowHeight } : undefined}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function collectExpandedRows(
  nodes: ReadonlyArray<TurnDiffTreeNode>,
  overrides: Readonly<Record<string, boolean>>,
  allDirectoriesExpanded: boolean,
  depth = 0,
  rows: ChangedFileRow[] = [],
): ChangedFileRow[] {
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "directory" && (overrides[node.path] ?? allDirectoriesExpanded)) {
      collectExpandedRows(node.children, overrides, allDirectoriesExpanded, depth + 1, rows);
    }
  }
  return rows;
}

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
