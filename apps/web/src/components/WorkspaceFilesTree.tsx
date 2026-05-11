import { type EnvironmentId, type ProjectEntry } from "@forma/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  IconCheckmark as CheckIcon,
  IconChevronRight as ChevronRightIcon,
  IconDocument as DocumentIcon,
  IconFolder as FolderIcon,
  IconFolderFill as FolderClosedIcon,
  IconProgressIndicator as LoaderIcon,
  IconXmark as XIcon,
} from "symbols-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { ContextMenuItem } from "@forma/contracts";
import { replaceExpandedDirectoryPrefix } from "../lib/projectExplorerEntries";
import { prefetchProjectFileForEditor } from "../lib/projectFileReadCache";
import { projectListEntriesQueryOptions } from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import { scheduleWorkspaceDirectoryPrefetch } from "../lib/workspaceFilePrefetch";
import { readLocalApi } from "../localApi";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";

const expandedDirectoryPathsBySessionKey = new Map<string, readonly string[]>();

type EditableProjectEntryKind = Extract<ProjectEntry["kind"], "file" | "directory">;

type PendingInlineEdit =
  | {
      mode: "create";
      kind: EditableProjectEntryKind;
      parentPath: string | null;
      draft: string;
      submitting: boolean;
    }
  | {
      mode: "rename";
      entry: ProjectEntry;
      parentPath: string | null;
      draft: string;
      submitting: boolean;
    };

interface WorkspaceCreateResult {
  path: string;
  kind: EditableProjectEntryKind;
}

interface WorkspaceRenameResult {
  fromPath: string;
  toPath: string;
  kind: EditableProjectEntryKind;
}

interface WorkspaceFilesTreeProps {
  environmentId: EnvironmentId;
  cwd: string;
  sessionKey: string;
  resolvedTheme: "light" | "dark";
  selectedFilePath: string | null;
  requestedRootCreate?: { nonce: number; kind: EditableProjectEntryKind } | null;
  requestedCollapseAllNonce?: number;
  onSelectFile: (filePath: string) => void;
  onAddFileToChatContext?: (filePath: string) => void | Promise<void>;
  onCreateEntry: (input: {
    kind: EditableProjectEntryKind;
    relativePath: string;
  }) => Promise<WorkspaceCreateResult>;
  onRenameEntry: (input: {
    entry: ProjectEntry;
    nextRelativePath: string;
  }) => Promise<WorkspaceRenameResult>;
  onDeleteEntry: (entry: ProjectEntry) => Promise<void>;
  onCopyRelativePath: (entry: ProjectEntry) => void;
  onCopyAbsolutePath: (entry: ProjectEntry) => void;
  onOpenInExternalEditor: (entry: ProjectEntry) => void;
  onRefresh: () => void;
}

function readExpandedDirectoryPaths(sessionKey: string): ReadonlySet<string> {
  return new Set(expandedDirectoryPathsBySessionKey.get(sessionKey) ?? []);
}

function writeExpandedDirectoryPaths(sessionKey: string, paths: ReadonlySet<string>): void {
  if (paths.size === 0) {
    expandedDirectoryPathsBySessionKey.delete(sessionKey);
    return;
  }

  expandedDirectoryPathsBySessionKey.set(
    sessionKey,
    [...paths].toSorted((left, right) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
    ),
  );
}

function basename(pathValue: string): string {
  const normalizedPath = pathValue.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  return segments.at(-1) ?? pathValue;
}

function parentPathOf(pathValue: string): string | null {
  const normalizedPath = pathValue.replaceAll("\\", "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  return separatorIndex === -1 ? null : normalizedPath.slice(0, separatorIndex);
}

function normalizeInlineEntryPath(input: {
  draft: string;
  parentPath: string | null;
}): string | null {
  const normalizedDraft = input.draft.trim().replaceAll("\\", "/");
  if (
    normalizedDraft.length === 0 ||
    normalizedDraft.startsWith("/") ||
    normalizedDraft
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }

  return input.parentPath ? `${input.parentPath}/${normalizedDraft}` : normalizedDraft;
}

export function __resetWorkspaceFilesTreeSessionStateForTests(): void {
  expandedDirectoryPathsBySessionKey.clear();
}

export const WorkspaceFilesTree = memo(function WorkspaceFilesTree(props: WorkspaceFilesTreeProps) {
  const [expandedDirectoryPaths, setExpandedDirectoryPaths] = useState(() =>
    readExpandedDirectoryPaths(props.sessionKey),
  );
  const [activeDirectoryPath, setActiveDirectoryPath] = useState<string | null>(null);
  const [pendingInlineEdit, setPendingInlineEdit] = useState<PendingInlineEdit | null>(null);
  const lastHandledRootCreateNonceRef = useRef<number | undefined>(undefined);
  const lastHandledCollapseAllNonceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setExpandedDirectoryPaths(readExpandedDirectoryPaths(props.sessionKey));
    setActiveDirectoryPath(null);
    setPendingInlineEdit(null);
  }, [props.sessionKey]);

  useEffect(() => {
    if (
      props.requestedRootCreate?.nonce === undefined ||
      props.requestedRootCreate.nonce === lastHandledRootCreateNonceRef.current
    ) {
      return;
    }
    lastHandledRootCreateNonceRef.current = props.requestedRootCreate.nonce;
    setPendingInlineEdit({
      mode: "create",
      kind: props.requestedRootCreate.kind,
      parentPath: activeDirectoryPath,
      draft: "",
      submitting: false,
    });
  }, [activeDirectoryPath, props.requestedRootCreate]);

  useEffect(() => {
    if (
      props.requestedCollapseAllNonce === undefined ||
      props.requestedCollapseAllNonce === lastHandledCollapseAllNonceRef.current
    ) {
      return;
    }
    lastHandledCollapseAllNonceRef.current = props.requestedCollapseAllNonce;
    setExpandedDirectoryPaths(() => {
      const nextPaths = new Set<string>();
      writeExpandedDirectoryPaths(props.sessionKey, nextPaths);
      return nextPaths;
    });
  }, [props.requestedCollapseAllNonce, props.sessionKey]);

  const setDirectoryExpanded = useCallback(
    (path: string, expanded: boolean) => {
      setExpandedDirectoryPaths((current) => {
        const nextExpandedPaths = new Set(current);
        if (expanded) {
          nextExpandedPaths.add(path);
        } else {
          nextExpandedPaths.delete(path);
        }

        writeExpandedDirectoryPaths(props.sessionKey, nextExpandedPaths);
        return nextExpandedPaths;
      });
    },
    [props.sessionKey],
  );

  const openInlineCreate = useCallback(
    (kind: EditableProjectEntryKind, parentPath: string | null) => {
      if (parentPath !== null) {
        setDirectoryExpanded(parentPath, true);
      }
      setPendingInlineEdit({
        mode: "create",
        kind,
        parentPath,
        draft: "",
        submitting: false,
      });
    },
    [setDirectoryExpanded],
  );

  const openInlineRename = useCallback((entry: ProjectEntry) => {
    setPendingInlineEdit({
      mode: "rename",
      entry,
      parentPath: parentPathOf(entry.path),
      draft: basename(entry.path),
      submitting: false,
    });
  }, []);

  const cancelInlineEdit = useCallback(() => {
    setPendingInlineEdit(null);
  }, []);

  const updateInlineDraft = useCallback((draft: string) => {
    setPendingInlineEdit((current) => (current ? { ...current, draft } : null));
  }, []);

  const submitInlineEdit = useCallback(async () => {
    if (!pendingInlineEdit) {
      return;
    }

    const parentPath =
      pendingInlineEdit.mode === "rename"
        ? parentPathOf(pendingInlineEdit.entry.path)
        : pendingInlineEdit.parentPath;
    const normalizedPath = normalizeInlineEntryPath({
      draft: pendingInlineEdit.draft,
      parentPath,
    });

    if (!normalizedPath) {
      throw new Error("Enter a valid relative path.");
    }

    setPendingInlineEdit((current) => (current ? { ...current, submitting: true } : null));

    if (pendingInlineEdit.mode === "create") {
      try {
        const result = await props.onCreateEntry({
          kind: pendingInlineEdit.kind,
          relativePath: normalizedPath,
        });

        if (result.kind === "directory") {
          setDirectoryExpanded(result.path, true);
        }
        setPendingInlineEdit(null);
      } catch {
        setPendingInlineEdit((current) => (current ? { ...current, submitting: false } : null));
      }
      return;
    }

    try {
      const result = await props.onRenameEntry({
        entry: pendingInlineEdit.entry,
        nextRelativePath: normalizedPath,
      });
      if (result.kind === "directory") {
        setExpandedDirectoryPaths((current) => {
          const nextPaths = replaceExpandedDirectoryPrefix(current, {
            fromPrefix: result.fromPath,
            toPrefix: result.toPath,
          });
          writeExpandedDirectoryPaths(props.sessionKey, nextPaths);
          return nextPaths;
        });
      }
      setPendingInlineEdit(null);
    } catch {
      setPendingInlineEdit((current) => (current ? { ...current, submitting: false } : null));
    }
  }, [pendingInlineEdit, props, setDirectoryExpanded, props.sessionKey]);

  const handleDeleteEntry = useCallback(
    async (entry: ProjectEntry) => {
      await props.onDeleteEntry(entry);
      if (entry.kind === "directory") {
        setExpandedDirectoryPaths((current) => {
          const nextPaths = replaceExpandedDirectoryPrefix(current, {
            fromPrefix: entry.path,
            toPrefix: null,
          });
          writeExpandedDirectoryPaths(props.sessionKey, nextPaths);
          return nextPaths;
        });
      }
      if (pendingInlineEdit?.mode === "rename" && pendingInlineEdit.entry.path === entry.path) {
        setPendingInlineEdit(null);
      }
    },
    [pendingInlineEdit, props, props.sessionKey],
  );

  const showContextMenu = useCallback(
    async (
      event: ReactMouseEvent,
      target: { kind: "root" } | { kind: "entry"; entry: ProjectEntry },
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readLocalApi();
      if (!api) {
        return;
      }

      if (target.kind === "root") {
        const action = await api.contextMenu.show(
          [
            { id: "new-file", label: "New File" },
            { id: "new-folder", label: "New Folder" },
            { id: "refresh", label: "Refresh" },
            { id: "collapse-all", label: "Collapse All" },
          ] satisfies readonly ContextMenuItem<string>[],
          { x: event.clientX, y: event.clientY },
        );

        switch (action) {
          case "new-file":
            openInlineCreate("file", null);
            break;
          case "new-folder":
            openInlineCreate("directory", null);
            break;
          case "refresh":
            props.onRefresh();
            break;
          case "collapse-all":
            setExpandedDirectoryPaths(() => {
              const nextPaths = new Set<string>();
              writeExpandedDirectoryPaths(props.sessionKey, nextPaths);
              return nextPaths;
            });
            break;
        }
        return;
      }

      const { entry } = target;
      setActiveDirectoryPath(entry.kind === "directory" ? entry.path : parentPathOf(entry.path));
      const items =
        entry.kind === "directory"
          ? [
              { id: "new-file", label: "New File" },
              { id: "new-folder", label: "New Folder" },
              { id: "rename", label: "Rename" },
              { id: "delete", label: "Delete", destructive: true },
              { id: "copy-path", label: "Copy Path" },
              { id: "copy-absolute-path", label: "Copy Absolute Path" },
              { id: "open-external", label: "Open in External Editor" },
            ]
          : [
              { id: "open", label: "Open" },
              { id: "add-to-chat", label: "Add to Chat" },
              { id: "open-external", label: "Open in External Editor" },
              { id: "rename", label: "Rename" },
              { id: "delete", label: "Delete", destructive: true },
              { id: "copy-path", label: "Copy Path" },
              { id: "copy-absolute-path", label: "Copy Absolute Path" },
            ];

      const action = await api.contextMenu.show(items, {
        x: event.clientX,
        y: event.clientY,
      });

      switch (action) {
        case "open":
          props.onSelectFile(entry.path);
          break;
        case "add-to-chat":
          if (entry.kind === "file") {
            await props.onAddFileToChatContext?.(entry.path);
          }
          break;
        case "new-file":
          openInlineCreate("file", entry.path);
          break;
        case "new-folder":
          openInlineCreate("directory", entry.path);
          break;
        case "rename":
          openInlineRename(entry);
          break;
        case "delete":
          try {
            await handleDeleteEntry(entry);
          } catch {
            return;
          }
          break;
        case "copy-path":
          props.onCopyRelativePath(entry);
          break;
        case "copy-absolute-path":
          props.onCopyAbsolutePath(entry);
          break;
        case "open-external":
          props.onOpenInExternalEditor(entry);
          break;
      }
    },
    [handleDeleteEntry, openInlineCreate, openInlineRename, props, props.sessionKey],
  );

  return (
    <div onContextMenu={(event) => void showContextMenu(event, { kind: "root" })}>
      <WorkspaceDirectoryEntries
        cwd={props.cwd}
        depth={0}
        environmentId={props.environmentId}
        expandedDirectoryPaths={expandedDirectoryPaths}
        pendingInlineEdit={pendingInlineEdit}
        parentPath={null}
        resolvedTheme={props.resolvedTheme}
        selectedFilePath={props.selectedFilePath}
        setDirectoryExpanded={setDirectoryExpanded}
        setActiveDirectoryPath={setActiveDirectoryPath}
        onCancelInlineEdit={cancelInlineEdit}
        onContextMenu={showContextMenu}
        onInlineDraftChange={updateInlineDraft}
        onInlineSubmit={submitInlineEdit}
        onSelectFile={props.onSelectFile}
      />
    </div>
  );
});

const WorkspaceDirectoryEntries = memo(function WorkspaceDirectoryEntries(props: {
  environmentId: EnvironmentId;
  cwd: string;
  parentPath: string | null;
  depth: number;
  expandedDirectoryPaths: ReadonlySet<string>;
  pendingInlineEdit: PendingInlineEdit | null;
  resolvedTheme: "light" | "dark";
  selectedFilePath: string | null;
  setDirectoryExpanded: (path: string, expanded: boolean) => void;
  setActiveDirectoryPath: (path: string | null) => void;
  onSelectFile: (filePath: string) => void;
  onContextMenu: (
    event: ReactMouseEvent,
    target: { kind: "root" } | { kind: "entry"; entry: ProjectEntry },
  ) => Promise<void>;
  onCancelInlineEdit: () => void;
  onInlineDraftChange: (draft: string) => void;
  onInlineSubmit: () => Promise<void>;
}) {
  const entriesQuery = useQuery(
    projectListEntriesQueryOptions({
      environmentId: props.environmentId,
      cwd: props.cwd,
      ...(props.parentPath !== null ? { relativePath: props.parentPath } : {}),
    }),
  );
  const entries = entriesQuery.data?.entries;
  const showPendingCreateRow =
    props.pendingInlineEdit?.mode === "create" &&
    props.pendingInlineEdit.parentPath === props.parentPath
      ? props.pendingInlineEdit
      : null;

  useEffect(() => {
    if (!entries || entries.length === 0) {
      return;
    }

    return scheduleWorkspaceDirectoryPrefetch({
      environmentId: props.environmentId,
      cwd: props.cwd,
      entries,
    });
  }, [entries, props.cwd, props.environmentId]);

  if (entriesQuery.isLoading) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground",
          props.depth > 0 && "pl-7",
        )}
      >
        <LoaderIcon className="size-3 animate-spin" />
        Loading files…
      </div>
    );
  }

  if (entriesQuery.error) {
    return (
      <div className={cn("px-2 py-2 text-xs text-red-500/80", props.depth > 0 && "pl-7")}>
        {entriesQuery.error instanceof Error
          ? entriesQuery.error.message
          : "Unable to load workspace files."}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {showPendingCreateRow ? (
        <WorkspaceInlineEditRow
          depth={props.depth}
          entryKind={showPendingCreateRow.kind}
          submitting={showPendingCreateRow.submitting}
          value={showPendingCreateRow.draft}
          onCancel={props.onCancelInlineEdit}
          onChange={props.onInlineDraftChange}
          onSubmit={props.onInlineSubmit}
        />
      ) : null}
      {!entries || entries.length === 0 ? (
        props.depth === 0 && !showPendingCreateRow ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No files in this workspace.</div>
        ) : props.depth > 0 && !showPendingCreateRow ? (
          <div className="px-2 py-1.5 pl-7 text-xs text-muted-foreground">Empty</div>
        ) : null
      ) : (
        entries.map((entry) => {
          const pendingRename =
            props.pendingInlineEdit?.mode === "rename" &&
            props.pendingInlineEdit.entry.path === entry.path
              ? props.pendingInlineEdit
              : null;

          if (pendingRename) {
            return (
              <WorkspaceInlineEditRow
                key={entry.path}
                depth={props.depth}
                entryKind={entry.kind}
                submitting={pendingRename.submitting}
                value={pendingRename.draft}
                onCancel={props.onCancelInlineEdit}
                onChange={props.onInlineDraftChange}
                onSubmit={props.onInlineSubmit}
              />
            );
          }

          return entry.kind === "directory" ? (
            <WorkspaceDirectoryNode
              key={entry.path}
              cwd={props.cwd}
              depth={props.depth}
              entry={entry}
              environmentId={props.environmentId}
              expanded={props.expandedDirectoryPaths.has(entry.path)}
              expandedDirectoryPaths={props.expandedDirectoryPaths}
              pendingInlineEdit={props.pendingInlineEdit}
              resolvedTheme={props.resolvedTheme}
              selectedFilePath={props.selectedFilePath}
              setDirectoryExpanded={props.setDirectoryExpanded}
              setActiveDirectoryPath={props.setActiveDirectoryPath}
              onContextMenu={props.onContextMenu}
              onCancelInlineEdit={props.onCancelInlineEdit}
              onInlineDraftChange={props.onInlineDraftChange}
              onInlineSubmit={props.onInlineSubmit}
              onSelectFile={props.onSelectFile}
            />
          ) : (
            <WorkspaceFileNode
              key={entry.path}
              cwd={props.cwd}
              depth={props.depth}
              entry={entry}
              environmentId={props.environmentId}
              resolvedTheme={props.resolvedTheme}
              selected={props.selectedFilePath === entry.path}
              setActiveDirectoryPath={props.setActiveDirectoryPath}
              onContextMenu={props.onContextMenu}
              onSelectFile={props.onSelectFile}
            />
          );
        })
      )}
    </div>
  );
});

const WorkspaceDirectoryNode = memo(function WorkspaceDirectoryNode(props: {
  environmentId: EnvironmentId;
  cwd: string;
  depth: number;
  entry: ProjectEntry;
  expanded: boolean;
  expandedDirectoryPaths: ReadonlySet<string>;
  pendingInlineEdit: PendingInlineEdit | null;
  resolvedTheme: "light" | "dark";
  selectedFilePath: string | null;
  setDirectoryExpanded: (path: string, expanded: boolean) => void;
  setActiveDirectoryPath: (path: string | null) => void;
  onSelectFile: (filePath: string) => void;
  onContextMenu: (
    event: ReactMouseEvent,
    target: { kind: "root" } | { kind: "entry"; entry: ProjectEntry },
  ) => Promise<void>;
  onCancelInlineEdit: () => void;
  onInlineDraftChange: (draft: string) => void;
  onInlineSubmit: () => Promise<void>;
}) {
  const leftPadding = 8 + props.depth * 14;

  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-background/80"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => {
          props.setActiveDirectoryPath(props.entry.path);
          props.setDirectoryExpanded(props.entry.path, !props.expanded);
        }}
        onContextMenu={(event) =>
          void props.onContextMenu(event, { kind: "entry", entry: props.entry })
        }
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 fill-muted-foreground/70 transition-transform group-hover:fill-foreground/80",
            props.expanded && "rotate-90",
          )}
        />
        {props.expanded ? (
          <FolderIcon className="size-3.5 shrink-0 fill-muted-foreground/75" />
        ) : (
          <FolderClosedIcon className="size-3.5 shrink-0 fill-muted-foreground/75" />
        )}
        <span className="text-code-compact truncate text-muted-foreground/90 group-hover:text-foreground/90">
          {basename(props.entry.path)}
        </span>
      </button>
      {props.expanded ? (
        <WorkspaceDirectoryEntries
          cwd={props.cwd}
          depth={props.depth + 1}
          environmentId={props.environmentId}
          expandedDirectoryPaths={props.expandedDirectoryPaths}
          pendingInlineEdit={props.pendingInlineEdit}
          parentPath={props.entry.path}
          resolvedTheme={props.resolvedTheme}
          selectedFilePath={props.selectedFilePath}
          setDirectoryExpanded={props.setDirectoryExpanded}
          setActiveDirectoryPath={props.setActiveDirectoryPath}
          onCancelInlineEdit={props.onCancelInlineEdit}
          onContextMenu={props.onContextMenu}
          onInlineDraftChange={props.onInlineDraftChange}
          onInlineSubmit={props.onInlineSubmit}
          onSelectFile={props.onSelectFile}
        />
      ) : null}
    </div>
  );
});

const WorkspaceFileNode = memo(function WorkspaceFileNode(props: {
  cwd: string;
  depth: number;
  entry: ProjectEntry;
  environmentId: EnvironmentId;
  resolvedTheme: "light" | "dark";
  selected: boolean;
  setActiveDirectoryPath: (path: string | null) => void;
  onSelectFile: (filePath: string) => void;
  onContextMenu: (
    event: ReactMouseEvent,
    target: { kind: "root" } | { kind: "entry"; entry: ProjectEntry },
  ) => Promise<void>;
}) {
  const leftPadding = 8 + props.depth * 14;
  const prefetchFile = useCallback(() => {
    prefetchProjectFileForEditor({
      environmentId: props.environmentId,
      cwd: props.cwd,
      relativePath: props.entry.path,
    });
  }, [props.cwd, props.entry.path, props.environmentId]);

  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-background/80",
        props.selected && "bg-accent/60 text-accent-foreground hover:bg-accent/70",
      )}
      style={{ paddingLeft: `${leftPadding}px` }}
      onFocus={prefetchFile}
      onMouseEnter={prefetchFile}
      onContextMenu={(event) =>
        void props.onContextMenu(event, { kind: "entry", entry: props.entry })
      }
      onClick={() => {
        prefetchFile();
        props.setActiveDirectoryPath(parentPathOf(props.entry.path));
        props.onSelectFile(props.entry.path);
      }}
      title={props.entry.path}
    >
      <span aria-hidden="true" className="size-3.5 shrink-0" />
      <VscodeEntryIcon
        pathValue={props.entry.path}
        kind="file"
        theme={props.resolvedTheme}
        className="size-3.5 text-muted-foreground/70"
      />
      <span className="text-code-compact truncate text-muted-foreground/80 group-hover:text-foreground/90">
        {basename(props.entry.path)}
      </span>
    </button>
  );
});

const WorkspaceInlineEditRow = memo(function WorkspaceInlineEditRow(props: {
  depth: number;
  entryKind: EditableProjectEntryKind;
  value: string;
  submitting: boolean;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
}) {
  const leftPadding = 8 + props.depth * 14;
  const submitAttemptedRef = useRef(false);

  return (
    <div
      className="flex items-center gap-2 rounded-md py-1 pr-2"
      style={{ paddingLeft: `${leftPadding}px` }}
    >
      <span aria-hidden="true" className="size-2.5 shrink-0" />
      {props.entryKind === "directory" ? (
        <FolderIcon className="size-3.5 shrink-0 fill-muted-foreground/75" />
      ) : (
        <DocumentIcon className="size-3.5 shrink-0 fill-current text-muted-foreground/75" />
      )}
      <input
        autoFocus
        value={props.value}
        disabled={props.submitting}
        className="text-code-compact h-6 min-w-0 flex-1 rounded border border-border bg-background px-2 text-foreground outline-none ring-0 focus:border-ring"
        onChange={(event) => {
          submitAttemptedRef.current = false;
          props.onChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            submitAttemptedRef.current = true;
            void props.onSubmit().catch(() => {
              submitAttemptedRef.current = false;
            });
          }
        }}
        onBlur={() => {
          if (submitAttemptedRef.current || props.submitting) {
            return;
          }
          if (props.value.trim().length === 0) {
            props.onCancel();
            return;
          }
          submitAttemptedRef.current = true;
          void props.onSubmit().catch(() => {
            submitAttemptedRef.current = false;
          });
        }}
      />
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => {
          submitAttemptedRef.current = true;
          void props.onSubmit().catch(() => {
            submitAttemptedRef.current = false;
          });
        }}
        aria-label="Confirm"
        title="Confirm"
      >
        <CheckIcon className="size-2.5 fill-current" />
      </button>
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={props.onCancel}
        aria-label="Cancel"
        title="Cancel"
      >
        <XIcon className="size-2.5 fill-current" />
      </button>
    </div>
  );
});
