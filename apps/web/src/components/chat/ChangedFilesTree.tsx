import { useSyncLayout } from "@legendapp/list/react";
import { type OrchestrationV2CheckpointFileTotals, type RunId } from "@t3tools/contracts";
import { type MouseEvent, type ReactNode, memo, useLayoutEffect, useRef, useState } from "react";
import { type TurnDiffFileChange } from "../../types";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import {
  ChevronRightIcon,
  FileDiffIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FolderClosedIcon,
  FolderGit2Icon,
  FolderIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import { observeResize } from "~/lib/observeResize";
import { repositoryFilePath } from "@t3tools/client-runtime/state/thread-repositories";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};
const VIRTUALIZE_AFTER_ROWS = 250;
const ROW_OVERSCAN = 8;

interface ChangedFileRow {
  node: TurnDiffTreeNode;
  depth: number;
}

/** One folder's share of a turn that changed several repositories. */
export interface ChangedFilesGroup {
  readonly key: string;
  readonly name: string;
  /** Paths relative to this group's folder. */
  readonly files: ReadonlyArray<TurnDiffFileChange>;
  readonly totals: OrchestrationV2CheckpointFileTotals;
  /** The folder from the thread's folder; undefined when the diff cannot be opened at a file. */
  readonly relativePath: string | undefined;
  /** Shown in place of the files when they cannot be listed. */
  readonly note?: string | undefined;
}

type ChangedFileContextMenuHandler = (
  filePath: string,
  event: MouseEvent,
  group?: ChangedFilesGroup,
) => void;

function groupDiffPath(group: ChangedFilesGroup, filePath: string | undefined) {
  return filePath === undefined || group.relativePath === undefined
    ? undefined
    : repositoryFilePath(group.relativePath, filePath);
}

export const ChangedFilesCard = memo(function ChangedFilesCard(props: {
  runId: RunId;
  /** May be a prefix of the changed files; `totals` covers all of them. */
  files: ReadonlyArray<TurnDiffFileChange>;
  totals: OrchestrationV2CheckpointFileTotals;
  /** Set when the turn changed tracked repositories; replaces the single tree built from `files`. */
  groups?: ReadonlyArray<ChangedFilesGroup> | undefined;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onToggleAllDirectories: () => void;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  onFileContextMenu?: ChangedFileContextMenuHandler | undefined;
}) {
  const {
    runId,
    files,
    totals,
    groups,
    allDirectoriesExpanded,
    resolvedTheme,
    onToggleAllDirectories,
    onOpenTurnDiff,
    onFileContextMenu,
  } = props;
  const syncTimelineLayout = useSyncLayout();
  const listedFiles = groups ? groups.flatMap((group) => group.files) : files;
  const hiddenFileCount = totals.count - listedFiles.length;
  const hasDirectories = listedFiles.some((file) => /[/\\]/.test(file.path));
  const firstGroup = groups?.find((group) => group.files.length > 0);
  const firstFilePath = groups
    ? firstGroup && groupDiffPath(firstGroup, firstGroup.files[0]?.path)
    : files[0]?.path;

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
            {totals.count.toLocaleString()} changed file{totals.count === 1 ? "" : "s"}
          </span>
          {hasNonZeroStat(totals) && (
            <DiffStatLabel
              additions={totals.additions}
              deletions={totals.deletions}
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
                    onClick={() => {
                      onToggleAllDirectories();
                      syncTimelineLayout();
                    }}
                  />
                }
              >
                {allDirectoriesExpanded ? (
                  <ChevronsDownUpIcon className="size-3" />
                ) : (
                  <ChevronsUpDownIcon className="size-3" />
                )}
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
                  onClick={() => onOpenTurnDiff(runId, firstFilePath)}
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
      <div className="p-2">
        {groups ? (
          groups.map((group) => (
            <ChangedFilesGroupSection
              key={group.key}
              runId={runId}
              group={group}
              allDirectoriesExpanded={allDirectoriesExpanded}
              resolvedTheme={resolvedTheme}
              onOpenTurnDiff={onOpenTurnDiff}
              onFileContextMenu={onFileContextMenu}
            />
          ))
        ) : (
          <ChangedFilesTree
            key={`${runId}:${allDirectoriesExpanded}`}
            runId={runId}
            files={files}
            allDirectoriesExpanded={allDirectoriesExpanded}
            resolvedTheme={resolvedTheme}
            onOpenTurnDiff={onOpenTurnDiff}
            onFileContextMenu={onFileContextMenu}
          />
        )}
      </div>
      {hiddenFileCount > 0 && (
        <div className="px-3 pb-2">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() => onOpenTurnDiff(runId, firstFilePath)}
          >
            {hiddenFileCount.toLocaleString()} more file{hiddenFileCount === 1 ? "" : "s"} in the
            full diff
          </Button>
        </div>
      )}
    </div>
  );
});

function ChangedFilesGroupSection(props: {
  runId: RunId;
  group: ChangedFilesGroup;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  onFileContextMenu?: ChangedFileContextMenuHandler | undefined;
}) {
  const { runId, group, allDirectoriesExpanded, resolvedTheme, onOpenTurnDiff, onFileContextMenu } =
    props;
  const [collapsed, setCollapsed] = useState(false);
  const syncTimelineLayout = useSyncLayout();
  return (
    <section data-changed-files-group={group.name}>
      <button
        type="button"
        data-scroll-anchor-ignore
        aria-expanded={!collapsed}
        className="group flex h-7 w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => {
          setCollapsed(!collapsed);
          syncTimelineLayout();
        }}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
            !collapsed && "rotate-90",
          )}
        />
        <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground/75" />
        <span className="truncate font-mono text-2xs text-foreground/90">{group.name}</span>
        {hasNonZeroStat(group.totals) && (
          <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
            <DiffStatLabel additions={group.totals.additions} deletions={group.totals.deletions} />
          </span>
        )}
      </button>
      {collapsed ? null : group.note !== undefined ? (
        <p className="py-1.5 pr-2 pl-9.5 text-2xs text-muted-foreground">{group.note}</p>
      ) : (
        <ChangedFilesTree
          key={`${runId}:${allDirectoriesExpanded}`}
          runId={runId}
          files={group.files}
          baseDepth={1}
          allDirectoriesExpanded={allDirectoriesExpanded}
          resolvedTheme={resolvedTheme}
          onOpenTurnDiff={(run, filePath) => onOpenTurnDiff(run, groupDiffPath(group, filePath))}
          onFileContextMenu={
            onFileContextMenu
              ? (filePath, event) => onFileContextMenu(filePath, event, group)
              : undefined
          }
        />
      )}
    </section>
  );
}

const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  runId: RunId;
  files: ReadonlyArray<TurnDiffFileChange>;
  /** Rows start this deep, below the row of the folder the files belong to. */
  baseDepth?: number;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  onFileContextMenu?: ChangedFileContextMenuHandler | undefined;
}) {
  const baseDepth = props.baseDepth ?? 0;
  const { files, allDirectoriesExpanded, onOpenTurnDiff, resolvedTheme, runId, onFileContextMenu } =
    props;
  // Place state before tree derivation to preserve its compiler cache.
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string | null;
    overrides: Record<string, boolean>;
  }>({ key: null, overrides: {} });
  const syncTimelineLayout = useSyncLayout();
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
    // Measure before paint instead of waiting for LegendList's deferred shrink measurement.
    syncTimelineLayout();
  };

  const rows = collectExpandedRows(treeNodes, expandedDirectories, allDirectoriesExpanded);
  const virtualized = rows.length > VIRTUALIZE_AFTER_ROWS;

  const renderRow = ({ node, depth }: ChangedFileRow) => {
    const leftPadding = 8 + (baseDepth + depth) * 14;
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
          {isExpanded ? (
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
          ) : (
            <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
          )}
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
        {hasDirectoryNodes || baseDepth + depth > 0 ? (
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes scroll, window resize and ancestor resizes to compute the virtualized row range
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
