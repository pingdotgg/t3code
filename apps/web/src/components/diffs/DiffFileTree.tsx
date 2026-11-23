import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
  GitStatusEntry,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { T, useGT } from "gt-react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
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
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreeModel,
  diffFileTreeRow,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";
import { diffFileTreePositions } from "@t3tools/client-runtime/diff-file-order";

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  readonly onSelectFile: (path: string) => void;
  /** Host folder the diff paths belong to; copied paths use its separators. */
  readonly workspaceRoot: string | undefined;
  readonly selectedPath?: string | null;
  readonly revealRequestId?: number;
  readonly ariaLabel: string;
  readonly headerAccessory?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}

export function DiffFileTree({
  entries,
  onSelectFile,
  workspaceRoot,
  selectedPath = null,
  revealRequestId = 0,
  ariaLabel,
  headerAccessory,
  footer,
  className,
}: DiffFileTreeProps) {
  const gt = useGT();
  const { resolvedTheme } = useTheme();
  const paths = entries.map((entry) => entry.path);
  const presented = diffFileTreeModel(paths);
  const modelPaths = presented.paths;
  const icons = presented.icons;
  const directoryPaths = collectDirectoryPaths(modelPaths);
  const positions = diffFileTreePositions(modelPaths);
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
    path: presented.modelPath(entry.path),
    status: entry.status,
  }));
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{
    path: string;
    revealRequestId: number;
  } | null>(null);
  const mountedPresentationRef = useRef<ReturnType<typeof diffFileTreeModel> | null>(null);

  // The tree model keeps the first selection handler it was given.
  const handleSelectionChange = useStableCallback((selectedPaths: ReadonlyArray<string>) => {
    if (syncingSelectionRef.current) return;
    const modelPath = selectedPaths.at(-1);
    if (modelPath && modelPaths.includes(modelPath)) {
      onSelectFile(presented.selectionPath(modelPath));
    }
  });

  // Shadow-DOM row rects are unreliable; capture the composed contextmenu event's viewport position.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const showRowContextMenu = useStableCallback(
    (item: TreeContextMenuItem, context: TreeContextMenuOpenContext) => {
      const api = readLocalApi();
      if (!api) {
        context.close();
        return;
      }
      const row = diffFileTreeRow(item.path, presented.selectionPath);
      const pointer = contextMenuPointerRef.current;
      const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
      const anchorRect = context.anchorElement.getBoundingClientRect();
      const position = pointerIsFresh
        ? { x: pointer.x, y: pointer.y }
        : { x: anchorRect.left, y: anchorRect.bottom };
      // The app menu owns focus; the tree's outside-click handler would dismiss it before click.
      context.close({ restoreFocus: !pointerIsFresh });
      void settlePromise(async () => {
        const clicked = await api.contextMenu.show(
          [
            { id: "copy-name", label: gt("Copy name") },
            { id: "copy-path", label: gt("Copy path") },
          ],
          position,
        );
        if (clicked === null) return;
        try {
          await writeTextToClipboard(
            clicked === "copy-name"
              ? row.name
              : formatFilePathForClipboard(row.path, workspaceRoot),
          );
        } catch (error) {
          toastManager.add({
            type: "error",
            title: clicked === "copy-name" ? gt("Failed to copy name") : gt("Failed to copy path"),
            description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
          });
        }
      }).then((result) => {
        if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
      });
    },
  );

  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => showRowContextMenu(item, context),
      },
    },
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons,
    onSelectionChange: handleSelectionChange,
    paths: [],
    search: false,
    sort: ordering.sort,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
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
    } else if (mounted.paths.every((path, index) => modelPaths[index] === path)) {
      const updates = buildDiffFileTreeUpdates(mounted.paths, modelPaths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A reset can turn a file path into a directory. Carry selection and focus
      // through real paths so paging keeps the same file without revealing it again.
      const focusedPath = model.getFocusedPath();
      const nextFocusedPath =
        focusedPath === null ? null : presented.modelPath(mounted.selectionPath(focusedPath));
      const selectedPaths = model
        .getSelectedPaths()
        .map((path) => presented.modelPath(mounted.selectionPath(path)))
        .filter((path) => path.endsWith("/") || modelPaths.includes(path));
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && "isExpanded" in directory && !directory.isExpanded();
      });
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
    const item = model.getItem(modelPath);
    if (item === null || item.isDirectory()) {
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
    <div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">
          <T>Files</T>
        </span>
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
        // Capture runs before the tree's shadow-internal row handler opens the menu.
        onContextMenuCapture={(event) => {
          contextMenuPointerRef.current = {
            x: event.clientX,
            y: event.clientY,
            at: event.timeStamp,
          };
        }}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
        onPointerOver={titleClippedPierreTreeRow}
      />
      {footer}
    </div>
  );
}
