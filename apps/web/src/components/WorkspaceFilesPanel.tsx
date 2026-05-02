import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { EnvironmentId, ScopedProjectRef } from "@forma/contracts";
import * as Schema from "effect/Schema";
import {
  IconListTriangle as SidebarToggleIcon,
  IconMagnifyingglass as SearchIcon,
  IconProgressIndicator as LoaderIcon,
  IconSquareAndArrowUp as OpenInIDEIcon,
  IconXmark as XIcon,
} from "symbols-react";
import { useCallback, useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useComposerHandleContext } from "../composerHandleContext";
import {
  buildDiffClosedSearch,
  buildDiffEditorSearch,
  buildDiffFilesSearch,
  parseDiffRouteSearch,
} from "../diffRouteSearch";
import { openInPreferredEditor } from "../editorPreferences";
import { useTheme } from "../hooks/useTheme";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { type CodeContextSelection } from "../lib/codeContext";
import { resolveEditorFileLabel } from "../lib/editorFileLabel";
import { prefetchProjectFileForEditor } from "../lib/projectFileReadCache";
import {
  invalidateProjectQueries,
  projectSearchEntriesQueryOptions,
} from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { classifyPreviewRelativePath, openPreviewTarget } from "../previewTargets";
import { resolvePathLinkTarget } from "../terminal-links";
import {
  type ThreadRouteTarget,
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
} from "../threadRoutes";
import { DiffFileEditorPane } from "./DiffFileEditorPane";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { WorkspaceFilesTree } from "./WorkspaceFilesTree";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Kbd, KbdGroup } from "./ui/kbd";
import { ScrollArea } from "./ui/scroll-area";
import { toastManager } from "./ui/toast";

const WORKSPACE_PANEL_TREE_COLLAPSED_KEY = "forma:workspace-panel-tree-collapsed:v1";
const WorkspacePanelTreeCollapsedSchema = Schema.Record(Schema.String, Schema.Boolean);

interface EditorTarget {
  filePath: string;
  line?: number | undefined;
  column?: number | undefined;
}

interface WorkspaceEditorControlsState {
  canSave: boolean;
  filePath: string;
  isDirty: boolean;
  isSaving: boolean;
}

function resolveParentDirectoryLabel(filePath: string): string | null {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }
  return normalizedPath.slice(0, separatorIndex);
}

interface WorkspaceFilesPanelProps {
  mode?: DiffPanelMode;
  routeTarget: ThreadRouteTarget;
  environmentId: EnvironmentId;
  panelKey: string;
  workspaceRoot: string | null;
  activeProjectRef: ScopedProjectRef | null;
}

function buildEditorTargetKey(target: EditorTarget | null): string | null {
  if (!target) {
    return null;
  }
  return `${target.filePath}:${target.line ?? ""}:${target.column ?? ""}`;
}

function resolveRouteEditorTarget(input: {
  editorFilePath?: string | null | undefined;
  editorLine?: number | undefined;
  editorColumn?: number | undefined;
}): EditorTarget | null {
  if (!input.editorFilePath) {
    return null;
  }

  return {
    filePath: input.editorFilePath,
    ...(typeof input.editorLine === "number" ? { line: input.editorLine } : {}),
    ...(typeof input.editorColumn === "number" ? { column: input.editorColumn } : {}),
  };
}

export function WorkspaceFilesPanel({
  mode = "inline",
  routeTarget,
  environmentId,
  panelKey,
  workspaceRoot,
  activeProjectRef,
}: WorkspaceFilesPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const composerRef = useComposerHandleContext();
  const { resolvedTheme } = useTheme();
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const panelOpen = diffSearch.diff === "1";
  const routeEditorTarget = useMemo(
    () =>
      resolveRouteEditorTarget({
        editorFilePath: diffSearch.editorFilePath,
        editorLine: diffSearch.editorLine,
        editorColumn: diffSearch.editorColumn,
      }),
    [diffSearch.editorColumn, diffSearch.editorFilePath, diffSearch.editorLine],
  );
  const routeEditorTargetKey = useMemo(
    () => buildEditorTargetKey(routeEditorTarget),
    [routeEditorTarget],
  );
  const [activeEditorTarget, setActiveEditorTarget] = useState<EditorTarget | null>(
    () => routeEditorTarget,
  );
  const [pendingRequestedFilePathChange, setPendingRequestedFilePathChange] = useState<
    string | null
  >(null);
  const lastAppliedRouteTargetRef = useRef<string | null>(routeEditorTargetKey);
  const wasPanelOpenRef = useRef(panelOpen);
  const editorFilePath = activeEditorTarget?.filePath ?? null;
  const editorLine = activeEditorTarget?.line;
  const editorColumn = activeEditorTarget?.column;
  const [editorControlsState, setEditorControlsState] =
    useState<WorkspaceEditorControlsState | null>(null);
  const [requestedSaveNonce, setRequestedSaveNonce] = useState(0);
  const [requestedBackNonce, setRequestedBackNonce] = useState(0);
  const [requestedClosePanelNonce, setRequestedClosePanelNonce] = useState(0);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const deferredSidebarSearchQuery = useDeferredValue(sidebarSearchQuery.trim());
  const [treeCollapsedByWorkspace, setTreeCollapsedByWorkspace] = useLocalStorage(
    WORKSPACE_PANEL_TREE_COLLAPSED_KEY,
    {},
    WorkspacePanelTreeCollapsedSchema,
  );
  const treeCollapsed = workspaceRoot ? (treeCollapsedByWorkspace[workspaceRoot] ?? false) : false;
  const searchEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      environmentId,
      cwd: workspaceRoot,
      query: deferredSidebarSearchQuery,
      enabled: workspaceRoot !== null && deferredSidebarSearchQuery.length > 0,
    }),
  );
  const searchedFileEntries = useMemo(
    () => (searchEntriesQuery.data?.entries ?? []).filter((entry) => entry.kind === "file"),
    [searchEntriesQuery.data?.entries],
  );
  const sidebarSearchActive = deferredSidebarSearchQuery.length > 0;

  useLayoutEffect(() => {
    const openedIntoFilesView =
      panelOpen && !wasPanelOpenRef.current && diffSearch.diffView === "files";
    wasPanelOpenRef.current = panelOpen;

    if (openedIntoFilesView) {
      lastAppliedRouteTargetRef.current = null;
      setPendingRequestedFilePathChange(null);
      setActiveEditorTarget(null);
      return;
    }

    if (
      routeEditorTargetKey === null ||
      routeEditorTargetKey === lastAppliedRouteTargetRef.current
    ) {
      return;
    }

    lastAppliedRouteTargetRef.current = routeEditorTargetKey;
    setPendingRequestedFilePathChange(null);
    setActiveEditorTarget(routeEditorTarget);
  }, [diffSearch.diffView, panelOpen, routeEditorTarget, routeEditorTargetKey]);

  const navigateToCurrentRoute = useCallback(
    (updateSearch: (previous: Record<string, unknown>) => Record<string, unknown>) => {
      if (routeTarget.kind === "server") {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(routeTarget.threadRef),
          search: updateSearch,
        });
        return;
      }

      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(routeTarget.draftId),
        search: updateSearch,
      });
    },
    [navigate, routeTarget],
  );

  const toggleTreeCollapsed = useCallback(() => {
    if (!workspaceRoot) {
      return;
    }
    setTreeCollapsedByWorkspace((current) => ({
      ...current,
      [workspaceRoot]: !(current[workspaceRoot] ?? false),
    }));
  }, [setTreeCollapsedByWorkspace, workspaceRoot]);

  const addEditorCodeContext = useCallback(
    (selection: CodeContextSelection) => {
      const composerHandle = composerRef?.current;
      if (!composerHandle) {
        toastManager.add({
          type: "error",
          title: "Composer is unavailable",
        });
        return;
      }

      const added = composerHandle.addCodeContext(selection, {
        focusComposerAfterInsert: false,
      });
      toastManager.add({
        type: added ? "success" : "info",
        title: added ? "Code added to composer" : "Code already attached",
      });
    },
    [composerRef],
  );

  const openWorkspaceFileInEditor = useCallback(
    (filePath: string) => {
      const api = readLocalApi();
      if (!api || !workspaceRoot) return;
      void openInPreferredEditor(api, resolvePathLinkTarget(filePath, workspaceRoot)).catch(
        (error) => {
          console.warn("Failed to open workspace file in editor.", error);
        },
      );
    },
    [workspaceRoot],
  );

  const previewDisabledReasonForFile = useCallback(
    (filePath: string) => {
      if (!activeProjectRef) {
        return "Preview is unavailable until this workspace is attached to a project.";
      }
      const classification = classifyPreviewRelativePath(filePath);
      return classification.enabled ? null : (classification.reason ?? "Preview is unavailable.");
    },
    [activeProjectRef],
  );

  const openPreviewForFile = useCallback(
    (filePath: string) => {
      if (!activeProjectRef) {
        return;
      }
      const classification = classifyPreviewRelativePath(filePath);
      if (!classification.enabled || !classification.targetKind) {
        return;
      }
      openPreviewTarget(activeProjectRef, {
        targetKind: classification.targetKind,
        relativePath: filePath,
      });
    },
    [activeProjectRef],
  );

  const persistSavedWorkspaceFile = useCallback(async () => {
    if (!workspaceRoot) {
      return;
    }
    await invalidateProjectQueries(queryClient, {
      environmentId,
      cwd: workspaceRoot,
    });
  }, [environmentId, queryClient, workspaceRoot]);

  const selectFile = useCallback(
    (filePath: string) => {
      const nextTarget = { filePath } satisfies EditorTarget;
      if (diffSearch.diffView === "editor") {
        if (activeEditorTarget?.filePath === filePath) {
          return;
        }
        setPendingRequestedFilePathChange(filePath);
        return;
      }

      setPendingRequestedFilePathChange(null);
      setActiveEditorTarget(nextTarget);
      navigateToCurrentRoute((previous) =>
        buildDiffEditorSearch(previous, {
          filePath,
          backToView: "files",
        }),
      );
    },
    [activeEditorTarget?.filePath, diffSearch.diffView, navigateToCurrentRoute],
  );

  const openEditorTarget = useCallback(
    (target: EditorTarget) => {
      setPendingRequestedFilePathChange(null);
      setActiveEditorTarget(target);
      if (diffSearch.diffView === "editor") {
        return;
      }

      navigateToCurrentRoute((previous) =>
        buildDiffEditorSearch(previous, {
          filePath: target.filePath,
          ...(typeof target.line === "number" ? { line: target.line } : {}),
          ...(typeof target.column === "number" ? { column: target.column } : {}),
          backToView: "files",
        }),
      );
    },
    [diffSearch.diffView, navigateToCurrentRoute],
  );

  const editorSessionKey = workspaceRoot ? `workspace-files:${panelKey}` : undefined;
  const editorVisible = diffSearch.diffView === "editor" && activeEditorTarget !== null;
  const canTriggerSave =
    editorVisible &&
    editorFilePath !== null &&
    editorControlsState?.filePath === editorFilePath &&
    editorControlsState.canSave &&
    editorControlsState.isDirty;
  const editorSaveInProgress =
    editorVisible &&
    editorFilePath !== null &&
    editorControlsState?.filePath === editorFilePath &&
    editorControlsState.isSaving;

  useLayoutEffect(() => {
    if (!editorVisible || !editorFilePath) {
      setEditorControlsState(null);
      return;
    }

    setEditorControlsState((current) => (current?.filePath === editorFilePath ? current : null));
  }, [editorFilePath, editorVisible]);

  const closeWorkspacePanel = useCallback(() => {
    navigateToCurrentRoute((previous) => buildDiffClosedSearch(previous));
  }, [navigateToCurrentRoute]);
  const prefetchWorkspaceFile = useCallback(
    (filePath: string) => {
      if (!workspaceRoot) {
        return;
      }
      prefetchProjectFileForEditor({
        environmentId,
        cwd: workspaceRoot,
        relativePath: filePath,
      });
    },
    [environmentId, workspaceRoot],
  );

  return (
    <DiffPanelShell mode={mode}>
      {!workspaceRoot ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Files are unavailable until this thread has an active project.
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => {
                if (editorVisible) {
                  setRequestedClosePanelNonce((current) => current + 1);
                  return;
                }
                closeWorkspacePanel();
              }}
              aria-label="Close files panel"
              title="Close files panel"
            >
              <XIcon className="size-2.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={toggleTreeCollapsed}
              aria-label={treeCollapsed ? "Show editor sidebar" : "Hide editor sidebar"}
              title={treeCollapsed ? "Show editor sidebar" : "Hide editor sidebar"}
            >
              <SidebarToggleIcon className="size-3.5" />
            </Button>
            <div className="min-w-0 flex-1">
              {editorVisible && editorFilePath ? (
                <div className="flex min-w-0 items-center gap-1 overflow-x-auto py-0.5">
                  <div
                    className="group inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border border-border bg-accent px-2 py-1 font-medium leading-none text-accent-foreground"
                    title={editorFilePath}
                  >
                    <span className="text-ui-xs block max-w-60 truncate">
                      {resolveEditorFileLabel(editorFilePath)}
                    </span>
                    <button
                      type="button"
                      className="text-accent-foreground/70 opacity-0 transition-opacity hover:text-accent-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                      aria-label="Close file"
                      title="Close file"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRequestedBackNonce((current) => current + 1);
                      }}
                    >
                      <XIcon className="size-2.5" />
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            {editorVisible && editorFilePath ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="xs"
                  className="px-2"
                  onClick={() => {
                    setRequestedSaveNonce((current) => current + 1);
                  }}
                  disabled={!canTriggerSave}
                >
                  {editorSaveInProgress ? "Saving..." : "Save"}
                  <KbdGroup
                    aria-hidden
                    className="pointer-events-none inline-flex items-center gap-1"
                  >
                    <Kbd className="text-ui-2xs h-4 min-w-0 rounded-sm bg-primary-foreground/12 px-1 text-primary-foreground/80">
                      ⌘
                    </Kbd>
                    <Kbd className="text-ui-2xs h-4 min-w-4 rounded-sm bg-primary-foreground/12 px-1 text-primary-foreground/80">
                      S
                    </Kbd>
                  </KbdGroup>
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => openPreviewForFile(editorFilePath)}
                  disabled={previewDisabledReasonForFile(editorFilePath) !== null}
                  title={previewDisabledReasonForFile(editorFilePath) ?? "Open Preview"}
                >
                  Preview
                </Button>
                <Button
                  size="icon-xs"
                  variant="outline"
                  onClick={() => openWorkspaceFileInEditor(editorFilePath)}
                  aria-label="Open in IDE"
                  title="Open in IDE"
                >
                  <OpenInIDEIcon className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1">
            <div
              className={cn(
                "flex min-h-0 shrink-0 flex-col overflow-hidden bg-card/50",
                treeCollapsed ? "w-0 border-r-0" : "w-72 border-r border-border/70",
              )}
            >
              {treeCollapsed ? null : (
                <>
                  <div className="border-b border-border/60 px-2 py-2">
                    <div className="relative">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 fill-muted-foreground/70" />
                      <Input
                        value={sidebarSearchQuery}
                        onChange={(event) => {
                          setSidebarSearchQuery(event.target.value);
                        }}
                        placeholder="Search files..."
                        aria-label="Search files"
                        className="h-8 pl-5 text-ui-xs"
                      />
                    </div>
                  </div>
                  <ScrollArea className="min-h-0 flex-1 px-1.5 py-2">
                    {sidebarSearchActive ? (
                      searchEntriesQuery.isLoading ? (
                        <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                          <LoaderIcon className="size-3 animate-spin" />
                          Searching files…
                        </div>
                      ) : searchedFileEntries.length === 0 ? (
                        <div className="px-2 py-2 text-xs text-muted-foreground">
                          No matching files.
                        </div>
                      ) : (
                        <div className="space-y-0.5">
                          {searchedFileEntries.map((entry) => {
                            const parentDirectoryLabel = resolveParentDirectoryLabel(entry.path);
                            return (
                              <button
                                key={entry.path}
                                type="button"
                                className={cn(
                                  "group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-background/80",
                                  activeEditorTarget?.filePath === entry.path &&
                                    "bg-accent/60 text-accent-foreground hover:bg-accent/70",
                                )}
                                title={entry.path}
                                onFocus={() => prefetchWorkspaceFile(entry.path)}
                                onMouseEnter={() => prefetchWorkspaceFile(entry.path)}
                                onClick={() => {
                                  prefetchWorkspaceFile(entry.path);
                                  selectFile(entry.path);
                                }}
                              >
                                <VscodeEntryIcon
                                  pathValue={entry.path}
                                  kind="file"
                                  theme={resolvedTheme}
                                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="text-code-compact block truncate font-mono text-muted-foreground/90 group-hover:text-foreground/90">
                                    {resolveEditorFileLabel(entry.path)}
                                  </span>
                                  {parentDirectoryLabel ? (
                                    <span className="text-ui-2xs block truncate text-muted-foreground/65">
                                      {parentDirectoryLabel}
                                    </span>
                                  ) : null}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )
                    ) : (
                      <WorkspaceFilesTree
                        cwd={workspaceRoot}
                        environmentId={environmentId}
                        sessionKey={`${panelKey}:${workspaceRoot}`}
                        resolvedTheme={resolvedTheme}
                        selectedFilePath={activeEditorTarget?.filePath ?? null}
                        onSelectFile={selectFile}
                      />
                    )}
                  </ScrollArea>
                </>
              )}
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {editorVisible && editorFilePath ? (
                <DiffFileEditorPane
                  cwd={workspaceRoot}
                  environmentId={environmentId}
                  sessionKey={editorSessionKey}
                  fileDiff={null}
                  filePath={editorFilePath}
                  filePaths={[editorFilePath]}
                  initialColumn={editorColumn}
                  initialLine={editorLine}
                  initialOverride={undefined}
                  showHeader={false}
                  reuseMonacoModels={true}
                  navigationLabel="Close file"
                  resolvedTheme={resolvedTheme}
                  onAddCodeContext={addEditorCodeContext}
                  onEditorControlsStateChange={setEditorControlsState}
                  onOpenInEditor={openWorkspaceFileInEditor}
                  onOpenPreview={openPreviewForFile}
                  previewDisabledReason={previewDisabledReasonForFile(editorFilePath)}
                  onPersisted={persistSavedWorkspaceFile}
                  onHandledRequestedFilePathChange={() => {
                    setPendingRequestedFilePathChange(null);
                  }}
                  onRequestClosePanel={closeWorkspacePanel}
                  onRequestBack={() => {
                    if (diffSearch.editorBackToView === "files") {
                      navigateToCurrentRoute((previous) => buildDiffFilesSearch(previous));
                      return;
                    }
                    navigateToCurrentRoute((previous) => buildDiffClosedSearch(previous));
                  }}
                  onRequestFilePathChange={(filePath) => {
                    openEditorTarget({ filePath });
                  }}
                  requestedBackNonce={requestedBackNonce}
                  requestedClosePanelNonce={requestedClosePanelNonce}
                  requestedFilePathChange={pendingRequestedFilePathChange}
                  requestedSaveNonce={requestedSaveNonce}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <div className="max-w-sm space-y-2">
                    <p className="text-sm font-medium text-foreground">Select a file to open it.</p>
                    <p className="text-sm text-muted-foreground">
                      Browse the workspace tree to inspect and edit project files without leaving
                      chat.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </DiffPanelShell>
  );
}
