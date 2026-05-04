import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { EnvironmentId, ScopedProjectRef } from "@forma/contracts";
import { scopeThreadRef } from "@forma/client-runtime";
import * as Schema from "effect/Schema";
import {
  IconListBulletIndent as SidebarToggleIcon,
  IconMagnifyingglass as SearchIcon,
  IconPlusminus as DiffIcon,
  IconProgressIndicator as LoaderIcon,
  IconRectangleSplit2x1 as Columns2Icon,
  IconRectangleSplit3x1 as Rows3Icon,
  IconTextWordSpacing as TextWrapIcon,
  IconXmarkCircleFill as XIconCircle,
  IconXmark as XIcon,
} from "symbols-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";

import { useComposerHandleContext } from "../composerHandleContext";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  type DiffRouteSearch,
  buildDiffClosedSearch,
  buildDiffEditorSearch,
  buildDiffFilesSearch,
  buildDiffOpenSearch,
  buildDiffSearchFromSnapshot,
  buildDiffTurnSearch,
  parseDiffRouteSearch,
} from "../diffRouteSearch";
import { openInPreferredEditor } from "../editorPreferences";
import { useSettings } from "../hooks/useSettings";
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
import { DiffFileEditorPane, type DiffFileEditorRequestedNavigation } from "./DiffFileEditorPane";
import type { DiffPanelProps } from "./DiffPanel";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { HeaderIconActionButton } from "./HeaderIconActionButton";
import { WorkspaceFilesTree } from "./WorkspaceFilesTree";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { PreviewTriggerIcon, TerminalToggleIcon } from "./icons/custom";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Kbd, KbdGroup } from "./ui/kbd";
import { ScrollArea } from "./ui/scroll-area";
import { toastManager } from "./ui/toast";
import { Toggle } from "./ui/toggle";
import { ToggleGroup, Toggle as ToggleGroupItem } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useBottomDrawerUiStore } from "../bottomDrawerUiStore";
import { usePreviewWorkspaceStore } from "../previewWorkspaceStore";
import { shortcutLabelForCommand } from "../keybindings";
import { useServerKeybindings } from "~/rpc/serverState";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";

const WORKSPACE_PANEL_TREE_COLLAPSED_KEY = "forma:workspace-panel-tree-collapsed:v1";
const WorkspacePanelTreeCollapsedSchema = Schema.Record(Schema.String, Schema.Boolean);

type WorkspaceSurfaceMode = "closed" | "files" | "editor" | "diff";
type DiffRenderMode = "stacked" | "split";

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

interface WorkspaceFilesPanelProps {
  mode?: DiffPanelMode;
  routeTarget: ThreadRouteTarget;
  environmentId: EnvironmentId;
  panelKey: string;
  workspaceRoot: string | null;
  activeProjectRef: ScopedProjectRef | null;
  supportsDiff: boolean;
  requestedDiffToggleNonce?: number | undefined;
  DiffBrowserComponent: ComponentType<DiffPanelProps>;
}

function resolveParentDirectoryLabel(filePath: string): string | null {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }
  return normalizedPath.slice(0, separatorIndex);
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

function resolveSurfaceMode(search: DiffRouteSearch): WorkspaceSurfaceMode {
  if (search.diff !== "1") {
    return "closed";
  }
  if (search.diffView === "files") {
    return "files";
  }
  if (search.diffView === "editor") {
    return "editor";
  }
  return "diff";
}

function buildFilesSnapshot(search: DiffRouteSearch): DiffRouteSearch {
  return {
    diff: "1",
    ...(search.diffTurnId ? { diffTurnId: search.diffTurnId } : {}),
    ...(search.diffFilePath ? { diffFilePath: search.diffFilePath } : {}),
    diffView: "files",
  };
}

function buildEditorSnapshot(search: DiffRouteSearch, target: EditorTarget): DiffRouteSearch {
  const backToView = search.editorBackToView;
  return {
    diff: "1",
    ...(backToView === "diff" && search.diffTurnId ? { diffTurnId: search.diffTurnId } : {}),
    ...(backToView === "diff" && search.diffFilePath ? { diffFilePath: search.diffFilePath } : {}),
    diffView: "editor",
    editorFilePath: target.filePath,
    ...(typeof target.line === "number" ? { editorLine: target.line } : {}),
    ...(typeof target.column === "number" ? { editorColumn: target.column } : {}),
    ...(backToView ? { editorBackToView: backToView } : {}),
  };
}

export function WorkspaceFilesPanel({
  mode = "inline",
  routeTarget,
  environmentId,
  panelKey,
  workspaceRoot,
  activeProjectRef,
  supportsDiff,
  requestedDiffToggleNonce,
  DiffBrowserComponent,
}: WorkspaceFilesPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const composerRef = useComposerHandleContext();
  const settings = useSettings();
  const { resolvedTheme } = useTheme();
  const keybindings = useServerKeybindings();
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const draftSession = useComposerDraftStore((store) =>
    routeTarget.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const activeThreadRef = useMemo(
    () =>
      routeTarget.kind === "server"
        ? routeTarget.threadRef
        : draftSession
          ? scopeThreadRef(draftSession.environmentId, draftSession.threadId)
          : null,
    [draftSession, routeTarget],
  );
  const bottomDrawerMode = useBottomDrawerUiStore((state) => state.visibleMode);
  const showTerminalDrawer = useBottomDrawerUiStore((state) => state.showTerminal);
  const closeBottomDrawer = useBottomDrawerUiStore((state) => state.closeVisibleMode);
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, activeThreadRef),
  );
  const setTerminalOpen = useTerminalStateStore((state) => state.setTerminalOpen);
  const activePreviewRelativePath = usePreviewWorkspaceStore((state) =>
    activeProjectRef
      ? (state.projectStateByKey[`${activeProjectRef.environmentId}:${activeProjectRef.projectId}`]
          ?.currentRelativePath ?? null)
      : null,
  );
  const panelOpen = diffSearch.diff === "1";
  const surfaceMode = resolveSurfaceMode(diffSearch);
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
  const [editorControlsState, setEditorControlsState] =
    useState<WorkspaceEditorControlsState | null>(null);
  const [requestedSaveNonce, setRequestedSaveNonce] = useState(0);
  const requestedNavigationNonceRef = useRef(0);
  const [requestedNavigation, setRequestedNavigation] =
    useState<DiffFileEditorRequestedNavigation | null>(null);
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
  const lastAppliedRouteTargetRef = useRef<string | null>(routeEditorTargetKey);
  const lastNonDiffSnapshotRef = useRef<DiffRouteSearch | null>(
    diffSearch.diffView === "editor" && routeEditorTarget
      ? buildEditorSnapshot(diffSearch, routeEditorTarget)
      : diffSearch.diffView === "files"
        ? buildFilesSnapshot(diffSearch)
        : null,
  );
  const wasPanelOpenRef = useRef(panelOpen);
  const lastHandledRequestedDiffToggleNonceRef = useRef<number | undefined>(
    requestedDiffToggleNonce,
  );
  const editorFilePath = activeEditorTarget?.filePath ?? null;
  const editorLine = activeEditorTarget?.line;
  const editorColumn = activeEditorTarget?.column;
  const previewOpen = bottomDrawerMode === "preview";
  const terminalAvailable = activeProjectRef !== null && activeThreadRef !== null;
  const terminalOpen = bottomDrawerMode === "terminal";
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const editorVisible = surfaceMode === "editor" && activeEditorTarget !== null;
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
  const editorSessionKey = workspaceRoot ? `workspace-surface:${panelKey}` : undefined;
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const previousDiffVisibleRef = useRef(surfaceMode === "diff");

  useLayoutEffect(() => {
    const openedIntoFilesView =
      panelOpen && !wasPanelOpenRef.current && diffSearch.diffView === "files";
    wasPanelOpenRef.current = panelOpen;

    if (openedIntoFilesView) {
      lastAppliedRouteTargetRef.current = null;
      setRequestedNavigation(null);
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
    setActiveEditorTarget(routeEditorTarget);
  }, [diffSearch.diffView, panelOpen, routeEditorTarget, routeEditorTargetKey]);

  useEffect(() => {
    if (diffSearch.diff !== "1") {
      return;
    }
    if (surfaceMode === "files") {
      lastNonDiffSnapshotRef.current = buildFilesSnapshot(diffSearch);
      return;
    }
    if (surfaceMode === "editor" && activeEditorTarget) {
      lastNonDiffSnapshotRef.current = buildEditorSnapshot(diffSearch, activeEditorTarget);
    }
  }, [activeEditorTarget, diffSearch, surfaceMode]);

  useLayoutEffect(() => {
    if (!editorVisible || !editorFilePath) {
      setEditorControlsState(null);
      return;
    }

    setEditorControlsState((current) => (current?.filePath === editorFilePath ? current : null));
  }, [editorFilePath, editorVisible]);

  useEffect(() => {
    const diffVisible = surfaceMode === "diff";
    if (diffVisible && !previousDiffVisibleRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
    }
    previousDiffVisibleRef.current = diffVisible;
  }, [settings.diffWordWrap, surfaceMode]);

  useEffect(() => {
    if (bottomDrawerMode !== "preview") {
      return;
    }
    usePreviewWorkspaceStore.getState().setActiveProjectRef(activeProjectRef);
  }, [activeProjectRef, bottomDrawerMode]);

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

  const issueNavigationRequest = useCallback(
    (
      type: DiffFileEditorRequestedNavigation["type"],
      options?: { filePath?: string | undefined },
    ) => {
      requestedNavigationNonceRef.current += 1;
      setRequestedNavigation({
        nonce: requestedNavigationNonceRef.current,
        type,
        ...(options?.filePath ? { filePath: options.filePath } : {}),
      });
    },
    [],
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
      if (!api || !workspaceRoot) {
        return;
      }
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
      if (!classification.enabled) {
        return;
      }
      if (bottomDrawerMode === "preview" && activePreviewRelativePath === filePath) {
        closeBottomDrawer();
        return;
      }
      openPreviewTarget(activeProjectRef, {
        relativePath: filePath,
      });
    },
    [activePreviewRelativePath, activeProjectRef, bottomDrawerMode, closeBottomDrawer],
  );

  const activeFilePreviewDisabledReason =
    editorVisible && editorFilePath ? previewDisabledReasonForFile(editorFilePath) : null;
  const activeFilePreviewOpen =
    previewOpen &&
    editorVisible &&
    editorFilePath !== null &&
    activePreviewRelativePath === editorFilePath;

  const closeWorkspacePanel = useCallback(() => {
    navigateToCurrentRoute((previous) => buildDiffClosedSearch(previous));
  }, [navigateToCurrentRoute]);

  const restoreDiffRoute = useCallback(() => {
    navigateToCurrentRoute((previous) => {
      if (diffSearch.diffTurnId) {
        return buildDiffTurnSearch(previous, {
          turnId: diffSearch.diffTurnId,
          ...(diffSearch.diffFilePath ? { filePath: diffSearch.diffFilePath } : {}),
        });
      }
      return buildDiffOpenSearch(previous);
    });
  }, [diffSearch.diffFilePath, diffSearch.diffTurnId, navigateToCurrentRoute]);

  const persistSavedWorkspaceFile = useCallback(async () => {
    if (!workspaceRoot) {
      return;
    }
    await invalidateProjectQueries(queryClient, {
      environmentId,
      cwd: workspaceRoot,
    });
  }, [environmentId, queryClient, workspaceRoot]);

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

  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef) {
      return;
    }
    if (bottomDrawerMode === "terminal") {
      closeBottomDrawer();
      return;
    }
    if (!terminalState.terminalOpen) {
      setTerminalOpen(activeThreadRef, true);
    }
    showTerminalDrawer();
  }, [
    activeThreadRef,
    bottomDrawerMode,
    closeBottomDrawer,
    setTerminalOpen,
    showTerminalDrawer,
    terminalState.terminalOpen,
  ]);

  const openDiffRoute = useCallback(() => {
    if (!supportsDiff) {
      return;
    }
    navigateToCurrentRoute((previous) => {
      if (diffSearch.diffTurnId) {
        return buildDiffTurnSearch(previous, {
          turnId: diffSearch.diffTurnId,
          ...(diffSearch.diffFilePath ? { filePath: diffSearch.diffFilePath } : {}),
        });
      }
      return buildDiffOpenSearch(previous);
    });
  }, [diffSearch.diffFilePath, diffSearch.diffTurnId, navigateToCurrentRoute, supportsDiff]);

  const restoreLastNonDiffView = useCallback(() => {
    navigateToCurrentRoute((previous) =>
      buildDiffSearchFromSnapshot(
        previous,
        lastNonDiffSnapshotRef.current ?? { diff: "1", diffView: "files" },
      ),
    );
  }, [navigateToCurrentRoute]);

  const showDiffFromEditor = useCallback(() => {
    if (!supportsDiff || !activeEditorTarget) {
      return;
    }
    lastNonDiffSnapshotRef.current = buildEditorSnapshot(diffSearch, activeEditorTarget);
    openDiffRoute();
  }, [activeEditorTarget, diffSearch, openDiffRoute, supportsDiff]);

  const toggleDiffMode = useCallback(() => {
    if (!supportsDiff || !panelOpen) {
      return;
    }
    if (surfaceMode === "diff") {
      restoreLastNonDiffView();
      return;
    }
    if (surfaceMode === "editor") {
      issueNavigationRequest("show-diff");
      return;
    }
    lastNonDiffSnapshotRef.current = buildFilesSnapshot(diffSearch);
    openDiffRoute();
  }, [
    diffSearch,
    issueNavigationRequest,
    openDiffRoute,
    panelOpen,
    restoreLastNonDiffView,
    supportsDiff,
    surfaceMode,
  ]);

  useEffect(() => {
    if (
      !supportsDiff ||
      requestedDiffToggleNonce === undefined ||
      requestedDiffToggleNonce === lastHandledRequestedDiffToggleNonceRef.current
    ) {
      return;
    }
    lastHandledRequestedDiffToggleNonceRef.current = requestedDiffToggleNonce;
    toggleDiffMode();
  }, [requestedDiffToggleNonce, supportsDiff, toggleDiffMode]);

  const commitEditorTarget = useCallback((target: EditorTarget) => {
    setActiveEditorTarget(target);
  }, []);

  const selectFile = useCallback(
    (filePath: string) => {
      if (activeEditorTarget?.filePath === filePath && editorVisible) {
        return;
      }
      if (surfaceMode === "editor") {
        issueNavigationRequest("switch-file", { filePath });
        return;
      }
      setActiveEditorTarget({ filePath });
      navigateToCurrentRoute((previous) =>
        buildDiffEditorSearch(previous, {
          filePath,
          backToView: "files",
        }),
      );
    },
    [
      activeEditorTarget?.filePath,
      editorVisible,
      issueNavigationRequest,
      navigateToCurrentRoute,
      surfaceMode,
    ],
  );

  return (
    <DiffPanelShell mode={mode}>
      {!workspaceRoot ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Files are unavailable until this thread has an active project.
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 h-12 items-center gap-2 border-b border-border px-3 py-2">
            <HeaderIconActionButton
              onClick={() => {
                if (editorVisible) {
                  issueNavigationRequest("close-panel");
                  return;
                }
                closeWorkspacePanel();
              }}
              aria-label="Close files panel"
              title="Close files panel"
            >
              <XIcon className="size-2.5" />
            </HeaderIconActionButton>
            <HeaderIconActionButton
              onClick={toggleTreeCollapsed}
              disabled={surfaceMode === "diff"}
              aria-label={treeCollapsed ? "Show editor sidebar" : "Hide editor sidebar"}
              title={treeCollapsed ? "Show editor sidebar" : "Hide editor sidebar"}
            >
              <SidebarToggleIcon className="size-3.5" />
            </HeaderIconActionButton>
            {supportsDiff ? (
              <HeaderIconActionButton
                className="shrink-0"
                onClick={toggleDiffMode}
                pressed={surfaceMode === "diff"}
                aria-label="Toggle diff view"
                title="Toggle diff view"
              >
                <DiffIcon className="size-3 fill-current" />
              </HeaderIconActionButton>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <HeaderIconActionButton
                    pressed={terminalOpen}
                    onClick={toggleTerminalVisibility}
                    aria-label="Toggle terminal drawer"
                    title="Toggle terminal drawer"
                    disabled={!terminalAvailable}
                  >
                    <TerminalToggleIcon className="size-3" />
                  </HeaderIconActionButton>
                }
              />
              <TooltipPopup side="bottom">
                {!terminalAvailable
                  ? "Terminal is unavailable until this thread has an active project."
                  : terminalToggleShortcutLabel
                    ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                    : "Toggle terminal drawer"}
              </TooltipPopup>
            </Tooltip>
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
                        issueNavigationRequest("back");
                      }}
                    >
                      <XIconCircle className="size-3 fill-current/50" />
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {surfaceMode === "diff" ? (
                <>
                  <ToggleGroup
                    className="shrink-0"
                    variant="outline"
                    size="xs"
                    value={[diffRenderMode]}
                    onValueChange={(value) => {
                      const next = value[0];
                      if (next === "stacked" || next === "split") {
                        setDiffRenderMode(next);
                      }
                    }}
                  >
                    <ToggleGroupItem aria-label="Stacked diff view" value="stacked">
                      <Rows3Icon className="size-3 fill-current" />
                    </ToggleGroupItem>
                    <ToggleGroupItem aria-label="Split diff view" value="split">
                      <Columns2Icon className="size-3 fill-current" />
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <Toggle
                    aria-label={
                      diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"
                    }
                    title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
                    variant="outline"
                    size="xs"
                    pressed={diffWordWrap}
                    onPressedChange={(pressed) => {
                      setDiffWordWrap(Boolean(pressed));
                    }}
                  >
                    <TextWrapIcon className="size-3 fill-current" />
                  </Toggle>
                </>
              ) : null}
              {editorVisible && editorFilePath ? (
                <>
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
                    className="gap-1.5 px-2"
                    onClick={() => openPreviewForFile(editorFilePath)}
                    disabled={activeFilePreviewDisabledReason !== null}
                    title={
                      activeFilePreviewDisabledReason ??
                      (activeFilePreviewOpen ? "Close preview" : "Open preview")
                    }
                  >
                    <PreviewTriggerIcon className="size-3.5" />
                    {activeFilePreviewOpen ? "Previewing" : "Preview"}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          {surfaceMode === "diff" ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <DiffBrowserComponent
                showControls={false}
                diffRenderMode={diffRenderMode}
                onDiffRenderModeChange={setDiffRenderMode}
                diffWordWrap={diffWordWrap}
                onDiffWordWrapChange={setDiffWordWrap}
              />
            </div>
          ) : (
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
                    onRequestClosePanel={closeWorkspacePanel}
                    onRequestShowDiff={showDiffFromEditor}
                    onRequestBack={() => {
                      if (diffSearch.editorBackToView === "files") {
                        navigateToCurrentRoute((previous) => buildDiffFilesSearch(previous));
                        return;
                      }
                      if (diffSearch.editorBackToView === "diff") {
                        restoreDiffRoute();
                        return;
                      }
                      navigateToCurrentRoute((previous) => buildDiffClosedSearch(previous));
                    }}
                    onRequestFilePathChange={(filePath) => {
                      commitEditorTarget({ filePath });
                    }}
                    requestedNavigation={requestedNavigation}
                    requestedSaveNonce={requestedSaveNonce}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center px-6 text-center">
                    <div className="max-w-sm space-y-2">
                      <p className="text-sm font-medium text-foreground">
                        Select a file to open it.
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Browse the workspace tree to inspect and edit project files without leaving
                        chat.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </DiffPanelShell>
  );
}
