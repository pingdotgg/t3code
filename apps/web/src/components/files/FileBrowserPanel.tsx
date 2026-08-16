import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  /** Breadcrumb target to reveal in the tree. An empty path reveals the project root. */
  breadcrumbRevealPath: string | null;
  breadcrumbRevealId: number;
  onBreadcrumbRevealHandled: (revealId: number) => void;
  onOpenFile: (relativePath: string) => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function visibleDirectoryTreePath(entries: readonly ProjectEntry[], directoryPath: string): string {
  // Pierre flattens a directory row only while its sole direct child is another directory.
  let currentPath = directoryPath;
  while (true) {
    const prefix = `${currentPath}/`;
    const directChildren = entries.filter((entry) => {
      if (!entry.path.startsWith(prefix)) return false;
      return !entry.path.slice(prefix.length).includes("/");
    });
    if (directChildren.length !== 1 || directChildren[0]?.kind !== "directory") {
      return `${currentPath}/`;
    }
    currentPath = directChildren[0].path;
  }
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RotateCw className={cn(props.isPending && "animate-spin")} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  breadcrumbRevealPath,
  breadcrumbRevealId,
  onBreadcrumbRevealHandled,
  onOpenFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);
  const handledBreadcrumbRevealRef = useRef<{ path: string; revealId: number } | null>(null);
  const suppressedSelectedPathRef = useRef<{ path: string; revealId: number } | null>(null);
  const capturedRootRevealIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (breadcrumbRevealPath !== "") {
      if (breadcrumbRevealPath !== null) suppressedSelectedPathRef.current = null;
      return;
    }
    if (capturedRootRevealIdRef.current === breadcrumbRevealId) return;
    capturedRootRevealIdRef.current = breadcrumbRevealId;
    const handledReveal = handledRevealRef.current;
    if (
      selectedPath &&
      (handledReveal?.path !== selectedPath || handledReveal.revealId !== selectedPathRevealId)
    ) {
      suppressedSelectedPathRef.current = {
        path: selectedPath,
        revealId: selectedPathRevealId,
      };
    }
  }, [breadcrumbRevealId, breadcrumbRevealPath, selectedPath, selectedPathRevealId]);

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const relativePath = item.path.replace(/\/$/, "");
    const mention = serializeComposerFileLink(relativePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    try {
      const clicked = await api.contextMenu.show(
        [
          { id: "copy-mention", label: "Copy mention" },
          { id: "add-to-chat", label: "Add to chat" },
        ],
        position,
      );
      if (clicked === "copy-mention") {
        try {
          await writeTextToClipboard(mention);
          toastManager.add({ type: "success", title: "Mention copied", description: relativePath });
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
        const composer = composerRef?.current;
        if (!composer) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "Open a chat for this project and try again.",
          });
          return;
        }
        const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The chat isn't ready to accept input right now.",
          });
        }
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Rows only need to be draggable so entries can be dropped into the chat
    // composer; rearranging files inside the tree stays off.
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [entryKinds, model, treePaths]);

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      suppressedSelectedPathRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Entry refreshes rebuild treePaths while the same preview stays open.
    // Replaying a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    if (entryKinds.get(selectedPath) !== "file") return;
    const selectedItem = model.getItem(selectedPath);
    if (!selectedItem) return;

    // A selection that originated inside the tree (clicking a row, possibly
    // in an active tree search) is already visible; re-revealing it would
    // close the search and clobber the user's context. Only sync external
    // opens (file picker, content search, chat links).
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }

    if (
      suppressedSelectedPathRef.current?.path === selectedPath &&
      suppressedSelectedPathRef.current.revealId === selectedPathRevealId
    ) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      suppressedSelectedPathRef.current = null;
      syncingSelectionRef.current = true;
      const segments = selectedPath.split("/");
      let ancestorPath = "";
      for (const segment of segments.slice(0, -1)) {
        ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
        const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
        if (item && "expand" in item) item.expand();
      }
      for (const path of model.getSelectedPaths()) {
        model.getItem(path)?.deselect();
      }
      selectedItem.select();
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
      return;
    }
    suppressedSelectedPathRef.current = null;
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory rows are registered with a trailing slash (see treePath), so
    // ancestor lookups must use the same form to expand them.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    selectedItem.select();
    model.scrollToPath(selectedPath, { focus: true, offset: "center" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId, treePaths]);

  useEffect(() => {
    if (breadcrumbRevealPath === null) return;
    const revealRequest = { path: breadcrumbRevealPath, revealId: breadcrumbRevealId };
    const handledReveal = handledBreadcrumbRevealRef.current;
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }

    if (breadcrumbRevealPath === "") {
      let frameId: number | null = null;
      let attemptsRemaining = 120;
      const revealProjectRoot = () => {
        const scrollContainer = model
          .getFileTreeContainer()
          ?.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]");
        if (!scrollContainer) {
          attemptsRemaining -= 1;
          if (attemptsRemaining > 0) frameId = requestAnimationFrame(revealProjectRoot);
          else onBreadcrumbRevealHandled(breadcrumbRevealId);
          return;
        }
        handledBreadcrumbRevealRef.current = revealRequest;
        model.closeSearch();
        scrollContainer.scrollTop = 0;
        onBreadcrumbRevealHandled(breadcrumbRevealId);
      };
      revealProjectRoot();
      return () => {
        if (frameId !== null) cancelAnimationFrame(frameId);
      };
    }

    const entryKind = entryKinds.get(breadcrumbRevealPath);
    if (!entryKind) {
      if (!entriesQuery.isPending) onBreadcrumbRevealHandled(breadcrumbRevealId);
      return;
    }
    const itemPath =
      entryKind === "directory" && breadcrumbRevealPath
        ? `${breadcrumbRevealPath}/`
        : breadcrumbRevealPath;
    const item = itemPath ? (model.getItem(itemPath) ?? model.getItem(breadcrumbRevealPath)) : null;
    if (!item) {
      if (!entriesQuery.isPending) onBreadcrumbRevealHandled(breadcrumbRevealId);
      return;
    }

    const visibleItemPath = itemPath
      ? entryKind === "directory"
        ? visibleDirectoryTreePath(entries, breadcrumbRevealPath)
        : itemPath
      : null;
    if (visibleItemPath && !model.getItem(visibleItemPath)) {
      if (!entriesQuery.isPending) onBreadcrumbRevealHandled(breadcrumbRevealId);
      return;
    }

    handledBreadcrumbRevealRef.current = revealRequest;
    syncingSelectionRef.current = true;
    model.closeSearch();
    if (visibleItemPath) {
      for (const path of model.getSelectedPaths()) {
        model.getItem(path)?.deselect();
      }
    }

    const segments = breadcrumbRevealPath.split("/").filter(Boolean);
    let ancestorPath = "";
    for (const segment of entryKind === "directory" ? segments : segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const ancestor = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (ancestor && "expand" in ancestor) ancestor.expand();
    }

    if (visibleItemPath) {
      model.getItem(visibleItemPath)?.select();
      model.scrollToPath(visibleItemPath, { focus: true, offset: "center" });
    }
    onBreadcrumbRevealHandled(breadcrumbRevealId);
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [
    breadcrumbRevealId,
    breadcrumbRevealPath,
    entries,
    entriesQuery.isPending,
    entryKinds,
    model,
    onBreadcrumbRevealHandled,
  ]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention]);

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={entriesQuery.isPending} onRefresh={entriesQuery.refresh} />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={search.close}
        />
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesQuery.error}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--foreground)",
          }}
        />
      )}
    </div>
  );
}
