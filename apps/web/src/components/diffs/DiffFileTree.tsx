import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "../files/fileTreeExpansion";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Menu, MenuItem, MenuPopup } from "../ui/menu";
import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreePositions,
  diffFileTreeReviewEntries,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  /** All files affected by review actions, including folder descendants hidden by filters. */
  readonly reviewEntries?: ReadonlyArray<DiffFileTreeEntry>;
  /** Called with the file's path when the reader picks a file row. */
  readonly onSelectFile: (path: string) => void;
  /**
   * The file the diff is currently showing, kept selected in the tree. Bump `revealRequestId` to
   * scroll the tree to the same path again.
   */
  readonly selectedPath?: string | null;
  readonly revealRequestId?: number;
  readonly ariaLabel: string;
  /** Right-aligned content in the header row, after the file count. */
  readonly headerAccessory?: ReactNode;
  /** Rendered under the tree, for a host that still has files to fetch. */
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly headerLabel?: string;
  readonly onReviewFiles?: ((paths: ReadonlyArray<string>, reviewed: boolean) => void) | undefined;
}

/**
 * A directory tree of the files in a diff. Every directory starts open: a diff is a short list
 * compared to a workspace, and the reader came for the files, not the folders.
 */
export function DiffFileTree({
  entries,
  reviewEntries = entries,
  onSelectFile,
  selectedPath = null,
  revealRequestId = 0,
  ariaLabel,
  headerAccessory,
  footer,
  className,
  headerLabel = "Files",
  onReviewFiles,
}: DiffFileTreeProps) {
  const { resolvedTheme } = useTheme();
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const directoryPaths = useMemo(() => collectDirectoryPaths(paths), [paths]);
  const positions = useMemo(() => diffFileTreePositions(paths), [paths]);
  const [ordering] = useState(() => {
    let currentPositions: ReadonlyMap<string, number> = new Map();
    return {
      sort: compareDiffFileTreeEntries(() => currentPositions),
      update: (nextPositions: ReadonlyMap<string, number>) => {
        currentPositions = nextPositions;
      },
    };
  });
  const gitStatus = useMemo<ReadonlyArray<GitStatusEntry>>(
    () => entries.map((entry) => ({ path: entry.path, status: entry.status })),
    [entries],
  );
  const filePathsRef = useRef<ReadonlySet<string>>(new Set(paths));
  const onSelectFileRef = useRef(onSelectFile);
  // Selection driven by `selectedPath` below is an echo of a file already on screen, not a
  // request to scroll to it again.
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{ path: string; revealRequestId: number } | null>(null);
  const mountedPathsRef = useRef<ReadonlyArray<string> | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const reviewEntriesRef = useRef(reviewEntries);
  reviewEntriesRef.current = reviewEntries;

  useEffect(() => {
    filePathsRef.current = new Set(paths);
    onSelectFileRef.current = onSelectFile;
  }, [onSelectFile, paths]);

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      if (syncingSelectionRef.current) return;
      const path = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (path && filePathsRef.current.has(path)) onSelectFileRef.current(path);
    },
    paths: [],
    search: false,
    sort: ordering.sort,
    unsafeCSS: `${PIERRE_TREE_UNSAFE_CSS}
      /* Preserve both the review check and count in Pierre's custom decoration lane. */
      [data-item-section='decoration'] { min-width: max-content; }
      [data-item-section='decoration'] > span { flex: none; max-width: none; }
    `,
    composition: {
      contextMenu: { enabled: false, triggerMode: "right-click" },
    },
    renderRowDecoration: ({ item }) => {
      const matches = entriesRef.current.filter((entry) =>
        item.kind === "directory"
          ? entry.path.startsWith(item.path.endsWith("/") ? item.path : `${item.path}/`)
          : entry.path === item.path,
      );
      const count = matches.reduce((total, entry) => total + (entry.unresolvedComments ?? 0), 0);
      const reviewed = matches.length > 0 && matches.every((entry) => entry.reviewed);
      if (!reviewed && count === 0) return null;
      return {
        text: `${reviewed ? "✓" : ""}${count > 0 ? ` ${count}` : ""}`.trim(),
        title: `${reviewed ? "Reviewed. " : ""}${count > 0 ? `${count} unresolved or pending comments` : ""}`,
      };
    },
  });
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );

  useEffect(() => {
    ordering.update(positions);
    model.setGitStatus(gitStatus);
    const mountedPaths = mountedPathsRef.current;
    if (mountedPaths === paths) return;
    mountedPathsRef.current = paths;
    if (mountedPaths === null) {
      model.resetPaths(paths);
    } else if (mountedPaths.every((path, index) => paths[index] === path)) {
      // PR slices only append files, so keep the existing tree and its open folders.
      const updates = buildDiffFileTreeUpdates(mountedPaths, paths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A refreshed diff can change the rank of existing siblings. Mutations do not reorder
      // those rows, so rebuild while carrying the reader's folder expansion forward.
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && "isExpanded" in directory && !directory.isExpanded();
      });
      model.resetPaths(paths);
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && "collapse" in directory) directory.collapse();
      }
    }
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, ordering, paths, positions]);

  useEffect(() => {
    // Pierre ignores unchanged git statuses, so reviewed/comment-only updates need a render
    // of the existing tree. This preserves its scroll, selection, and folder expansion.
    if (model.getFileTreeContainer()) model.render({});
  }, [entries, model]);

  useEffect(() => {
    if (selectedPath === null) {
      handledRevealRef.current = null;
      return;
    }
    // A path list that changes under an already-revealed file (a refresh, a later slice) must
    // not pull the tree back to it over whatever the reader has picked since.
    const item = model.getItem(selectedPath);
    if (item === null || item.isDirectory()) {
      // A file that left the diff has to be revealed again when it comes back.
      handledRevealRef.current = null;
      return;
    }
    const handled = handledRevealRef.current;
    if (handled?.path === selectedPath && handled.revealRequestId === revealRequestId) return;
    handledRevealRef.current = { path: selectedPath, revealRequestId };
    syncingSelectionRef.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== selectedPath) model.getItem(path)?.deselect();
    }
    let ancestor = "";
    for (const segment of selectedPath.split("/").slice(0, -1)) {
      ancestor += `${segment}/`;
      const directory = model.getItem(ancestor);
      if (directory !== null && "expand" in directory) directory.expand();
    }
    item.select();
    model.scrollToPath(selectedPath, { offset: "nearest" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
    // `paths` is a dependency so a file that arrives after it was asked for is still revealed.
  }, [model, paths, revealRequestId, selectedPath]);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">{headerLabel}</span>
        <span className="ml-auto tabular-nums">{entries.length}</span>
        {headerAccessory}
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                  }
                  onClick={() =>
                    setAllDirectoriesExpanded(model, directoryPaths, !allDirectoriesExpanded)
                  }
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
              />
            </TooltipTrigger>
            <TooltipPopup>
              {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <FileTree
        model={model}
        aria-label={ariaLabel}
        onClickCapture={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          // Pierre does not emit a selection change for its sole selected row.
          // Read selection before the row handles the click so new selections reveal only once.
          const selected = model.getSelectedPaths();
          const path = selected.length === 1 ? selected[0] : undefined;
          if (!path || !filePathsRef.current.has(path)) return;
          const clickedSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
            );
          if (clickedSelectedRow) onSelectFileRef.current(path);
        }}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
        {...(onReviewFiles
          ? {
              renderContextMenu: (item, context) => {
                const matches = diffFileTreeReviewEntries(
                  reviewEntriesRef.current,
                  model.getSelectedPaths(),
                  item.path,
                );
                if (matches.length === 0) return null;
                const paths = matches.map((entry) => entry.path);
                const canMarkReviewed = matches.some((entry) => !entry.reviewed);
                const canMarkUnreviewed = matches.some((entry) => entry.reviewed);
                return (
                  <Menu
                    open
                    onOpenChange={(open) => {
                      if (!open) context.close();
                    }}
                  >
                    <MenuPopup
                      anchor={context.anchorElement}
                      data-file-tree-context-menu-root="true"
                      align="start"
                    >
                      {canMarkReviewed ? (
                        <MenuItem
                          onClick={() => {
                            onReviewFiles(paths, true);
                            context.close();
                          }}
                        >
                          Mark as reviewed
                        </MenuItem>
                      ) : null}
                      {canMarkUnreviewed ? (
                        <MenuItem
                          onClick={() => {
                            onReviewFiles(paths, false);
                            context.close();
                          }}
                        >
                          Mark as unreviewed
                        </MenuItem>
                      ) : null}
                    </MenuPopup>
                  </Menu>
                );
              },
            }
          : {})}
      />
      {footer}
    </div>
  );
}
