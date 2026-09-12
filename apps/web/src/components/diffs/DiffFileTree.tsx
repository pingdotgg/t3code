import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { useTheme } from "~/hooks/useTheme";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { setAllDirectoriesExpanded } from "../files/fileTreeExpansion";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import {
  buildDiffFileTreeUpdates,
  collectDirectoryPaths,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

export interface DiffFileTreeHandle {
  setExpanded: (expanded: boolean) => void;
}

interface DiffFileTreeProps {
  readonly ref?: Ref<DiffFileTreeHandle>;
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
  readonly widthStorageKey: string;
  /** Right-aligned content in the header row, after the file count. */
  readonly headerAccessory?: ReactNode;
  /** Rendered under the tree, for a host that still has files to fetch. */
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly defaultWidth?: number;
}

/**
 * A directory tree of the files in a diff. Every directory starts open: a diff is a short list
 * compared to a workspace, and the reader came for the files, not the folders.
 */
export function DiffFileTree({
  ref,
  entries,
  onSelectFile,
  selectedPath = null,
  revealRequestId = 0,
  ariaLabel,
  widthStorageKey,
  headerAccessory,
  footer,
  className,
  defaultWidth = 256,
}: DiffFileTreeProps) {
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [maxWidth, setMaxWidth] = useState(640);
  useLayoutEffect(() => {
    const parent = containerRef.current?.parentElement;
    if (!parent) return;
    const resize = () => setMaxWidth(Math.max(160, Math.min(640, parent.clientWidth * 0.6)));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const { width, handlers } = useResizableWidth({
    storageKey: widthStorageKey,
    defaultWidth,
    minWidth: 160,
    maxWidth,
    edge: "left",
  });
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const directoryPaths = useMemo(() => collectDirectoryPaths(paths), [paths]);
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
    unsafeCSS: `${PIERRE_TREE_UNSAFE_CSS}
      [data-file-tree-virtualized-scroll='true'] {
        overflow-x: hidden;
      }
    `,
  });
  useImperativeHandle(
    ref,
    () => ({
      setExpanded: (expanded: boolean) =>
        setAllDirectoriesExpanded(model, directoryPaths, expanded),
    }),
    [model, directoryPaths],
  );

  useEffect(() => {
    const mountedPaths = mountedPathsRef.current;
    if (mountedPaths === paths) return;
    mountedPathsRef.current = paths;
    if (mountedPaths === null) {
      model.resetPaths(paths);
    } else {
      const updates = buildDiffFileTreeUpdates(mountedPaths, paths);
      if (updates.length > 0) model.batch(updates);
    }
    model.setGitStatus(gitStatus);
  }, [gitStatus, model, paths]);

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
    <div
      ref={containerRef}
      className={cn(
        "relative flex min-h-0 min-w-40 max-w-[60%] shrink-0 flex-col border-l border-border/60 bg-background pb-3",
        className,
      )}
      style={{ width }}
    >
      <RightPanelResizeHandle handlers={handlers} />
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">Files</span>
        <span className="ml-auto tabular-nums">{entries.length}</span>
        {headerAccessory}
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
      />
      {footer}
    </div>
  );
}
