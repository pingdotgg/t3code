import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "../files/fileTreeExpansion";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreeModel,
  diffFileTreePositions,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
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
}

/**
 * A directory tree of the files in a diff. Every directory starts open: a diff is a short list
 * compared to a workspace, and the reader came for the files, not the folders.
 *
 * A file replaced by a directory of the same name (or the reverse) is still one tree. Those
 * paths are rewritten before they reach Pierre, and selection is translated back.
 */
export function DiffFileTree({
  entries,
  onSelectFile,
  selectedPath = null,
  revealRequestId = 0,
  ariaLabel,
  headerAccessory,
  footer,
  className,
}: DiffFileTreeProps) {
  const { resolvedTheme } = useTheme();
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const presented = useMemo(() => diffFileTreeModel(paths), [paths]);
  const modelPaths = presented.paths;
  const directoryPaths = useMemo(() => collectDirectoryPaths(modelPaths), [modelPaths]);
  const positions = useMemo(() => diffFileTreePositions(modelPaths), [modelPaths]);
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
    () =>
      entries.map((entry, index) => ({
        path: modelPaths[index] ?? entry.path,
        status: entry.status,
      })),
    [entries, modelPaths],
  );
  const filePathsRef = useRef<ReadonlySet<string>>(new Set(modelPaths));
  const onSelectFileRef = useRef(onSelectFile);
  const toSelectionPathRef = useRef(presented.selectionPath);
  // Selection driven by `selectedPath` below is an echo of a file already on screen, not a
  // request to scroll to it again.
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{
    path: string;
    revealRequestId: number;
    modelPath: string;
  } | null>(null);
  const mountedPathsRef = useRef<ReadonlyArray<string> | null>(null);

  useEffect(() => {
    filePathsRef.current = new Set(modelPaths);
    onSelectFileRef.current = onSelectFile;
    toSelectionPathRef.current = presented.selectionPath;
  }, [modelPaths, onSelectFile, presented.selectionPath]);

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      if (syncingSelectionRef.current) return;
      const raw = selectedPaths.at(-1);
      if (!raw) return;
      // Directory ids end in `/`. A file that shares that directory's name is stored under a
      // different model path, so stripping the slash must not select it.
      const modelPath = filePathsRef.current.has(raw) ? raw : raw.replace(/\/$/, "");
      if (!filePathsRef.current.has(modelPath)) return;
      onSelectFileRef.current(toSelectionPathRef.current(modelPath));
    },
    paths: [],
    search: false,
    sort: ordering.sort,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );

  useEffect(() => {
    ordering.update(positions);
    const mountedPaths = mountedPathsRef.current;
    if (mountedPaths === modelPaths) return;
    mountedPathsRef.current = modelPaths;
    if (mountedPaths === null) {
      model.resetPaths(modelPaths);
    } else if (mountedPaths.every((path, index) => modelPaths[index] === path)) {
      // PR slices only append files, so keep the existing tree and its open folders.
      const updates = buildDiffFileTreeUpdates(mountedPaths, modelPaths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A refreshed diff can change the rank of existing siblings. A file that becomes a
      // directory prefix also changes its model path, which Pierre cannot rename in place.
      // Rebuild while carrying the reader's folder expansion forward.
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && "isExpanded" in directory && !directory.isExpanded();
      });
      model.resetPaths(modelPaths);
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && "collapse" in directory) directory.collapse();
      }
    }
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, modelPaths, ordering, positions]);

  useEffect(() => {
    if (selectedPath === null) {
      handledRevealRef.current = null;
      return;
    }
    // A path list that changes under an already-revealed file (a refresh, a later slice) must
    // not pull the tree back to it over whatever the reader has picked since.
    const modelPath = presented.modelPath(selectedPath);
    const item = model.getItem(modelPath);
    if (item === null || item.isDirectory()) {
      // A file that left the diff has to be revealed again when it comes back.
      handledRevealRef.current = null;
      return;
    }
    const handled = handledRevealRef.current;
    if (
      handled?.path === selectedPath &&
      handled.revealRequestId === revealRequestId &&
      handled.modelPath === modelPath
    ) {
      return;
    }
    handledRevealRef.current = { path: selectedPath, revealRequestId, modelPath };
    syncingSelectionRef.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== modelPath) model.getItem(path)?.deselect();
    }
    let ancestor = "";
    for (const segment of modelPath.split("/").slice(0, -1)) {
      ancestor += `${segment}/`;
      const directory = model.getItem(ancestor);
      if (directory !== null && "expand" in directory) directory.expand();
    }
    item.select();
    model.scrollToPath(modelPath, { offset: "nearest" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
    // `presented` is a dependency so a file that arrives after it was asked for is still revealed.
  }, [model, presented, revealRequestId, selectedPath]);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">Files</span>
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
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
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
          const raw = selected.length === 1 ? selected[0] : undefined;
          if (!raw) return;
          const path = filePathsRef.current.has(raw) ? raw : raw.replace(/\/$/, "");
          if (!filePathsRef.current.has(path)) return;
          const clickedSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
            );
          if (clickedSelectedRow) onSelectFileRef.current(toSelectionPathRef.current(path));
        }}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
      />
      {footer}
    </div>
  );
}
