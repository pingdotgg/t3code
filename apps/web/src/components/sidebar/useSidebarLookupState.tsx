import type { SidebarProps } from "./sidebarTypes";

import {
  readThreadShell,
  useAllEnvironmentProjectSnapshotsReady,
  useDelegatedUnderParent,
  useProjects,
  useServerConfigs,
  useQuietThreadShells,
} from "../../state/entities";
import { type AnyRouter, useRouter } from "@tanstack/react-router";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useBoringSidebarEnabled, useClientSettings } from "../../hooks/useSettings";
import {
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  canTurnThreadIntoProject,
  useAcknowledgeThreadWoke,
  useThreadActions,
} from "../../hooks/useThreadActions";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  AuthOrchestrationOperateScope,
  ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import {
  useEnvironmentIdentities,
  useConnectedEnvironmentIds,
  useEnvironmentConnectionSummaries,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../../threadSelectionStore";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import {
  applySidebarThreadDrop,
  filterSidebarV2VisibleThreads,
  groupSidebarThreadsByProject,
  sidebarFolderExpansionKeys,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  firstValidTimestampMs,
  belongsInSidebarWorkingShelf,
  isSidebarEnvironmentDisconnected,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  planSidebarThreadDrop,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  resolveSidebarThreadSection,
  resolveSidebarReorderableThreadKeys,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  sidebarListItemId,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  useSnoozeWakeClock,
  useThreadJumpHintsVisible,
  type SidebarListItem,
  type SidebarSection,
  resolveSidebarRowThreadId,
} from "../Sidebar.logic";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { environmentProjects } from "../../state/projects";
import { useSidebarPendingFileDropStore } from "../../sidebarPendingFileDropStore";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { createSidebarListMotion } from "../Sidebar.motion";
import { SidebarPointerSensor } from "../Sidebar.pointer";
import {
  SidebarSearchResultRow,
  SortableThreadRow,
  type SidebarProviderEntry,
  type SidebarSweepAction,
} from "./SidebarThreadRow";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { useTerminalFocus } from "../../hooks/useTerminalFocus";
import { isCommandPaletteOpen, openCommandPalette } from "../../commandPaletteBus";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../../threadRoutes";
import {
  projectGroupsSpanEnvironments,
  resolveSidebarProjectScopeKeys,
  getSidebarProjectSettingsKey,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  resolveSidebarRouteReveal,
  type SidebarRouteReveal,
  useActiveRowReveal,
} from "./routeReveal";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import type { SidebarThreadSummary } from "../../types";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { environmentPresentations } from "../../state/presentation";
import { deriveProviderEntriesByEnvironment } from "../../providerInstances";


function sameSidebarProviderEntries(
  left: ReadonlyMap<string, SidebarProviderEntry>,
  right: ReadonlyMap<string, SidebarProviderEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [instanceId, entry] of right) {
    const other = left.get(instanceId);
    if (
      other === undefined ||
      other.driverKind !== entry.driverKind ||
      other.enabled !== entry.enabled ||
      other.displayName !== entry.displayName ||
      other.accentColor !== entry.accentColor ||
      other.acpRegistryAgentId !== entry.acpRegistryAgentId ||
      other.acpRegistryIconUrl !== entry.acpRegistryIconUrl ||
      other.models !== entry.models
    ) {
      return false;
    }
  }
  return true;
}


// Resolve providers per environment because default instance ids collide across environments.
const sidebarProviderEntriesAtom = Atom.make((get) => {
  const providersByEnvironment = get(environmentPresentations.providersByEnvironmentAtom);
  const derived = deriveProviderEntriesByEnvironment(
    [...get(environmentPresentations.serverConfigsAtom)].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
  const previous = Option.getOrNull(
    get.self<ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>>(),
  );
  const next = new Map<string, ReadonlyMap<string, SidebarProviderEntry>>();
  let changed = previous === null || previous.size !== derived.size;
  for (const [environmentId, entries] of derived) {
    const prior = previous?.get(environmentId);
    if (prior !== undefined && sameSidebarProviderEntries(prior, entries)) {
      next.set(environmentId, prior);
    } else {
      next.set(environmentId, entries);
      changed = true;
    }
  }
  return !changed && previous !== null ? previous : next;
}).pipe(Atom.withLabel("sidebar-provider-entries"));


export type SidebarOptimisticDrop = {
  readonly key: string;
  readonly sourceSection: SidebarSection;
  readonly section: "pinned" | "active" | "settled";
  readonly occurredAt: string;
  readonly clearsSnooze: boolean;
  readonly order: readonly string[] | null;
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  readonly assignedKeys: ReadonlyMap<string, string>;
};


function scrollSidebarToTop(content: HTMLElement | null) {
  content?.closest("[data-slot=scroll-area-viewport]")?.scrollTo({ top: 0 });
}


export function threadShellKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}


function useSidebarLookups() {
  const projects = useProjects();
  const environments = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const projectGroups = useSidebarProjectGroups();
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const projectDisplayNameByKey = new Map(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
      ),
    ),
  );
  const projectGroupByScopeKey = new Map(
    projectGroups.map((project) => [project.projectKey, project] as const),
  );
  const projectScopeItems = [
    { value: "all", label: "All projects" },
    ...pickableProjectGroups(projectGroups).map((project) => ({
      value: project.projectKey,
      label: project.displayName,
    })),
  ];
  return {
    projects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
    projectGroupByScopeKey,
    projectScopeItems,
  };
}

export function useSidebarLookupState(props: SidebarProps) {
  const { routeReveal } = props;
    const {
      projects,
      serverConfigs,
      projectGroups,
      environmentLabelById,
      providerEntriesByEnvironment,
      projectByKey,
      projectDisplayNameByKey,
      projectGroupByScopeKey,
      projectScopeItems: lookupProjectScopeItems,
    } = useSidebarLookups();
    const delegatedUnderParent = useDelegatedUnderParent();
    const router = useRouter();
    const { isMobile, setOpenMobile } = useSidebar();
    const keybindings = useAtomValue(primaryServerKeybindingsAtom);
    const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
    const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
    const timestampFormat = useClientSettings((s) => s.timestampFormat);
    const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
    const {
      settleThread,
      unsettleThread,
      snoozeThread,
      unsnoozeThread,
      pinThread,
      unpinThread,
      confirmAndUnpinThread,
      setThreadAutoSettle,
      turnThreadIntoProject,
      reorderPinnedThread,
      reorderActiveThread,
      markThreadUnread,
      archiveThread,
      deleteThread,
    } = useThreadActions();
    const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
      reportFailure: false,
    });
    const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
      onCopy: ({ path }) => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: path,
        });
      },
      onError: (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    });
    const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
      target: "branch name",
      onCopy: ({ branch }) => {
        toastManager.add({
          type: "success",
          title: "Branch copied",
          description: branch,
        });
      },
      onError: (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy branch",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    });
    const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
      onCopy: ({ threadId }) => {
        toastManager.add({
          type: "success",
          title: "Thread ID copied",
          description: threadId,
        });
      },
      onError: (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy thread ID",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    });
    const boringSidebarEnabled = useBoringSidebarEnabled();
    const legacySidebarEnabled = useClientSettings((settings) => settings.legacySidebarEnabled);
    const folderRowsMultiline = useClientSettings((settings) => settings.boringSidebarMultilineRows);
    const newThreadContext = useHandleNewThread();
    // Row callbacks capture only the handler; the rest of the context changes with the route.
    const { handleNewThread } = newThreadContext;
    const primaryEnvironmentId = usePrimaryEnvironmentId();
    const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
    const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
    const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
    const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
    const acknowledgeWoke = useAcknowledgeThreadWoke();
    const routeTarget = useThreadRouteTarget();
    const routeDraftThread = useComposerDraftStore((store) =>
      routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
    );
    const environmentMachineById = useEnvironmentMachines();
    const projectGroupsRef = useRef(projectGroups);
    const persistedProjectScopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
    const setPersistedProjectScopeKeys = useUiStateStore((store) => store.setSidebarProjectScopeKeys);
    const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
      reduceSidebarProjectScopeMenuState,
      { open: false, query: "" },
    );
    const projectScopeFilter = useComboboxFilter();
    const allProjectSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
    const allProjectConfigsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
    // Safari may click after Ctrl+click opens settings; suppress that selection until the picker reopens.
    const suppressNextScopeChangeRef = useRef(false);
    const highlightedProjectScopeKeyRef = useRef<string | null>(null);
    // Hold dropped rows until server placement is confirmed; block another pickup from replacing the hold.
    const [optimisticDrop, setOptimisticDrop] = useState<SidebarOptimisticDrop | null>(null);
    const threadSearchInputRef = useRef<HTMLInputElement>(null);
    const [threadSearchQuery, setThreadSearchQuery] = useState("");
    const [searchHighlightKey, setSearchHighlightKey] = useState<string | null>(null);
    const connectedEnvironmentIds = useConnectedEnvironmentIds();
    const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
    const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
    const [renamingThreadRef, setRenamingThreadRef] = useState<ScopedThreadRef | null>(null);
    const canOperateRenamingThread = useEnvironmentScope(
      renamingThreadRef?.environmentId ?? null,
      AuthOrchestrationOperateScope,
    );
    // Losing operate access cancels the rename without committing the title, so
    // the editor does not return and take focus when access comes back.
    if (renamingThreadRef !== null && !canOperateRenamingThread) setRenamingThreadRef(null);
    const renamingThreadKey =
      renamingThreadRef !== null && canOperateRenamingThread
        ? scopedThreadKey(renamingThreadRef)
        : null;
    const [renamingTitle, setRenamingTitle] = useState("");
    const settlingThreadKeysRef = useRef(new Set<string>());
    const threadListRef = useRef<HTMLUListElement | null>(null);
    const sidebarContentRef = useRef<HTMLDivElement | null>(null);
    const dragLabelOffsetRef = useRef(0);
    const listMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
    const [dragState, setDragState] = useState<{
      readonly activeKey: string;
      readonly activeSection: SidebarSection;
      readonly occurredAt: string;
      readonly activationY: number | null;
      readonly targetSection: SidebarSection | null;
      readonly contextDrag: boolean;
    } | null>(null);
    const dragSensorRef = useRef<SidebarPointerSensor | null>(null);
    const contextDragKeyRef = useRef<string | null>(null);
    const [actionSweep, setActionSweep] = useState<{
      action: SidebarSweepAction;
      keys: ReadonlySet<string>;
    } | null>(null);
    const snoozingThreadKeysRef = useRef(new Set<string>());
    const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
    const shortcutModifiers = useShortcutModifierState();
    const terminalFocused = useTerminalFocus();
    const openAddProjectCommandPalette = () => openCommandPalette({ open: "add-project" });
    const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
    const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;

    // A selection made under one scope can hold threads the next scope hides.
    // The viewport outlives the scope and does not anchor, so a new list starts at the top.
    const setProjectScopeKeys = (keys: readonly string[]) => {
      clearSelection();
      setPersistedProjectScopeKeys(keys);
      scrollSidebarToTop(sidebarContentRef.current);
    };
    // A scope whose project is gone reads as all projects once every snapshot has
    // loaded. The stored keys are left alone, so the scope returns with its project.
    // An archived project's scope reads as all projects, matching the menu.
    const scopeGroups = pickableProjectGroups(projectGroups);
    const archivedProjectKeys = new Set(
      projectGroups.filter((project) => project.archived).map((project) => project.projectKey),
    );
    const chosenProjectScopeKeys = resolveSidebarProjectScopeKeys({
      groups: projectGroups,
      keys: persistedProjectScopeKeys,
      settings: projectGroupingSettings,
      canClearMissingScope: allProjectSnapshotsReady && allProjectConfigsReady,
    }).filter((key) => !archivedProjectKeys.has(key));
    const chosenProjectGroups = scopeGroups.filter((project) =>
      chosenProjectScopeKeys.includes(project.projectKey),
    );
    const chosenScopeProjectKeys =
      chosenProjectGroups.length === 0
        ? null
        : new Set(
            chosenProjectGroups.flatMap((project) =>
              project.memberProjectRefs.map(
                (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
              ),
            ),
          );
    const threads = useQuietThreadShells();
    const routeRowThreadKey =
      routeThreadRef === null
        ? null
        : scopedThreadKey(
            scopeThreadRef(
              routeThreadRef.environmentId,
              resolveSidebarRowThreadId(
                routeThreadRef.threadId,
                routeThreadRef.environmentId,
                threads,
              ),
            ),
          );
    const isSearchingThreads = threadSearchQuery.trim().length > 0;

    // History, the palette and links can open a thread the scope hides or the list
    // scrolled away; a remount starts at the top, so each mount scrolls to the open
    // thread once. Render decides the widening, so the first frame of the new route
    // already lists the row; the active row's ref callback scrolls to it.
    const { widensScope: revealWidensScope } = resolveSidebarRouteReveal({
      reveal: routeReveal,
      routeKey: routeRowThreadKey,
      isSearching: isSearchingThreads,
      scopedProjectKeys: chosenScopeProjectKeys,
      delegatedUnderParent,
      findThread: (key) => threads.find((candidate) => threadShellKey(candidate) === key),
    });
    const projectScopeKeys = revealWidensScope ? [] : chosenProjectScopeKeys;
    const projectScopeKey = projectScopeKeys.length === 0 ? null : projectScopeKeys.join("\n");
    const toggleProjectScopeKey = (key: string) =>
      setProjectScopeKeys(
        projectScopeKeys.includes(key)
          ? projectScopeKeys.filter((candidate) => candidate !== key)
          : [...projectScopeKeys, key],
      );

  return { projects, serverConfigs, projectGroups, environmentLabelById, providerEntriesByEnvironment, projectByKey, projectDisplayNameByKey, projectGroupByScopeKey, lookupProjectScopeItems, delegatedUnderParent, router, isMobile, setOpenMobile, keybindings, confirmThreadDelete, confirmThreadArchive, timestampFormat, projectGroupingSettings, settleThread, unsettleThread, snoozeThread, unsnoozeThread, pinThread, unpinThread, confirmAndUnpinThread, setThreadAutoSettle, turnThreadIntoProject, reorderPinnedThread, reorderActiveThread, markThreadUnread, archiveThread, deleteThread, updateThreadMetadata, copyPathToClipboard, copyBranchToClipboard, copyThreadIdToClipboard, boringSidebarEnabled, legacySidebarEnabled, folderRowsMultiline, newThreadContext, handleNewThread, primaryEnvironmentId, clearSelection, setSelectionAnchor, toggleThreadSelection, rangeSelectTo, acknowledgeWoke, routeTarget, environmentMachineById, projectGroupsRef, setPersistedProjectScopeKeys, projectScopeMenuState, dispatchProjectScopeMenu, projectScopeFilter, suppressNextScopeChangeRef, highlightedProjectScopeKeyRef, optimisticDrop, setOptimisticDrop, threadSearchInputRef, threadSearchQuery, setThreadSearchQuery, searchHighlightKey, setSearchHighlightKey, connectedEnvironmentIds, queuePendingFileDrop, clearPendingFileDrop, setRenamingThreadRef, renamingThreadKey, renamingTitle, setRenamingTitle, settlingThreadKeysRef, threadListRef, sidebarContentRef, dragLabelOffsetRef, listMotionRef, dragState, setDragState, dragSensorRef, contextDragKeyRef, actionSweep, setActionSweep, snoozingThreadKeysRef, removeFromSelection, shortcutModifiers, terminalFocused, openAddProjectCommandPalette, routeThreadRef, routeThreadKey, setProjectScopeKeys, scopeGroups, chosenProjectGroups, chosenScopeProjectKeys, threads, routeRowThreadKey, isSearchingThreads, revealWidensScope, projectScopeKeys, projectScopeKey, toggleProjectScopeKey };
}
