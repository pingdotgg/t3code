import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContextMenuItem, EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FolderTreeIcon,
  LoaderIcon,
  PanelRightCloseIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type UIEvent as ReactUIEvent,
} from "react";

import { useLongPressContextMenu } from "../hooks/useLongPressContextMenu";
import { useTheme } from "../hooks/useTheme";
import { ensureEnvironmentApi } from "../environmentApi";
import {
  projectListDirectoryEntriesQueryOptions,
  projectQueryKeys,
  projectSearchEntriesQueryOptions,
} from "../lib/projectReactQuery";
import { refreshGitStatus, useGitStatus } from "../lib/gitStatusState";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import {
  buildWorkspaceChangeDecorations,
  parentPathsOf,
  workspaceStatusBadge,
  type WorkspaceChangedFile,
  type WorkspaceEntryChangeDecoration,
} from "../workspace-file-status";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";

const EXPLORER_ROW_HEIGHT_CLASS_NAME = "h-7";
const EXPLORER_DIRECTORY_ENTRY_LIMIT = 500;
const EXPLORER_SEARCH_ENTRY_LIMIT = 120;
const EMPTY_CHANGED_FILES: ReadonlyArray<WorkspaceChangedFile> = [];

type WorkspaceExplorerEntryContextMenuAction = "add-to-input" | "delete-entry";

function workspaceExplorerEntryContextMenuItems(input: {
  canAddToInput: boolean;
  canDelete: boolean;
  entryKind: ProjectEntry["kind"];
}): ContextMenuItem<WorkspaceExplorerEntryContextMenuAction>[] {
  const items: ContextMenuItem<WorkspaceExplorerEntryContextMenuAction>[] = [];
  if (input.canAddToInput) {
    items.push({ id: "add-to-input", label: "Add to chat input" });
  }
  if (input.canDelete) {
    items.push({
      id: "delete-entry",
      label: input.entryKind === "directory" ? "Delete empty folder" : "Delete file",
      destructive: true,
    });
  }
  return items;
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function entryDepth(entry: ProjectEntry): number {
  return entry.path.split("/").length - 1;
}

function WorkspaceExplorerMessage(props: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-[15px] md:text-xs",
        props.tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {props.tone === "error" ? <TriangleAlertIcon className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0">{props.children}</span>
    </div>
  );
}

const WorkspaceExplorerLoadingRows = memo(function WorkspaceExplorerLoadingRows(props: {
  depth: number;
}) {
  return (
    <div className="py-1">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className={cn(
            EXPLORER_ROW_HEIGHT_CLASS_NAME,
            "flex items-center gap-2 px-2 text-muted-foreground/50",
          )}
          style={{ paddingLeft: 10 + props.depth * 14 }}
        >
          <LoaderIcon className="size-3 animate-spin" />
          <div className="h-2.5 w-24 rounded-full bg-muted/60" />
        </div>
      ))}
    </div>
  );
});

const WorkspaceExplorerEntryRow = memo(function WorkspaceExplorerEntryRow(props: {
  changeDecoration?: WorkspaceEntryChangeDecoration | undefined;
  entry: ProjectEntry;
  expanded: boolean;
  mode: "tree" | "search";
  onAddFileToInput?: ((entry: ProjectEntry) => void) | undefined;
  onCanDeleteEntry?: ((entry: ProjectEntry) => boolean | Promise<boolean>) | undefined;
  onDeleteEntry?: ((entry: ProjectEntry) => void | Promise<void>) | undefined;
  onOpenFile: (entry: ProjectEntry) => void;
  onRevealDirectory: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  resolvedTheme: "light" | "dark";
}) {
  const {
    changeDecoration,
    entry,
    expanded,
    mode,
    onAddFileToInput,
    onCanDeleteEntry,
    onDeleteEntry,
    onOpenFile,
    onRevealDirectory,
    onToggleDirectory,
    resolvedTheme,
  } = props;
  const depth = mode === "tree" ? entryDepth(entry) : 0;
  const isDirectory = entry.kind === "directory";
  const isIgnored = entry.ignored === true;
  const label = basenameOfPath(entry.path);
  const title = mode === "tree" ? label : entry.path;
  const statusBadge = changeDecoration ? workspaceStatusBadge(changeDecoration.status) : null;
  const statusChangedFileNoun = (changeDecoration?.descendantCount ?? 0) === 1 ? "file" : "files";
  const statusBadgeLabel =
    statusBadge && changeDecoration?.source === "directory"
      ? `${entry.path} contains ${changeDecoration.descendantCount} changed ${statusChangedFileNoun}; highest status ${statusBadge.label}`
      : statusBadge
        ? `${entry.path} is ${statusBadge.label}`
        : undefined;
  const statusBadgeTitle =
    statusBadge && changeDecoration?.source === "directory"
      ? `Contains ${changeDecoration.descendantCount} changed ${statusChangedFileNoun}; highest status ${statusBadge.label}`
      : statusBadge?.label;
  const canAddToInput = !isDirectory && onAddFileToInput !== undefined;
  const canAttemptDelete = onDeleteEntry !== undefined;
  const contextMenuEnabled = canAddToInput || canAttemptDelete;

  const onClick = useCallback(() => {
    if (isDirectory) {
      if (mode === "search") {
        onRevealDirectory(entry.path);
        return;
      }
      onToggleDirectory(entry.path);
      return;
    }
    onOpenFile(entry);
  }, [entry, isDirectory, mode, onOpenFile, onRevealDirectory, onToggleDirectory]);
  const openFileContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      if (!contextMenuEnabled) {
        return;
      }
      const api = readLocalApi();
      if (!api) {
        return;
      }
      const canDelete = canAttemptDelete ? (await onCanDeleteEntry?.(entry)) !== false : false;
      const contextMenuItems = workspaceExplorerEntryContextMenuItems({
        canAddToInput,
        canDelete,
        entryKind: entry.kind,
      });
      if (contextMenuItems.length === 0) {
        return;
      }
      const clicked = await api.contextMenu.show(contextMenuItems, position);
      if (clicked === "add-to-input" && canAddToInput) {
        onAddFileToInput?.(entry);
        return;
      }
      if (clicked === "delete-entry" && canDelete) {
        const actionLabel = isDirectory ? "Delete empty folder" : "Delete file";
        const confirmed = await api.dialogs.confirm(
          `${actionLabel} "${entry.path}"?\n\nThis cannot be undone.`,
        );
        if (confirmed) {
          await onDeleteEntry?.(entry);
        }
      }
    },
    [
      canAddToInput,
      canAttemptDelete,
      contextMenuEnabled,
      entry,
      isDirectory,
      onCanDeleteEntry,
      onAddFileToInput,
      onDeleteEntry,
    ],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!contextMenuEnabled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void openFileContextMenu({ x: event.clientX, y: event.clientY });
    },
    [contextMenuEnabled, openFileContextMenu],
  );
  const {
    onClickCapture: handleLongPressClickCapture,
    onContextMenuCapture: handleLongPressContextMenuCapture,
    onPointerCancelCapture: handleLongPressPointerCancelCapture,
    onPointerDownCapture: handleLongPressPointerDownCapture,
    onPointerMoveCapture: handleLongPressPointerMoveCapture,
    onPointerUpCapture: handleLongPressPointerUpCapture,
  } = useLongPressContextMenu<HTMLButtonElement>({
    enabled: contextMenuEnabled,
    onLongPress: openFileContextMenu,
  });

  return (
    <div
      className={cn(
        EXPLORER_ROW_HEIGHT_CLASS_NAME,
        "group flex w-full min-w-0 select-none items-center pr-2 text-[15px] transition-colors [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] [-webkit-user-select:none] hover:bg-accent/70 focus-within:bg-accent focus-within:ring-2 focus-within:ring-ring md:text-[13px]",
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 select-none items-center gap-1.5 text-left outline-none [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] [-webkit-user-select:none]"
        title={entry.path}
        onClick={onClick}
        onClickCapture={handleLongPressClickCapture}
        onContextMenu={handleContextMenu}
        onContextMenuCapture={handleLongPressContextMenuCapture}
        onPointerCancelCapture={handleLongPressPointerCancelCapture}
        onPointerDownCapture={handleLongPressPointerDownCapture}
        onPointerMoveCapture={handleLongPressPointerMoveCapture}
        onPointerUpCapture={handleLongPressPointerUpCapture}
      >
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            isIgnored ? "text-muted-foreground/45" : "text-muted-foreground/65",
          )}
        >
          {isDirectory ? (
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform",
                expanded && mode === "tree" && "rotate-90",
              )}
            />
          ) : null}
        </span>
        <VscodeEntryIcon
          pathValue={entry.path}
          kind={entry.kind}
          theme={resolvedTheme}
          className={cn("size-4 shrink-0", isIgnored && "opacity-45 grayscale")}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            isIgnored
              ? "text-muted-foreground/55"
              : statusBadge
                ? statusBadge.className
                : "text-foreground/88",
          )}
        >
          {title}
        </span>
      </button>
      {statusBadge ? (
        <span
          aria-label={statusBadgeLabel}
          title={statusBadgeTitle}
          className={cn(
            "ml-1 flex w-4 shrink-0 justify-center font-mono text-[10px] font-semibold",
            statusBadge.className,
          )}
        >
          {statusBadge.letter}
        </span>
      ) : null}
    </div>
  );
});

function WorkspaceDirectoryEntries(props: {
  changeDecorationsByPath: ReadonlyMap<string, WorkspaceEntryChangeDecoration>;
  cwd: string;
  depth: number;
  directoryPath?: string;
  environmentId: EnvironmentId;
  expandedDirectoryPaths: ReadonlySet<string>;
  onAddFileToInput?: ((entry: ProjectEntry) => void) | undefined;
  onCanDeleteEntry?: ((entry: ProjectEntry) => boolean | Promise<boolean>) | undefined;
  onDeleteEntry?: ((entry: ProjectEntry) => void | Promise<void>) | undefined;
  onOpenFile: (entry: ProjectEntry) => void;
  onRevealDirectory: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  resolvedTheme: "light" | "dark";
}) {
  const query = useQuery(
    projectListDirectoryEntriesQueryOptions({
      environmentId: props.environmentId,
      cwd: props.cwd,
      directoryPath: props.directoryPath ?? null,
      limit: EXPLORER_DIRECTORY_ENTRY_LIMIT,
    }),
  );
  const entries = query.data?.entries ?? [];
  const isLoadingEmpty = query.isPending || (query.isFetching && entries.length === 0);

  if (isLoadingEmpty) {
    return <WorkspaceExplorerLoadingRows depth={props.depth} />;
  }

  if (query.error) {
    return (
      <WorkspaceExplorerMessage tone="error">
        {query.error instanceof Error ? query.error.message : "Failed to load directory."}
      </WorkspaceExplorerMessage>
    );
  }

  if (entries.length === 0) {
    return props.depth === 0 ? (
      <WorkspaceExplorerMessage>No files found.</WorkspaceExplorerMessage>
    ) : null;
  }

  return (
    <>
      {entries.map((entry) => {
        const expanded = entry.kind === "directory" && props.expandedDirectoryPaths.has(entry.path);
        return (
          <div key={entry.path}>
            <WorkspaceExplorerEntryRow
              changeDecoration={props.changeDecorationsByPath.get(entry.path)}
              entry={entry}
              expanded={expanded}
              mode="tree"
              onAddFileToInput={props.onAddFileToInput}
              onCanDeleteEntry={props.onCanDeleteEntry}
              onDeleteEntry={props.onDeleteEntry}
              onOpenFile={props.onOpenFile}
              onRevealDirectory={props.onRevealDirectory}
              onToggleDirectory={props.onToggleDirectory}
              resolvedTheme={props.resolvedTheme}
            />
            {expanded ? (
              <WorkspaceDirectoryEntries
                cwd={props.cwd}
                changeDecorationsByPath={props.changeDecorationsByPath}
                depth={props.depth + 1}
                directoryPath={entry.path}
                environmentId={props.environmentId}
                expandedDirectoryPaths={props.expandedDirectoryPaths}
                onAddFileToInput={props.onAddFileToInput}
                onCanDeleteEntry={props.onCanDeleteEntry}
                onDeleteEntry={props.onDeleteEntry}
                onOpenFile={props.onOpenFile}
                onRevealDirectory={props.onRevealDirectory}
                onToggleDirectory={props.onToggleDirectory}
                resolvedTheme={props.resolvedTheme}
              />
            ) : null}
          </div>
        );
      })}
      {query.data?.truncated ? (
        <WorkspaceExplorerMessage>Directory listing truncated.</WorkspaceExplorerMessage>
      ) : null}
    </>
  );
}

function WorkspaceSearchEntries(props: {
  changeDecorationsByPath: ReadonlyMap<string, WorkspaceEntryChangeDecoration>;
  cwd: string;
  environmentId: EnvironmentId;
  onAddFileToInput?: ((entry: ProjectEntry) => void) | undefined;
  onCanDeleteEntry?: ((entry: ProjectEntry) => boolean | Promise<boolean>) | undefined;
  onDeleteEntry?: ((entry: ProjectEntry) => void | Promise<void>) | undefined;
  onOpenFile: (entry: ProjectEntry) => void;
  onRevealDirectory: (path: string) => void;
  query: string;
  resolvedTheme: "light" | "dark";
}) {
  const searchQuery = useQuery(
    projectSearchEntriesQueryOptions({
      environmentId: props.environmentId,
      cwd: props.cwd,
      query: props.query,
      limit: EXPLORER_SEARCH_ENTRY_LIMIT,
      enabled: props.query.length > 0,
    }),
  );
  const entries = searchQuery.data?.entries ?? [];
  const isLoadingEmpty = searchQuery.isPending || (searchQuery.isFetching && entries.length === 0);

  if (isLoadingEmpty) {
    return <WorkspaceExplorerLoadingRows depth={0} />;
  }

  if (searchQuery.error) {
    return (
      <WorkspaceExplorerMessage tone="error">
        {searchQuery.error instanceof Error ? searchQuery.error.message : "Search failed."}
      </WorkspaceExplorerMessage>
    );
  }

  if (entries.length === 0) {
    return <WorkspaceExplorerMessage>No matching files.</WorkspaceExplorerMessage>;
  }

  return (
    <>
      {entries.map((entry) => (
        <WorkspaceExplorerEntryRow
          key={`${entry.kind}:${entry.path}`}
          changeDecoration={props.changeDecorationsByPath.get(entry.path)}
          entry={entry}
          expanded={false}
          mode="search"
          onAddFileToInput={props.onAddFileToInput}
          onCanDeleteEntry={props.onCanDeleteEntry}
          onDeleteEntry={props.onDeleteEntry}
          onOpenFile={props.onOpenFile}
          onRevealDirectory={props.onRevealDirectory}
          onToggleDirectory={props.onRevealDirectory}
          resolvedTheme={props.resolvedTheme}
        />
      ))}
      {searchQuery.data?.truncated ? (
        <WorkspaceExplorerMessage>Search results truncated.</WorkspaceExplorerMessage>
      ) : null}
    </>
  );
}

export function WorkspaceFileExplorerPanel(props: {
  backButtonLabel?: string | undefined;
  expandedDirectoryPaths: ReadonlySet<string>;
  environmentId: EnvironmentId;
  mode: DiffPanelMode;
  onAddFileToInput?: ((entry: ProjectEntry) => void) | undefined;
  onBack?: (() => void) | undefined;
  onClose: () => void;
  onExpandedDirectoryPathsChange: (paths: Set<string>) => void;
  onOpenFile: (entry: ProjectEntry) => void;
  onSearchQueryChange: (query: string) => void;
  onScrollTopChange: (scrollTop: number) => void;
  projectName?: string | undefined;
  scrollRestorationKey: string;
  scrollTop: number;
  searchQuery: string;
  workspaceRoot: string;
}) {
  const {
    backButtonLabel,
    expandedDirectoryPaths,
    environmentId,
    mode,
    onAddFileToInput,
    onBack,
    onClose,
    onExpandedDirectoryPathsChange,
    onOpenFile,
    onSearchQueryChange,
    onScrollTopChange,
    projectName,
    scrollRestorationKey,
    scrollTop,
    searchQuery,
    workspaceRoot,
  } = props;
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const trimmedSearchQuery = searchQuery.trim();
  const workspaceLabel = projectName ?? basenameOfPath(workspaceRoot);
  const gitStatus = useGitStatus({ environmentId, cwd: workspaceRoot });
  const workingTreeFiles = gitStatus.data?.workingTree.files ?? EMPTY_CHANGED_FILES;
  const changeDecorationsByPath = useMemo(
    () => buildWorkspaceChangeDecorations(workingTreeFiles),
    [workingTreeFiles],
  );

  const onToggleDirectory = useCallback(
    (path: string) => {
      const next = new Set(expandedDirectoryPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      onExpandedDirectoryPathsChange(next);
    },
    [expandedDirectoryPaths, onExpandedDirectoryPathsChange],
  );

  const onRevealDirectory = useCallback(
    (path: string) => {
      const next = new Set(expandedDirectoryPaths);
      for (const parentPath of parentPathsOf(path)) {
        next.add(parentPath);
      }
      next.add(path);
      onExpandedDirectoryPathsChange(next);
      onSearchQueryChange("");
    },
    [expandedDirectoryPaths, onExpandedDirectoryPathsChange, onSearchQueryChange],
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
    void refreshGitStatus({ environmentId, cwd: workspaceRoot });
  }, [environmentId, queryClient, workspaceRoot]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useLayoutEffect(() => {
    const element = scrollContainerRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = scrollTop;
    const frameId = window.requestAnimationFrame(() => {
      element.scrollTop = scrollTop;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [scrollRestorationKey, scrollTop]);

  const handleExplorerScroll = useCallback(
    (event: ReactUIEvent<HTMLDivElement>) => {
      onScrollTopChange(event.currentTarget.scrollTop);
    },
    [onScrollTopChange],
  );

  const canDeleteWorkspaceEntry = useCallback(
    async (entry: ProjectEntry) => {
      if (entry.kind !== "directory") {
        return true;
      }

      try {
        const api = ensureEnvironmentApi(environmentId);
        const listing = await api.projects.listDirectoryEntries({
          cwd: workspaceRoot,
          directoryPath: entry.path,
          limit: 1,
        });
        return listing.entries.length === 0;
      } catch {
        return false;
      }
    },
    [environmentId, workspaceRoot],
  );

  const deleteWorkspaceEntry = useCallback(
    async (entry: ProjectEntry) => {
      try {
        const api = ensureEnvironmentApi(environmentId);
        await api.projects.deleteEntry({
          cwd: workspaceRoot,
          relativePath: entry.path,
        });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
        void refreshGitStatus({ environmentId, cwd: workspaceRoot }, { force: true });
        const entryTypeLabel = entry.kind === "directory" ? "folder" : "file";
        toastManager.add({
          type: "success",
          title: `Deleted ${entryTypeLabel}`,
          description: entry.path,
        });
      } catch (error) {
        const entryTypeLabel = entry.kind === "directory" ? "folder" : "file";
        toastManager.add({
          type: "error",
          title: `Failed to delete ${entryTypeLabel}`,
          description: error instanceof Error ? error.message : `Failed to delete ${entry.path}.`,
        });
      }
    },
    [environmentId, queryClient, workspaceRoot],
  );

  const header = useMemo(
    () => (
      <>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {onBack ? (
            <Button
              size="icon-xs"
              variant="outline"
              aria-label={backButtonLabel ?? "Back"}
              title={backButtonLabel ?? "Back"}
              onClick={onBack}
            >
              <ArrowLeftIcon className="size-3.5" />
            </Button>
          ) : null}
          <FolderTreeIcon className="size-4 shrink-0 text-muted-foreground/80" />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-medium text-foreground md:text-sm">Files</p>
            <p className="truncate font-mono text-[15px] text-muted-foreground/70 md:text-[11px]">
              {workspaceLabel}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="Refresh file explorer"
            title="Refresh file explorer"
            onClick={refresh}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="Close file explorer"
            title="Close file explorer"
            onClick={onClose}
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </>
    ),
    [backButtonLabel, onBack, onClose, refresh, workspaceLabel],
  );

  return (
    <DiffPanelShell mode={mode} header={header}>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <div className="border-b border-border/60 p-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground/65" />
            <Input
              aria-label="Search workspace files"
              className="rounded-md text-[15px] md:text-sm [&_input]:pl-8"
              nativeInput
              placeholder="Search files"
              size="sm"
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            />
          </div>
        </div>
        <div
          ref={scrollContainerRef}
          data-testid="workspace-file-explorer-scroll"
          className="min-h-0 flex-1 select-none overflow-auto py-1 [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] [touch-action:pan-y]"
          onScroll={handleExplorerScroll}
        >
          {trimmedSearchQuery ? (
            <WorkspaceSearchEntries
              changeDecorationsByPath={changeDecorationsByPath}
              cwd={workspaceRoot}
              environmentId={environmentId}
              onAddFileToInput={onAddFileToInput}
              onCanDeleteEntry={canDeleteWorkspaceEntry}
              onDeleteEntry={deleteWorkspaceEntry}
              onOpenFile={onOpenFile}
              onRevealDirectory={onRevealDirectory}
              query={trimmedSearchQuery}
              resolvedTheme={resolvedTheme}
            />
          ) : (
            <WorkspaceDirectoryEntries
              changeDecorationsByPath={changeDecorationsByPath}
              cwd={workspaceRoot}
              depth={0}
              environmentId={environmentId}
              expandedDirectoryPaths={expandedDirectoryPaths}
              onAddFileToInput={onAddFileToInput}
              onCanDeleteEntry={canDeleteWorkspaceEntry}
              onDeleteEntry={deleteWorkspaceEntry}
              onOpenFile={onOpenFile}
              onRevealDirectory={onRevealDirectory}
              onToggleDirectory={onToggleDirectory}
              resolvedTheme={resolvedTheme}
            />
          )}
        </div>
      </div>
    </DiffPanelShell>
  );
}
