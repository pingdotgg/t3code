import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type {
  EnvironmentId,
  ProjectEntry,
  ProjectListEntriesResult,
  ScopedProjectRef,
} from "@forma/contracts";
import { scopeThreadRef } from "@forma/client-runtime";
import * as Schema from "effect/Schema";
import {
  IconArrowClockwise as RefreshIcon,
  IconEllipsis as EllipsisIcon,
  IconListBulletIndent as SidebarToggleIcon,
  IconMagnifyingglass as SearchIcon,
  IconPlusminus as DiffIcon,
  IconProgressIndicator as LoaderIcon,
  IconXmarkCircleFill as XIconCircle,
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
  buildWorkspacePanelClosedSearch,
  buildWorkspacePanelDiffSearch,
  buildWorkspacePanelEditorSearch,
  buildWorkspacePanelFilesSearch,
  buildWorkspacePanelSearchFromSnapshot,
  buildWorkspacePanelTerminalSearch,
  buildWorkspacePanelTurnSearch,
  parseWorkspacePanelRouteSearch,
  type WorkspacePanelRouteSearch,
} from "../workspacePanelRouteSearch";
import { openInPreferredEditor } from "../editorPreferences";
import { readEnvironmentApi } from "../environmentApi";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { type CodeContextSelection } from "../lib/codeContext";
import { resolveEditorFileLabel } from "../lib/editorFileLabel";
import {
  createProjectEntry,
  pathEqualsOrContainsParent,
  removeProjectListEntry,
  renameProjectListEntry,
  upsertProjectListEntry,
} from "../lib/projectExplorerEntries";
import {
  invalidateProjectFileForEditor,
  loadProjectFileForEditor,
  prefetchProjectFileForEditor,
  storeProjectFileForEditor,
} from "../lib/projectFileReadCache";
import {
  invalidateProjectEntryQueries,
  invalidateProjectQueries,
  projectQueryKeys,
  projectSearchEntriesQueryOptions,
} from "../lib/projectReactQuery";
import { checkpointDiffQueryOptions } from "../lib/providerReactQuery";
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
import { PersistentThreadTerminalPanel } from "./PersistentThreadTerminalPanel";
import { WorkspaceFilesTree } from "./WorkspaceFilesTree";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import {
  AddDocumentIcon,
  AddProjectFolderIcon,
  SidebarPanelIcon,
  TerminalToggleIcon,
} from "./icons/custom";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useBottomDrawerUiStore } from "../bottomDrawerUiStore";
import { usePreviewWorkspaceStore } from "../previewWorkspaceStore";
import { shortcutLabelForCommand } from "../keybindings";
import { primeRenderablePatchCache } from "../lib/diffPatchCache";
import {
  orderTurnDiffSummariesByCheckpoint,
  resolveLikelyDiffPrefetchTarget,
} from "../lib/diffSelection";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useGitStatus } from "../lib/gitStatusState";
import { scheduleIdleTask } from "../lib/idleTask";
import { useServerKeybindings } from "~/rpc/serverState";
import { useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";

const WORKSPACE_PANEL_TREE_COLLAPSED_KEY = "forma:workspace-panel-tree-collapsed:v1";
const WorkspacePanelTreeCollapsedSchema = Schema.Record(Schema.String, Schema.Boolean);

type WorkspaceSurfaceMode = "closed" | "files" | "editor" | "diff" | "terminal";
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

interface RequestedRootCreate {
  nonce: number;
  kind: Extract<ProjectEntry["kind"], "file" | "directory">;
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

function toAbsoluteWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "");
  const normalizedPath = relativePath.replaceAll("\\", "/");
  return `${normalizedRoot}/${normalizedPath}`;
}

function resolveWorkspaceRootLabel(workspaceRoot: string): string {
  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "");
  const segments = normalizedRoot.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalizedRoot;
}

function normalizeWorkspaceMutationError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An unexpected error occurred.";
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

function resolveSurfaceMode(search: WorkspacePanelRouteSearch): WorkspaceSurfaceMode {
  if (search.panel !== "1") {
    return "closed";
  }
  if (search.panelView === "files") {
    return "files";
  }
  if (search.panelView === "editor") {
    return "editor";
  }
  if (search.panelView === "terminal") {
    return "terminal";
  }
  return "diff";
}

function buildFilesSnapshot(search: WorkspacePanelRouteSearch): WorkspacePanelRouteSearch {
  return {
    panel: "1",
    ...(search.diffTurnId ? { diffTurnId: search.diffTurnId } : {}),
    ...(search.diffFilePath ? { diffFilePath: search.diffFilePath } : {}),
    panelView: "files",
  };
}

function buildEditorSnapshot(
  search: WorkspacePanelRouteSearch,
  target: EditorTarget,
): WorkspacePanelRouteSearch {
  const backToView = search.editorBackToView;
  return {
    panel: "1",
    ...(backToView === "diff" && search.diffTurnId ? { diffTurnId: search.diffTurnId } : {}),
    ...(backToView === "diff" && search.diffFilePath ? { diffFilePath: search.diffFilePath } : {}),
    panelView: "editor",
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
  const panelSearch = useSearch({
    strict: false,
    select: (search) => parseWorkspacePanelRouteSearch(search),
  });
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
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(activeThreadRef), [activeThreadRef]),
  );
  const bottomDrawerMode = useBottomDrawerUiStore((state) => state.visibleMode);
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
  const panelOpen = panelSearch.panel === "1";
  const surfaceMode = resolveSurfaceMode(panelSearch);
  const gitStatus = useGitStatus({
    environmentId: activeThread?.environmentId ?? null,
    cwd: workspaceRoot,
  });
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      orderTurnDiffSummariesByCheckpoint(turnDiffSummaries, inferredCheckpointTurnCountByTurnId),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );
  const likelyDiffPrefetchTarget = useMemo(
    () =>
      resolveLikelyDiffPrefetchTarget({
        orderedTurnDiffSummaries,
        inferredCheckpointTurnCountByTurnId,
        diffSearch: panelSearch,
        environmentId: activeThread?.environmentId ?? null,
        threadId: activeThread?.id ?? null,
      }),
    [
      activeThread?.environmentId,
      activeThread?.id,
      panelSearch,
      inferredCheckpointTurnCountByTurnId,
      orderedTurnDiffSummaries,
    ],
  );
  const routeEditorTarget = useMemo(
    () =>
      resolveRouteEditorTarget({
        editorFilePath: panelSearch.editorFilePath,
        editorLine: panelSearch.editorLine,
        editorColumn: panelSearch.editorColumn,
      }),
    [panelSearch.editorColumn, panelSearch.editorFilePath, panelSearch.editorLine],
  );
  const routeEditorTargetKey = useMemo(
    () => buildEditorTargetKey(routeEditorTarget),
    [routeEditorTarget],
  );
  const [activeEditorTarget, setActiveEditorTarget] = useState<EditorTarget | null>(
    () => routeEditorTarget,
  );
  const [editorLineNumbersVisible, setEditorLineNumbersVisible] = useState(true);
  const [editorWordWrapEnabled, setEditorWordWrapEnabled] = useState(false);
  const [editorAutoSaveEnabled, setEditorAutoSaveEnabled] = useState(false);
  const [editorControlsState, setEditorControlsState] =
    useState<WorkspaceEditorControlsState | null>(null);
  const [requestedSaveNonce, setRequestedSaveNonce] = useState(0);
  const [requestedDiscardNonce, setRequestedDiscardNonce] = useState(0);
  const requestedNavigationNonceRef = useRef(0);
  const [requestedNavigation, setRequestedNavigation] =
    useState<DiffFileEditorRequestedNavigation | null>(null);
  const requestedRootCreateNonceRef = useRef(0);
  const [requestedRootCreate, setRequestedRootCreate] = useState<RequestedRootCreate | null>(null);
  const [sidebarSearchVisible, setSidebarSearchVisible] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const deferredSidebarSearchQuery = useDeferredValue(sidebarSearchQuery.trim());
  const sidebarSearchInputRef = useRef<HTMLInputElement | null>(null);
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
  const lastNonDiffSnapshotRef = useRef<WorkspacePanelRouteSearch | null>(
    panelSearch.panelView === "editor" && routeEditorTarget
      ? buildEditorSnapshot(panelSearch, routeEditorTarget)
      : panelSearch.panelView === "files"
        ? buildFilesSnapshot(panelSearch)
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
  const terminalOpen = surfaceMode === "terminal";
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
  const canDiscardEditorChanges =
    editorVisible &&
    editorFilePath !== null &&
    editorControlsState?.filePath === editorFilePath &&
    editorControlsState.isDirty;
  const editorSessionKey = workspaceRoot ? `workspace-surface:${panelKey}` : undefined;
  const workspaceRootLabel = workspaceRoot ? resolveWorkspaceRootLabel(workspaceRoot) : null;
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("split");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const previousDiffVisibleRef = useRef(surfaceMode === "diff");
  const diffRenderCacheScope = useMemo(
    () =>
      likelyDiffPrefetchTarget
        ? `diff-panel:${resolvedTheme}:${likelyDiffPrefetchTarget.cacheScope}`
        : null,
    [likelyDiffPrefetchTarget, resolvedTheme],
  );
  const { copyToClipboard: copyWorkspacePathToClipboard } = useCopyToClipboard<{
    description: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.description,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: normalizeWorkspaceMutationError(error),
      });
    },
  });

  useLayoutEffect(() => {
    const openedIntoFilesView =
      panelOpen && !wasPanelOpenRef.current && panelSearch.panelView === "files";
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
  }, [panelSearch.panelView, panelOpen, routeEditorTarget, routeEditorTargetKey]);

  useEffect(() => {
    if (panelSearch.panel !== "1") {
      return;
    }
    if (surfaceMode === "files") {
      lastNonDiffSnapshotRef.current = buildFilesSnapshot(panelSearch);
      return;
    }
    if (surfaceMode === "editor" && activeEditorTarget) {
      lastNonDiffSnapshotRef.current = buildEditorSnapshot(panelSearch, activeEditorTarget);
    }
  }, [activeEditorTarget, panelSearch, surfaceMode]);

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

  const warmLikelyDiff = useCallback(() => {
    if (
      !supportsDiff ||
      !workspaceRoot ||
      !panelOpen ||
      surfaceMode === "diff" ||
      gitStatus.data?.isRepo !== true ||
      orderedTurnDiffSummaries.length === 0 ||
      !likelyDiffPrefetchTarget
    ) {
      return;
    }

    void queryClient
      .fetchQuery(
        checkpointDiffQueryOptions({
          environmentId: likelyDiffPrefetchTarget.environmentId,
          threadId: likelyDiffPrefetchTarget.threadId,
          fromTurnCount: likelyDiffPrefetchTarget.fromTurnCount,
          toTurnCount: likelyDiffPrefetchTarget.toTurnCount,
          cacheScope: likelyDiffPrefetchTarget.cacheScope,
          enabled: true,
        }),
      )
      .then((result) => {
        if (!diffRenderCacheScope) {
          return;
        }
        const patch = result?.diff;
        if (typeof patch !== "string") {
          return;
        }
        scheduleIdleTask(() => {
          primeRenderablePatchCache(patch, diffRenderCacheScope);
        });
      })
      .catch(() => undefined);
  }, [
    diffRenderCacheScope,
    gitStatus.data?.isRepo,
    likelyDiffPrefetchTarget,
    orderedTurnDiffSummaries.length,
    panelOpen,
    queryClient,
    supportsDiff,
    surfaceMode,
    workspaceRoot,
  ]);

  useEffect(() => {
    if (
      !supportsDiff ||
      !workspaceRoot ||
      !panelOpen ||
      surfaceMode === "diff" ||
      gitStatus.data?.isRepo !== true ||
      orderedTurnDiffSummaries.length === 0 ||
      !likelyDiffPrefetchTarget
    ) {
      return;
    }

    return scheduleIdleTask(() => {
      warmLikelyDiff();
    });
  }, [
    gitStatus.data?.isRepo,
    likelyDiffPrefetchTarget,
    orderedTurnDiffSummaries.length,
    panelOpen,
    supportsDiff,
    surfaceMode,
    warmLikelyDiff,
    workspaceRoot,
  ]);

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
    if (!treeCollapsed) {
      setSidebarSearchVisible(false);
      setSidebarSearchQuery("");
    }
  }, [setTreeCollapsedByWorkspace, treeCollapsed, workspaceRoot]);

  const toggleSidebarSearchVisible = useCallback(() => {
    if (!workspaceRoot) {
      return;
    }

    if (treeCollapsed) {
      setTreeCollapsedByWorkspace((current) => ({
        ...current,
        [workspaceRoot]: false,
      }));
      setSidebarSearchVisible(true);
      return;
    }

    setSidebarSearchVisible((current) => {
      const nextVisible = !current;
      if (!nextVisible) {
        setSidebarSearchQuery("");
      }
      return nextVisible;
    });
  }, [setTreeCollapsedByWorkspace, treeCollapsed, workspaceRoot]);

  useEffect(() => {
    if (!sidebarSearchVisible) {
      return;
    }

    sidebarSearchInputRef.current?.focus();
  }, [sidebarSearchVisible]);

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

  const addWorkspaceFileToChatContext = useCallback(
    async (filePath: string) => {
      if (!workspaceRoot) {
        return;
      }
      try {
        const result = await loadProjectFileForEditor({
          environmentId,
          cwd: workspaceRoot,
          relativePath: filePath,
        });
        addEditorCodeContext({
          filePath,
          lineStart: 1,
          lineEnd: 1,
          text: result.contents,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to attach file",
          description: error instanceof Error ? error.message : "Unable to read file contents.",
        });
      }
    },
    [addEditorCodeContext, environmentId, workspaceRoot],
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
    navigateToCurrentRoute((previous) => buildWorkspacePanelClosedSearch(previous));
  }, [navigateToCurrentRoute]);

  const restoreDiffRoute = useCallback(() => {
    navigateToCurrentRoute((previous) => {
      if (panelSearch.diffTurnId) {
        return buildWorkspacePanelTurnSearch(previous, {
          turnId: panelSearch.diffTurnId,
          ...(panelSearch.diffFilePath ? { filePath: panelSearch.diffFilePath } : {}),
        });
      }
      return buildWorkspacePanelDiffSearch(previous);
    });
  }, [navigateToCurrentRoute, panelSearch.diffFilePath, panelSearch.diffTurnId]);

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

  const patchDirectoryEntriesIfLoaded = useCallback(
    (
      relativePath: string | null,
      update: (current: ProjectListEntriesResult | undefined) => ProjectListEntriesResult,
    ) => {
      if (!workspaceRoot) {
        return;
      }
      const queryKey = projectQueryKeys.listEntries(environmentId, workspaceRoot, relativePath);
      if (queryClient.getQueryData(queryKey) === undefined) {
        return;
      }
      queryClient.setQueryData(queryKey, update);
    },
    [environmentId, queryClient, workspaceRoot],
  );

  const syncEditorPathAfterRename = useCallback(
    (fromPath: string, toPath: string) => {
      setActiveEditorTarget((current) =>
        current && pathEqualsOrContainsParent(fromPath, current.filePath)
          ? {
              ...current,
              filePath: `${toPath}${current.filePath.slice(fromPath.length)}`,
            }
          : current,
      );

      if (
        !panelSearch.editorFilePath ||
        !pathEqualsOrContainsParent(fromPath, panelSearch.editorFilePath)
      ) {
        return;
      }

      const nextEditorFilePath = `${toPath}${panelSearch.editorFilePath.slice(fromPath.length)}`;
      navigateToCurrentRoute((previous) => ({
        ...previous,
        panel: "1",
        panelView: "editor",
        editorFilePath: nextEditorFilePath,
        ...(typeof panelSearch.editorLine === "number"
          ? { editorLine: panelSearch.editorLine }
          : {}),
        ...(typeof panelSearch.editorColumn === "number"
          ? { editorColumn: panelSearch.editorColumn }
          : {}),
        ...(panelSearch.editorBackToView ? { editorBackToView: panelSearch.editorBackToView } : {}),
      }));
      if (surfaceMode === "editor") {
        issueNavigationRequest("switch-file", { filePath: nextEditorFilePath });
      }
    },
    [
      panelSearch.editorBackToView,
      panelSearch.editorColumn,
      panelSearch.editorFilePath,
      panelSearch.editorLine,
      issueNavigationRequest,
      navigateToCurrentRoute,
      surfaceMode,
    ],
  );

  const requestRootCreate = useCallback(
    (kind: Extract<ProjectEntry["kind"], "file" | "directory">) => {
      if (sidebarSearchVisible || sidebarSearchActive) {
        setSidebarSearchVisible(false);
        setSidebarSearchQuery("");
      }
      requestedRootCreateNonceRef.current += 1;
      setRequestedRootCreate({
        nonce: requestedRootCreateNonceRef.current,
        kind,
      });
    },
    [sidebarSearchActive, sidebarSearchVisible],
  );

  const refreshWorkspaceTree = useCallback(() => {
    if (!workspaceRoot) {
      return;
    }
    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listEntriesScope(environmentId, workspaceRoot),
      }),
      queryClient.invalidateQueries({
        queryKey: projectQueryKeys.searchEntriesScope(environmentId, workspaceRoot),
      }),
    ]);
  }, [environmentId, queryClient, workspaceRoot]);

  const copyRelativeWorkspacePath = useCallback(
    (entry: ProjectEntry) => {
      copyWorkspacePathToClipboard(entry.path, { description: entry.path });
    },
    [copyWorkspacePathToClipboard],
  );

  const copyAbsoluteWorkspacePath = useCallback(
    (entry: ProjectEntry) => {
      if (!workspaceRoot) {
        return;
      }
      copyWorkspacePathToClipboard(toAbsoluteWorkspacePath(workspaceRoot, entry.path), {
        description: entry.path,
      });
    },
    [copyWorkspacePathToClipboard, workspaceRoot],
  );

  const openWorkspaceEntryInEditor = useCallback(
    (entry: ProjectEntry) => {
      openWorkspaceFileInEditor(entry.path);
    },
    [openWorkspaceFileInEditor],
  );

  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef) {
      return;
    }
    if (surfaceMode === "terminal") {
      navigateToCurrentRoute((previous) => buildWorkspacePanelFilesSearch(previous));
      return;
    }
    if (!terminalState.terminalOpen) {
      setTerminalOpen(activeThreadRef, true);
    }
    navigateToCurrentRoute((previous) => buildWorkspacePanelTerminalSearch(previous));
  }, [
    activeThreadRef,
    navigateToCurrentRoute,
    setTerminalOpen,
    surfaceMode,
    terminalState.terminalOpen,
  ]);

  const showEditorSurface = useCallback(() => {
    navigateToCurrentRoute((previous) => {
      if (!activeEditorTarget?.filePath) {
        return buildWorkspacePanelFilesSearch(previous);
      }
      return buildWorkspacePanelEditorSearch(previous, {
        filePath: activeEditorTarget.filePath,
        ...(typeof activeEditorTarget.line === "number" ? { line: activeEditorTarget.line } : {}),
        ...(typeof activeEditorTarget.column === "number"
          ? { column: activeEditorTarget.column }
          : {}),
      });
    });
  }, [activeEditorTarget, navigateToCurrentRoute]);

  const closeTerminalPanel = useCallback(() => {
    navigateToCurrentRoute((previous) => buildWorkspacePanelFilesSearch(previous));
  }, [navigateToCurrentRoute]);

  const openDiffRoute = useCallback(() => {
    if (!supportsDiff) {
      return;
    }
    navigateToCurrentRoute((previous) => {
      if (panelSearch.diffTurnId) {
        return buildWorkspacePanelTurnSearch(previous, {
          turnId: panelSearch.diffTurnId,
          ...(panelSearch.diffFilePath ? { filePath: panelSearch.diffFilePath } : {}),
        });
      }
      return buildWorkspacePanelDiffSearch(previous);
    });
  }, [navigateToCurrentRoute, panelSearch.diffFilePath, panelSearch.diffTurnId, supportsDiff]);

  const restoreLastNonDiffView = useCallback(() => {
    navigateToCurrentRoute((previous) =>
      buildWorkspacePanelSearchFromSnapshot(
        previous,
        lastNonDiffSnapshotRef.current ?? { panel: "1", panelView: "files" },
      ),
    );
  }, [navigateToCurrentRoute]);

  const showDiffFromEditor = useCallback(() => {
    if (!supportsDiff || !activeEditorTarget) {
      return;
    }
    lastNonDiffSnapshotRef.current = buildEditorSnapshot(panelSearch, activeEditorTarget);
    openDiffRoute();
  }, [activeEditorTarget, openDiffRoute, panelSearch, supportsDiff]);

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
    lastNonDiffSnapshotRef.current = buildFilesSnapshot(panelSearch);
    openDiffRoute();
  }, [
    issueNavigationRequest,
    openDiffRoute,
    panelSearch,
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
        buildWorkspacePanelEditorSearch(previous, {
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

  const createWorkspaceEntry = useCallback(
    async (input: {
      kind: Extract<ProjectEntry["kind"], "file" | "directory">;
      relativePath: string;
    }) => {
      if (!workspaceRoot) {
        throw new Error("Workspace root is unavailable.");
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        throw new Error("Environment connection is unavailable.");
      }

      const entry = createProjectEntry(input.relativePath, input.kind);
      const parentPath = entry.parentPath ?? null;
      patchDirectoryEntriesIfLoaded(parentPath, (current) =>
        upsertProjectListEntry(current, entry),
      );

      try {
        if (input.kind === "directory") {
          await api.projects.createDirectory({
            cwd: workspaceRoot,
            relativePath: input.relativePath,
          });
        } else {
          const result = await api.projects.writeFile({
            cwd: workspaceRoot,
            relativePath: input.relativePath,
            contents: "",
            expectedVersion: null,
          });
          storeProjectFileForEditor({
            environmentId,
            cwd: workspaceRoot,
            relativePath: input.relativePath,
            result: {
              relativePath: input.relativePath,
              contents: "",
              version: result.version,
            },
          });
          selectFile(input.relativePath);
        }

        void invalidateProjectEntryQueries(queryClient, {
          environmentId,
          cwd: workspaceRoot,
          relativePaths: [input.relativePath],
        });
        toastManager.add({
          type: "success",
          title: input.kind === "directory" ? "Folder created" : "File created",
          description: input.relativePath,
        });
        return { path: input.relativePath, kind: input.kind } as const;
      } catch (error) {
        void invalidateProjectEntryQueries(queryClient, {
          environmentId,
          cwd: workspaceRoot,
          relativePaths: [input.relativePath],
        });
        toastManager.add({
          type: "error",
          title: input.kind === "directory" ? "Unable to create folder" : "Unable to create file",
          description: normalizeWorkspaceMutationError(error),
        });
        throw error;
      }
    },
    [environmentId, patchDirectoryEntriesIfLoaded, queryClient, selectFile, workspaceRoot],
  );

  const renameWorkspaceEntry = useCallback(
    async (input: { entry: ProjectEntry; nextRelativePath: string }) => {
      if (!workspaceRoot) {
        throw new Error("Workspace root is unavailable.");
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        throw new Error("Environment connection is unavailable.");
      }

      const nextEntry = createProjectEntry(input.nextRelativePath, input.entry.kind);
      const sourceParentPath = input.entry.parentPath ?? null;
      const destinationParentPath = nextEntry.parentPath ?? null;

      patchDirectoryEntriesIfLoaded(sourceParentPath, (current) =>
        sourceParentPath === destinationParentPath
          ? renameProjectListEntry(current, {
              fromPath: input.entry.path,
              toEntry: nextEntry,
            })
          : removeProjectListEntry(current, input.entry.path),
      );
      if (sourceParentPath !== destinationParentPath) {
        patchDirectoryEntriesIfLoaded(destinationParentPath, (current) =>
          upsertProjectListEntry(current, nextEntry),
        );
      }

      try {
        const result = await api.projects.renameEntry({
          cwd: workspaceRoot,
          fromRelativePath: input.entry.path,
          toRelativePath: input.nextRelativePath,
        });

        invalidateProjectFileForEditor({
          environmentId,
          cwd: workspaceRoot,
          relativePath: input.entry.path,
        });
        syncEditorPathAfterRename(input.entry.path, input.nextRelativePath);
        void invalidateProjectEntryQueries(queryClient, {
          environmentId,
          cwd: workspaceRoot,
          relativePaths: [input.entry.path, input.nextRelativePath],
        });
        toastManager.add({
          type: "success",
          title: result.kind === "directory" ? "Folder renamed" : "File renamed",
          description: result.toRelativePath,
        });
        return {
          fromPath: result.fromRelativePath,
          toPath: result.toRelativePath,
          kind: result.kind,
        } as const;
      } catch (error) {
        void invalidateProjectEntryQueries(queryClient, {
          environmentId,
          cwd: workspaceRoot,
          relativePaths: [input.entry.path, input.nextRelativePath],
        });
        toastManager.add({
          type: "error",
          title: "Unable to rename path",
          description: normalizeWorkspaceMutationError(error),
        });
        throw error;
      }
    },
    [
      environmentId,
      patchDirectoryEntriesIfLoaded,
      queryClient,
      syncEditorPathAfterRename,
      workspaceRoot,
    ],
  );

  const deleteWorkspaceEntry = useCallback(
    async (entry: ProjectEntry) => {
      if (!workspaceRoot) {
        throw new Error("Workspace root is unavailable.");
      }
      const api = readEnvironmentApi(environmentId);
      const localApi = readLocalApi();
      if (!api || !localApi) {
        throw new Error("Environment connection is unavailable.");
      }

      const openEditorPath = activeEditorTarget?.filePath ?? null;
      if (
        editorControlsState?.isDirty &&
        editorControlsState.filePath &&
        pathEqualsOrContainsParent(entry.path, editorControlsState.filePath)
      ) {
        toastManager.add({
          type: "error",
          title: "Save or close the file first",
          description: editorControlsState.filePath,
        });
        throw new Error("Cannot delete a path containing the dirty editor file.");
      }

      const confirmed = await localApi.dialogs.confirm(
        entry.kind === "directory"
          ? `Delete folder '${entry.path}'?`
          : `Delete file '${entry.path}'?`,
      );
      if (!confirmed) {
        throw new Error("Delete cancelled.");
      }

      patchDirectoryEntriesIfLoaded(entry.parentPath ?? null, (current) =>
        removeProjectListEntry(current, entry.path),
      );

      try {
        await api.projects.deleteEntry({
          cwd: workspaceRoot,
          relativePath: entry.path,
          recursive: entry.kind === "directory",
        });

        invalidateProjectFileForEditor({
          environmentId,
          cwd: workspaceRoot,
          relativePath: entry.path,
        });
        if (openEditorPath && pathEqualsOrContainsParent(entry.path, openEditorPath)) {
          setActiveEditorTarget(null);
          navigateToCurrentRoute((previous) => buildWorkspacePanelFilesSearch(previous));
        }
        void invalidateProjectEntryQueries(queryClient, {
          environmentId,
          cwd: workspaceRoot,
          relativePaths: [entry.path],
        });
        toastManager.add({
          type: "success",
          title: entry.kind === "directory" ? "Folder deleted" : "File deleted",
          description: entry.path,
        });
      } catch (error) {
        void invalidateProjectEntryQueries(queryClient, {
          environmentId,
          cwd: workspaceRoot,
          relativePaths: [entry.path],
        });
        toastManager.add({
          type: "error",
          title: "Unable to delete path",
          description: normalizeWorkspaceMutationError(error),
        });
        throw error;
      }
    },
    [
      activeEditorTarget?.filePath,
      editorControlsState?.filePath,
      editorControlsState?.isDirty,
      environmentId,
      navigateToCurrentRoute,
      patchDirectoryEntriesIfLoaded,
      queryClient,
      workspaceRoot,
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
          <div className="flex h-[38px] shrink-0 items-center gap-2 px-2.5 py-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <HeaderIconActionButton
                    pressed={surfaceMode === "files" || surfaceMode === "editor"}
                    onClick={showEditorSurface}
                    aria-label="Show editor panel"
                    title="Show editor panel"
                  >
                    <SidebarPanelIcon className="size-4" />
                  </HeaderIconActionButton>
                }
              />
              <TooltipPopup side="bottom">Show editor panel</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <HeaderIconActionButton
                    pressed={terminalOpen}
                    onClick={toggleTerminalVisibility}
                    aria-label="Toggle terminal panel"
                    title="Toggle terminal panel"
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
                    ? `Toggle terminal panel (${terminalToggleShortcutLabel})`
                    : "Toggle terminal panel"}
              </TooltipPopup>
            </Tooltip>
            {supportsDiff ? (
              <HeaderIconActionButton
                className="shrink-0"
                pressed={surfaceMode === "diff"}
                onClick={toggleDiffMode}
                onPointerEnter={warmLikelyDiff}
                onPointerDown={warmLikelyDiff}
                onFocus={warmLikelyDiff}
                aria-label="Toggle diff view"
                title="Toggle diff view"
              >
                <DiffIcon className="size-3 fill-current" />
              </HeaderIconActionButton>
            ) : null}
            <div className="min-w-0 flex-1" />
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
              <SidebarPanelIcon className="size-4 rotate-180" />
            </HeaderIconActionButton>
          </div>
          <div className="border-b border-border/70" />
          {surfaceMode === "diff" || surfaceMode === "terminal" ? null : (
            <>
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
                <div className="flex min-w-0 items-center gap-1">
                  <HeaderIconActionButton
                    onClick={toggleTreeCollapsed}
                    pressed={!treeCollapsed}
                    aria-label={treeCollapsed ? "Show editor sidebar" : "Hide editor sidebar"}
                    title={treeCollapsed ? "Show editor sidebar" : "Hide editor sidebar"}
                  >
                    <SidebarToggleIcon className="size-3.5" />
                  </HeaderIconActionButton>
                  <HeaderIconActionButton
                    onClick={toggleSidebarSearchVisible}
                    pressed={sidebarSearchVisible}
                    aria-label={sidebarSearchVisible ? "Hide file search" : "Search files"}
                    title={sidebarSearchVisible ? "Hide file search" : "Search files"}
                  >
                    <SearchIcon className="size-3 fill-current" />
                  </HeaderIconActionButton>
                </div>
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
                      <Button
                        size="xs"
                        variant="outline"
                        className="shrink-0 cursor-pointer gap-1.5 rounded-full px-2"
                        onClick={() => openPreviewForFile(editorFilePath)}
                        disabled={activeFilePreviewDisabledReason !== null}
                        title={
                          activeFilePreviewDisabledReason ??
                          (activeFilePreviewOpen ? "Close preview" : "Open preview")
                        }
                      >
                        {activeFilePreviewOpen ? "Previewing" : "Preview"}
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Menu>
                    <MenuTrigger
                      render={
                        <HeaderIconActionButton aria-label="Editor options" title="Editor options">
                          <EllipsisIcon className="size-3 fill-current rotate-90" />
                        </HeaderIconActionButton>
                      }
                    />
                    <MenuPopup align="end" className="w-64">
                      <MenuItem
                        disabled={!canTriggerSave}
                        onClick={() => {
                          setRequestedSaveNonce((current) => current + 1);
                        }}
                      >
                        Save File
                        <MenuShortcut>⌘S</MenuShortcut>
                      </MenuItem>
                      <MenuItem
                        disabled={!canDiscardEditorChanges}
                        onClick={() => {
                          setRequestedDiscardNonce((current) => current + 1);
                        }}
                      >
                        Discard Changes
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        disabled={!editorFilePath}
                        onClick={() => {
                          if (!editorFilePath) {
                            return;
                          }
                          copyRelativeWorkspacePath({
                            path: editorFilePath,
                            kind: "file",
                            parentPath: resolveParentDirectoryLabel(editorFilePath) ?? undefined,
                          });
                        }}
                      >
                        Copy Relative Path
                      </MenuItem>
                      <MenuSeparator />
                      <MenuCheckboxItem
                        checked={editorLineNumbersVisible}
                        onCheckedChange={(checked) => {
                          setEditorLineNumbersVisible(Boolean(checked));
                        }}
                        variant="switch"
                      >
                        Line Numbers
                      </MenuCheckboxItem>
                      <MenuCheckboxItem
                        checked={editorWordWrapEnabled}
                        onCheckedChange={(checked) => {
                          setEditorWordWrapEnabled(Boolean(checked));
                        }}
                        variant="switch"
                      >
                        Word Wrap
                      </MenuCheckboxItem>
                      <MenuCheckboxItem
                        checked={editorAutoSaveEnabled}
                        onCheckedChange={(checked) => {
                          setEditorAutoSaveEnabled(Boolean(checked));
                        }}
                        variant="switch"
                      >
                        Auto Save
                      </MenuCheckboxItem>
                    </MenuPopup>
                  </Menu>
                </div>
              </div>
            </>
          )}
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
          ) : surfaceMode === "terminal" && activeThreadRef ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <PersistentThreadTerminalPanel
                threadRef={activeThreadRef}
                threadId={activeThreadRef.threadId}
                onClosePanel={closeTerminalPanel}
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
                    {sidebarSearchVisible ? (
                      <div className="border-b border-border/60 px-2 py-2">
                        <div className="relative">
                          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 fill-muted-foreground/70" />
                          <Input
                            ref={sidebarSearchInputRef}
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
                    ) : null}
                    <ScrollArea className="min-h-0 flex-1 px-1.5 py-2">
                      {sidebarSearchVisible ? (
                        searchEntriesQuery.isLoading ? (
                          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                            <LoaderIcon className="size-3 animate-spin" />
                            Searching files…
                          </div>
                        ) : sidebarSearchActive && searchedFileEntries.length === 0 ? (
                          <div className="px-2 py-2 text-xs text-muted-foreground">
                            No matching files.
                          </div>
                        ) : !sidebarSearchActive ? (
                          <div className="px-2 py-2 text-xs text-muted-foreground">
                            Type to search this project.
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
                                    <span className="text-code-compact block truncate text-muted-foreground/90 group-hover:text-foreground/90">
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
                        <div className="space-y-2">
                          <div className="group/header flex items-center gap-2 px-2 py-1">
                            <div className="min-w-0 flex-1" title={workspaceRoot}>
                              <div className="text-ui-xs truncate font-medium text-foreground/90">
                                {workspaceRootLabel}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/header:opacity-100 group-focus-within/header:opacity-100">
                              <HeaderIconActionButton
                                aria-label="New file"
                                title="New file"
                                onClick={() => requestRootCreate("file")}
                              >
                                <AddDocumentIcon className="size-3 fill-current" />
                              </HeaderIconActionButton>
                              <HeaderIconActionButton
                                aria-label="New folder"
                                title="New folder"
                                onClick={() => requestRootCreate("directory")}
                              >
                                <AddProjectFolderIcon className="h-3 w-[13.5px]" />
                              </HeaderIconActionButton>
                              <HeaderIconActionButton
                                aria-label="Refresh files"
                                title="Refresh files"
                                onClick={refreshWorkspaceTree}
                              >
                                <RefreshIcon className="size-3 fill-current" />
                              </HeaderIconActionButton>
                            </div>
                          </div>
                          <WorkspaceFilesTree
                            cwd={workspaceRoot}
                            environmentId={environmentId}
                            sessionKey={`${panelKey}:${workspaceRoot}`}
                            requestedRootCreate={requestedRootCreate}
                            resolvedTheme={resolvedTheme}
                            selectedFilePath={activeEditorTarget?.filePath ?? null}
                            onAddFileToChatContext={addWorkspaceFileToChatContext}
                            onCreateEntry={createWorkspaceEntry}
                            onRenameEntry={renameWorkspaceEntry}
                            onDeleteEntry={deleteWorkspaceEntry}
                            onCopyRelativePath={copyRelativeWorkspacePath}
                            onCopyAbsolutePath={copyAbsoluteWorkspacePath}
                            onOpenInExternalEditor={openWorkspaceEntryInEditor}
                            onRefresh={refreshWorkspaceTree}
                            onSelectFile={selectFile}
                          />
                        </div>
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
                      if (panelSearch.editorBackToView === "files") {
                        navigateToCurrentRoute((previous) =>
                          buildWorkspacePanelFilesSearch(previous),
                        );
                        return;
                      }
                      if (panelSearch.editorBackToView === "diff") {
                        restoreDiffRoute();
                        return;
                      }
                      navigateToCurrentRoute((previous) =>
                        buildWorkspacePanelClosedSearch(previous),
                      );
                    }}
                    onRequestFilePathChange={(filePath) => {
                      commitEditorTarget({ filePath });
                    }}
                    requestedNavigation={requestedNavigation}
                    requestedSaveNonce={requestedSaveNonce}
                    requestedDiscardNonce={requestedDiscardNonce}
                    lineNumbersVisible={editorLineNumbersVisible}
                    wordWrapEnabled={editorWordWrapEnabled}
                    autoSaveEnabled={editorAutoSaveEnabled}
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
