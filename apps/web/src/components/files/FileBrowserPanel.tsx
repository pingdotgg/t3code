import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { toastManager } from "~/components/ui/toast";
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
  selectedPath: string | null;
  selectedPathRevealId: number;
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

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
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
      if (syncingSelectionRef.current) return;
      dragMention.handleSelectionChange(selectedPaths);
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [entryKinds, model, treePaths]);

  useEffect(() => {
    if (!selectedPath || entryKinds.get(selectedPath) !== "file") return;

    syncingSelectionRef.current = true;
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    model.getItem(selectedPath)?.select();
    model.scrollToPath(selectedPath, { focus: true, offset: "center" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId, treePaths]);

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

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
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{projectName}</div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">
            {entriesQuery.isPending && entriesQuery.data === null
              ? "Indexing…"
              : `${fileCount.toLocaleString()} files`}
            {entriesQuery.data?.truncated ? " · partial" : ""}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Search workspace files"
          onClick={() => model.openSearch()}
        >
          <Search className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh workspace files"
          onClick={entriesQuery.refresh}
        >
          <RefreshCw className={cn("size-3.5", entriesQuery.isPending && "animate-spin")} />
        </button>
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
