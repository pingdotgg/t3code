import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
  GitStatusEntry,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { FolderOpen, SearchIcon } from "lucide-react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { MorphIcon } from "~/components/MorphIcon";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { addFileMentionToChat } from "./addFileToChat";
import { FileSurfaceFailure, FileSurfaceState } from "./fileSurfaceChrome";
import { joinHostPath } from "./filePath";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";
import { loadFileAncestors } from "./loadFileAncestors";
import { useDirectoryEntries } from "./useDirectoryEntries";
import { useProjectPathSearch } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { resolveDiffPathForWorkspace } from "~/diffFileActions";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  /** The repository's root when `cwd` may be a folder inside it; status paths are relative to it. */
  repositoryRoot?: string | undefined;
  projectName: string;
  selectedPath: string | null;
  selectedPathRevealId: number;
  /** False while the tree sits hidden behind a stacked preview. */
  visible?: boolean;
  /**
   * The panel reaches up under its pane's tab row (--surface-top-inset): the search row floats
   * at the row's foot and the tree scrolls under both.
   */
  underPaneHeader?: boolean;
  onOpenFile: (relativePath: string) => void;
  /** Host-folder entries use absolute paths. Avoid full traversal: disable expand-all and search only
   * loaded folders. */
  hostFolder?: boolean;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
}

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} tone="muted" />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onOpenMatch: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup
      variant="default"
      className="h-8 min-w-0 flex-1 in-data-[preview-panel-mode=inline]:h-7"
    >
      <InputGroupAddon>
        <SearchIcon aria-hidden className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        data-workspace-focus-default
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onOpenMatch();
            return;
          }
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

function buildTreeEntries(
  directoryEntries: readonly ProjectEntry[],
  searchEntries: readonly ProjectEntry[],
  searchPending: boolean,
  query: string,
) {
  const result = new Map(directoryEntries.map((entry) => [entry.path, entry]));
  if (query.trim() && !searchPending) {
    for (const entry of searchEntries) {
      if (!result.has(entry.path)) result.set(entry.path, entry);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const path = segments.slice(0, index).join("/");
        if (!result.has(path)) result.set(path, { path, kind: "directory" });
      }
    }
  }
  const entries = [...result.values()];
  const entryKinds: ReadonlyMap<string, ProjectEntry["kind"]> = new Map(
    entries.map((entry) => [entry.path, entry.kind] as const),
  );
  const treePaths = entries.map(treePath);
  const directories = entries.filter((entry) => entry.kind === "directory");
  const directoryPaths = directories.map(treePath);
  // Expanding a folder lists it, and an ignored one such as `node_modules` can hold tens of
  // thousands, so expand all skips ignored folders. They still open by hand.
  const expandableDirectoryPaths = directories.filter((entry) => !entry.ignored).map(treePath);
  return { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths };
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  repositoryRoot,
  projectName,
  selectedPath,
  selectedPathRevealId,
  visible = true,
  underPaneHeader = false,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
  hostFolder = false,
}: FileBrowserPanelProps) {
  const panelPath = (relativePath: string) =>
    hostFolder ? joinHostPath(cwd, relativePath) : relativePath;
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  const {
    entries: directoryEntries,
    load,
    refresh,
    ready,
    error,
    isPending,
    loadingDirectories,
  } = useDirectoryEntries(environmentId, cwd);
  // Shares the status stream the git controls already subscribe to.
  const { data: vcsStatus } = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  const workingTreeFiles = vcsStatus?.workingTree.files;
  const workingTreeRootPath = vcsStatus?.workingTree.rootPath;
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd: hostFolder ? null : cwd, query: query.slice(0, 256) },
    200,
  );
  const { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths } =
    buildTreeEntries(directoryEntries, pathSearch.entries, pathSearch.isPending, query);
  const entryKindsRef = useRef(entryKinds);
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // Shadow-DOM row rects are unreliable; capture the composed contextmenu event's viewport position.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);

  const showEntryContextMenu = useStableCallback(
    (item: TreeContextMenuItem, context: TreeContextMenuOpenContext) => {
      const api = readLocalApi();
      if (!api) {
        context.close();
        return;
      }
      const relativePath = item.path.replace(/\/$/, "");
      const mention = serializeComposerFileLink(panelPath(relativePath));
      const pointer = contextMenuPointerRef.current;
      const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
      const anchorRect = context.anchorElement.getBoundingClientRect();
      const position = pointerIsFresh
        ? { x: pointer.x, y: pointer.y }
        : { x: anchorRect.left, y: anchorRect.bottom };
      const fileTarget = { environmentId, filePath: relativePath, workspaceRoot: cwd };
      const fileMenuItems = fileContextMenu.buildItems(fileTarget);
      // The app menu owns focus; the tree's outside-click handler would dismiss it before click.
      context.close({ restoreFocus: !pointerIsFresh });
      void settlePromise(async () => {
        const clicked = await api.contextMenu.show(
          [
            ...fileMenuItems,
            { id: "copy-mention", label: "Copy mention" },
            { id: "add-to-chat", label: "Add to chat" },
          ],
          position,
        );
        if (clicked === null) return;
        // Open-with submenu ids are absent from the top-level item list.
        const isFileMenuAction =
          fileMenuItems.some((entry) => entry.id === clicked) || clicked.startsWith("editor:");
        if (isFileMenuAction) {
          await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
          return;
        }
        if (clicked === "copy-mention") {
          try {
            await writeTextToClipboard(mention);
            toastManager.add({
              type: "success",
              title: "Mention copied",
              description: relativePath,
            });
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "Failed to copy mention",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          }
          return;
        }
        if (clicked === "add-to-chat") {
          addFileMentionToChat(composerRef, panelPath(relativePath));
        }
      }).then((result) => {
        if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
      });
    },
  );

  const loadingDirectoriesRef = useRef(loadingDirectories);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragMention = createFileTreeDragMentionController(
    hostFolder ? { mentionPath: (path: string) => joinHostPath(cwd, path) } : {},
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          showEntryContextMenu(item, context);
        },
      },
    },
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    itemHeight: 26,
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // Update drag selection even for reveals so subsequent drags cannot use stale paths.
      dragMention.handleSelectionChange(selectedPaths);
      if (syncingSelectionRef.current) return;
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(panelPath(selectedPath));
      }
    },
    paths: [],
    renderRowDecoration: ({ item, row }) =>
      row.kind === "directory" &&
      row.isExpanded &&
      loadingDirectoriesRef.current.has(item.path.replace(/\/$/, ""))
        ? { icon: "t3-tree-icon-loading", title: "Loading…" }
        : null,
    search: false,
    onSearchChange: (value) => setQuery(value ?? ""),
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- makes the Pierre tree model re-render row decorations when loading directories change
  useEffect(() => {
    if (loadingDirectoriesRef.current === loadingDirectories) return;
    loadingDirectoriesRef.current = loadingDirectories;
    model.setComposition(model.getComposition());
  }, [loadingDirectories, model]);
  const search = useFileTreeSearch(model);
  // Pierre restores the unfiltered tree when a search has no matches.
  const hasNoSearchMatches = search.value.trim().length > 0 && search.matchingPaths.length === 0;
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, expandableDirectoryPaths),
  );
  const toggleAllDirectories = () => {
    const expanded = !(expandAll || allDirectoriesExpanded);
    setExpandAll(expanded);
    setAllDirectoriesExpanded(
      model,
      expanded ? expandableDirectoryPaths : directoryPaths,
      expanded,
    );
  };
  const closeSearch = () => {
    setQuery("");
    search.close();
  };
  const expandedPathsRef = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the Pierre tree model to load directories as they are expanded
  useEffect(() => {
    const currentPaths = new Set(directoryPaths);
    for (const path of expandedPathsRef.current) {
      if (!currentPaths.has(path)) expandedPathsRef.current.delete(path);
    }
    const loadExpanded = () => {
      if (model.isSearchOpen()) return;
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (item?.isDirectory() && "isExpanded" in item && item.isExpanded()) {
          if (!expandedPathsRef.current.has(path)) {
            expandedPathsRef.current.add(path);
            void load(path.replace(/\/$/, ""));
          }
        } else {
          if (item?.isDirectory() && expandedPathsRef.current.has(path)) setExpandAll(false);
          expandedPathsRef.current.delete(path);
        }
      }
    };
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [directoryPaths, load, model]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes ignored and working-tree file statuses to the imperative Pierre tree model
  useEffect(() => {
    const statuses: GitStatusEntry[] = entries
      .filter((entry) => entry.ignored)
      .map((entry) => ({ path: treePath(entry), status: "ignored" }));
    for (const file of workingTreeFiles ?? []) {
      if (!file.status) continue;
      // Status paths are the repository's; the tree's are the cwd's.
      const path = workingTreeRootPath
        ? workspaceRelativeFilePath(joinHostPath(workingTreeRootPath, file.path), cwd)
        : resolveDiffPathForWorkspace({
            filePath: file.path,
            workspaceRoot: cwd,
            repositoryRoot,
          });
      if (path !== null) statuses.push({ path, status: file.status });
    }
    model.setGitStatus(statuses);
  }, [cwd, entries, model, repositoryRoot, workingTreeFiles, workingTreeRootPath]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected file's ancestor directories and aborts on cleanup
  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    void loadFileAncestors(selectedPath, load, { signal: controller.signal });
    return () => {
      controller.abort();
    };
  }, [load, selectedPath]);
  const handleSearchValueChange = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  // Enter in the search opens the highlighted hit, else the first matching file.
  const openSearchMatch = () => {
    const filePath = (path: string | null | undefined) => {
      const entryPath = path?.replace(/\/$/, "");
      return entryPath && entryKindsRef.current.get(entryPath) === "file" ? entryPath : null;
    };
    // The revealed file keeps tree focus, so a focused row only counts when it is a hit.
    const matches = model.getSearchMatchingPaths();
    const focusedPath = model.getFocusedPath();
    const path =
      (focusedPath && matches.includes(focusedPath) ? filePath(focusedPath) : null) ??
      matches.map(filePath).find((match) => match !== null);
    if (path) onOpenFile(panelPath(path));
  };
  const handleRefresh = () => {
    refresh();
    if (query.trim()) pathSearch.refresh();
    onRefreshSelectedFile?.();
  };
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: () => {
      refresh();
      if (query.trim()) pathSearch.refresh();
    },
    resourceKey: `files:${environmentId}:${cwd}`,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies tree path changes to the imperative Pierre tree model as a reset or batch update
  useEffect(() => {
    if (!ready) return;
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths);
      return;
    }
    const updates = buildFileTreePathUpdates(previousTreePaths, treePaths);
    if (updates.length > 0) model.batch(updates);
  }, [ready, entryKinds, model, treePaths]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands every directory in the Pierre tree model while expand-all is on and no search is active
  useEffect(() => {
    if (expandAll && !query.trim())
      setAllDirectoriesExpanded(model, expandableDirectoryPaths, true);
  }, [expandableDirectoryPaths, expandAll, model, query]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals an externally selected path in the Pierre tree model by expanding, selecting and scrolling
  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const selectedKind = entryKinds.get(selectedPath);
    if (selectedKind === undefined) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Refresh rebuilds treePaths; replaying handled reveals would close search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    const selectedTreePath = selectedKind === "directory" ? `${selectedPath}/` : selectedPath;
    const selectedItem = model.getItem(selectedTreePath);
    if (!selectedItem) return;

    // Reveal only external selections; tree selections are visible and re-revealing would close search.
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    setQuery("");
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory paths include trailing slashes; ancestor lookups must match.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    if ("expand" in selectedItem) selectedItem.expand();
    selectedItem.select();
    model.scrollToPath(selectedTreePath, {
      focus: true,
      offset: "center",
    });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId]);

  // A reveal while hidden cannot scroll, so showing the tree scrolls the open
  // entry into view.
  const wasVisibleRef = useRef(visible);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scroll the selected tree entry after its hidden viewport becomes visible.
  useEffect(() => {
    const becameVisible = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!becameVisible || !selectedPath) return;
    const path =
      entryKindsRef.current.get(selectedPath) === "directory" ? `${selectedPath}/` : selectedPath;
    if (!model.getItem(path)) return;
    const frame = requestAnimationFrame(() => model.scrollToPath(path, { offset: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [model, selectedPath, visible]);

  // Rows pad clear of the floating search row (PIERRE_TREE_UNSAFE_CSS's --file-tree-top-inset).
  const chromeRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the committed header height and publish its inset to the file tree DOM.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const chrome = chromeRef.current;
    if (!underPaneHeader || !panel || !chrome) return;
    // The border box keeps its fraction; offsetHeight rounds it and leaves a seam.
    const stopObserving = observeResize(chrome, ([entry]) => {
      const height = entry?.borderBoxSize[0]?.blockSize;
      if (height !== undefined) panel.style.setProperty("--file-tree-top-inset", `${height}px`);
    });
    return () => {
      stopObserving();
      panel.style.removeProperty("--file-tree-top-inset");
    };
  }, [underPaneHeader]);

  // A failed or empty root, or a search with no hits, replaces the tree with one
  // centered state; failures below the root keep the tree and show the inline retry.
  const trimmedQuery = query.trim();
  const surfaceState =
    directoryEntries.length === 0 && error && !isPending ? (
      <FileSurfaceFailure title="Can't list files" message={error} onRetry={handleRefresh} />
    ) : ready && directoryEntries.length === 0 && !isPending && !trimmedQuery ? (
      <FileSurfaceState
        icon={<FolderOpen />}
        title="No files yet"
        description={`${projectName} is empty. Files the agent creates show up here.`}
      />
    ) : hasNoSearchMatches &&
      ready &&
      !isPending &&
      !error &&
      !pathSearch.isPending &&
      !pathSearch.error ? (
      <FileSurfaceState
        icon={<SearchIcon />}
        title="No matching files"
        description={`Nothing in ${projectName} matches "${trimmedQuery}".`}
      />
    ) : null;

  return (
    <div
      ref={panelRef}
      className="relative flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      // Capture runs before the tree's shadow-internal row handler opens the menu.
      onContextMenuCapture={(event) => {
        contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
      }}
      // Capture dragstart before the tree selects the row so selection sees the drag flag.
      onDragStartCapture={(event) => dragMention.handleDragStart(event.nativeEvent)}
      onDragEnd={() => dragMention.handleDragEnd((path) => model.getItem(path)?.deselect())}
    >
      <div
        ref={chromeRef}
        className={cn(
          "flex shrink-0 flex-col",
          // Floats over the tree, which scrolls under it and the pane's tab row up to the notch.
          underPaneHeader &&
            "pointer-events-none absolute inset-x-0 top-0 z-10 pt-under-header *:pointer-events-auto [&>:not([data-surface-subheader])]:bg-background",
        )}
      >
        <div
          className="flex shrink-0 items-center gap-2 px-4 py-2.5 in-data-[preview-panel-mode=inline]:px-2 in-data-[preview-panel-mode=inline]:py-0"
          data-surface-subheader
        >
          <FileSearchField
            name="project-files-search"
            ariaLabel={`Search ${projectName} files`}
            value={search.value}
            onValueChange={handleSearchValueChange}
            onClose={closeSearch}
            onOpenMatch={openSearchMatch}
          />
          {directoryPaths.length > 0 && !hostFolder ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={
                      expandAll || allDirectoriesExpanded
                        ? "Collapse all folders"
                        : "Expand all folders"
                    }
                    onClick={toggleAllDirectories}
                  />
                }
              >
                <MorphIcon
                  className="size-3.5"
                  icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
                />
              </TooltipTrigger>
              <TooltipPopup>
                {expandAll || allDirectoriesExpanded
                  ? "Collapse all folders"
                  : "Expand all folders"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <RefreshFilesButton isPending={isPending} onRefresh={handleRefresh} />
        </div>
        {!surfaceState && (error || pathSearch.error) ? (
          <button
            type="button"
            onClick={handleRefresh}
            className="p-4 text-left text-xs leading-relaxed text-error-foreground"
          >
            {error ?? pathSearch.error} Click to retry.
          </button>
        ) : null}
        {query.trim() && pathSearch.truncated && !pathSearch.isPending ? (
          <div className="px-3 py-1 text-xs text-muted-foreground">
            More matches available. Refine your search.
          </div>
        ) : null}
        {(!ready || pathSearch.isPending) && (
          <div
            role="status"
            className={
              entries.length > 0 && !hasNoSearchMatches
                ? "sr-only"
                : "px-3 py-1 text-xs text-muted-foreground"
            }
          >
            Loading files…
          </div>
        )}
      </div>
      {surfaceState && underPaneHeader ? (
        // Centered in the area below the floating search row.
        <div className="flex min-h-0 flex-1 flex-col pt-(--file-tree-top-inset)">
          {surfaceState}
        </div>
      ) : (
        surfaceState
      )}
      {/* Kept mounted behind a state so the tree's expansion survives a search. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          (surfaceState || hasNoSearchMatches) && "hidden",
        )}
      >
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={pierreTreeStyle(resolvedTheme)}
        />
      </div>
    </div>
  );
}
