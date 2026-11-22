import type { FileTreeRowDecorationContext, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { T, useGT } from "gt-react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, ListIcon, ListTreeIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import {
  type PointerEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import {
  PIERRE_TREE_UNSAFE_CSS,
  pierreTreeStyle,
  titleClippedPierreTreeRow,
} from "~/pierre-tree-theme";

import {
  areAllDirectoriesExpanded,
  setAllDirectoriesExpanded,
  subscribeOncePerTask,
} from "../files/fileTreeExpansion";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileListModel,
  diffFileTreeModel,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";
import {
  diffFileTreePositions,
  orderDiffFilesLikeTree,
} from "@t3tools/client-runtime/diff-file-order";

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  readonly onSelectFile: (path: string) => void;
  readonly selectedPath?: string | null;
  readonly revealRequestId?: number;
  readonly ariaLabel: string;
  readonly headerAccessory?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}

const DIFF_FILE_LIST_VIEW_STORAGE_KEY = "t3code.diffFileListView";

// List rows read as the file's name followed by its dimmed folder; tree rows have no decoration.
const DIFF_FILE_TREE_UNSAFE_CSS = `${PIERRE_TREE_UNSAFE_CSS}
  [data-item-section='decoration'],
  [data-item-section='decoration'] > span { justify-content: flex-start; text-align: start; }
  [data-item-section='decoration'] > span { padding-inline-start: 0.5em; }
`;

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
  const [listView, setListView] = useLocalStorage(
    DIFF_FILE_LIST_VIEW_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const gt = useGT();
  const { resolvedTheme } = useTheme();
  const paths = entries.map((entry) => entry.path);
  const presented = listView ? diffFileListModel(paths) : diffFileTreeModel(paths);
  const modelPaths = presented.paths;
  const icons = presented.icons;
  const directoryPaths = collectDirectoryPaths(modelPaths);
  const positions = listView
    ? new Map(
        orderDiffFilesLikeTree(paths, (path) => path).map((path, index) => [
          presented.modelPath(path) ?? path,
          index,
        ]),
      )
    : diffFileTreePositions(modelPaths);
  const [ordering] = useState(() => {
    let currentPositions: ReadonlyMap<string, number> = new Map();
    return {
      sort: compareDiffFileTreeEntries(() => currentPositions),
      update: (nextPositions: ReadonlyMap<string, number>) => {
        currentPositions = nextPositions;
      },
    };
  });
  const gitStatus: ReadonlyArray<GitStatusEntry> = entries.map((entry) => ({
    path: presented.modelPath(entry.path) ?? entry.path,
    status: entry.status,
  }));
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{
    path: string;
    revealRequestId: number;
  } | null>(null);
  const mountedPresentationRef = useRef<typeof presented | null>(null);
  // A list has no folders, so the tree's collapsed folders wait here for the tree to return.
  const collapsedTreeDirectoriesRef = useRef<ReadonlySet<string>>(new Set());

  // The tree model keeps the first selection handler it was given.
  const handleSelectionChange = useStableCallback((selectedPaths: ReadonlyArray<string>) => {
    if (syncingSelectionRef.current) return;
    const modelPath = selectedPaths.at(-1);
    if (modelPath && modelPaths.includes(modelPath)) {
      onSelectFile(presented.selectionPath(modelPath));
    }
  });

  // A list row may clip its name or folder, so hovering it shows the file's full path.
  const titleListRow = useStableCallback((event: PointerEvent<HTMLElement>) => {
    const row = event.nativeEvent
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.matches("button[data-type='item']"),
      );
    const modelPath = row?.getAttribute("data-item-path");
    if (!row || !modelPath) return;
    const path = presented.selectionPath(modelPath);
    if (row.title !== path) row.title = path;
  });

  const renderListRowDecoration = useStableCallback(({ item }: FileTreeRowDecorationContext) => {
    if (!listView) return null;
    const path = presented.selectionPath(item.path);
    const folderEnd = path.lastIndexOf("/");
    return folderEnd > 0 ? { text: path.slice(0, folderEnd), title: path } : null;
  });

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons,
    onSelectionChange: handleSelectionChange,
    paths: [],
    search: false,
    sort: ordering.sort,
    renderRowDecoration: renderListRowDecoration,
    unsafeCSS: DIFF_FILE_TREE_UNSAFE_CSS,
  });
  const allDirectoriesExpanded = useSyncExternalStore(
    (listener) => subscribeOncePerTask(model, listener),
    () => areAllDirectoriesExpanded(model, directoryPaths),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the icon set into the imperative Pierre file tree model
  useEffect(() => {
    model.setIcons(icons);
  }, [icons, model]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies path updates, ordering and git status to the imperative Pierre file tree model
  useEffect(() => {
    ordering.update(positions);
    const mounted = mountedPresentationRef.current;
    if (mounted?.paths === modelPaths) return;
    mountedPresentationRef.current = presented;
    if (mounted === null) {
      model.resetPaths(modelPaths);
    } else if (
      mounted.paths.every(
        (path, index) =>
          modelPaths[index] === path &&
          // A list alias can move to another file when a same-named file is added before it.
          presented.selectionPath(path) === mounted.selectionPath(path),
      )
    ) {
      const updates = buildDiffFileTreeUpdates(mounted.paths, modelPaths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A reset can turn a file path into a directory. Carry selection and focus
      // through real paths so paging keeps the same file without revealing it again.
      const focusedPath = model.getFocusedPath();
      const nextFocusedPath =
        focusedPath === null
          ? null
          : (presented.modelPath(mounted.selectionPath(focusedPath)) ?? null);
      const selectedPaths = model
        .getSelectedPaths()
        .flatMap((path) => presented.modelPath(mounted.selectionPath(path)) ?? [])
        .filter((path) => path.endsWith("/") || modelPaths.includes(path));
      const mountedDirectories = collectDirectoryPaths(mounted.paths);
      if (mountedDirectories.length > 0) {
        collapsedTreeDirectoriesRef.current = new Set(
          mountedDirectories.filter((path) => {
            const directory = model.getItem(path);
            return directory !== null && "isExpanded" in directory && !directory.isExpanded();
          }),
        );
      }
      const collapsedDirectories = directoryPaths.filter((path) =>
        collapsedTreeDirectoriesRef.current.has(path),
      );
      syncingSelectionRef.current = true;
      model.resetPaths(modelPaths);
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
      for (const path of selectedPaths) model.getItem(path)?.select();
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && "collapse" in directory) directory.collapse();
      }
      if (
        nextFocusedPath !== null &&
        (modelPaths.includes(nextFocusedPath) || directoryPaths.includes(nextFocusedPath))
      ) {
        model.focusPath(nextFocusedPath);
      }
    }
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, modelPaths, ordering, positions, presented]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands ancestors, selects and scrolls to the requested file in the Pierre tree model
  useEffect(() => {
    if (selectedPath === null) {
      handledRevealRef.current = null;
      return;
    }
    const modelPath = presented.modelPath(selectedPath);
    const item = modelPath === undefined ? null : model.getItem(modelPath);
    if (modelPath === undefined || item === null || item.isDirectory()) {
      handledRevealRef.current = null;
      return;
    }
    const handled = handledRevealRef.current;
    if (handled?.path === selectedPath && handled.revealRequestId === revealRequestId) {
      return;
    }
    handledRevealRef.current = { path: selectedPath, revealRequestId };
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
  }, [model, presented, revealRequestId, selectedPath]);

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)}>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="min-w-0 truncate px-1 font-medium text-foreground">
          <T>Files</T>
        </span>
        <span className="ml-auto tabular-nums">{entries.length}</span>
        {headerAccessory}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={listView ? gt("View as tree") : gt("View as list")}
                onClick={() => setListView(!listView)}
              />
            }
          >
            {listView ? <ListTreeIcon className="size-3.5" /> : <ListIcon className="size-3.5" />}
          </TooltipTrigger>
          <TooltipPopup>{listView ? gt("View as tree") : gt("View as list")}</TooltipPopup>
        </Tooltip>
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allDirectoriesExpanded ? gt("Collapse all folders") : gt("Expand all folders")
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
              {allDirectoriesExpanded ? gt("Collapse all folders") : gt("Expand all folders")}
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
          // Pierre emits no change for its sole selected row; read before the click to avoid double reveals.
          const selected = model.getSelectedPaths();
          const path = selected.length === 1 ? selected[0] : undefined;
          if (!path || !modelPaths.includes(path)) return;
          const clickedSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
            );
          if (clickedSelectedRow) onSelectFile(presented.selectionPath(path));
        }}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
        // Moving between rows stays inside Pierre's shadow root, where no pointerover reaches here.
        {...(listView
          ? { onPointerMove: titleListRow }
          : { onPointerOver: titleClippedPierreTreeRow })}
      />
      {footer}
    </div>
  );
}
