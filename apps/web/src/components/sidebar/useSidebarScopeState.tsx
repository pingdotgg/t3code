import type { SidebarProps } from "./sidebarTypes";
import { useSidebarLookupState } from "./useSidebarLookupState";

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
import {
  resolveSidebarRouteReveal,
  type SidebarRouteReveal,
  useActiveRowReveal,
} from "./routeReveal";
import {
  projectGroupsSpanEnvironments,
  resolveSidebarProjectScopeKeys,
  getSidebarProjectSettingsKey,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useOrderWhileOpen } from "../../hooks/useOrderWhileOpen";
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
import { useThreadSearch } from "../../state/queries";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { type EnvironmentId, type ScopedProjectRef } from "@t3tools/contracts";
import { useProjectPin } from "../../hooks/useProjectGroupUpdate";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { readLocalApi } from "../../localApi";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useSidebarThreads } from "../SidebarParts";
import {
  nextShownOrder,
  threadSearchMatchKey,
  threadSearchSubject,
  type ShownOrder,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankMessageMatches } from "@t3tools/shared/paletteSearch";
export function useSidebarScopeState(props: SidebarProps, params: {
  s1: ReturnType<typeof useSidebarLookupState>,
  }) {
  const { s1 } = params;
  const { routeReveal } = props;
  const { revealWidensScope, clearSelection, setPersistedProjectScopeKeys, routeRowThreadKey, projectGroups, projectByKey, serverConfigs, environmentLabelById, lookupProjectScopeItems, projectScopeMenuState, projectScopeKeys, projectScopeFilter, chosenProjectGroups, chosenScopeProjectKeys, connectedEnvironmentIds, threadSearchQuery, routeTarget, isMobile, setOpenMobile, router, projectGroupingSettings, projects, suppressNextScopeChangeRef, dispatchProjectScopeMenu, handleNewThread, copyPathToClipboard, projectScopeKey, optimisticDrop, threads, delegatedUnderParent, boringSidebarEnabled, scopeGroups } = s1;
    // The widened scope outlives the reveal, so it is written back to the persisted
    // scope. Route changes arrive from history, links and the palette, and only this
    // component holds the project groups that decide a widening, so no single
    // navigation handler can make the write.
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes a route reveal's widened project scope back to the persisted sidebar scope and clears selection
    useEffect(() => {
      if (!revealWidensScope) return;
      clearSelection();
      setPersistedProjectScopeKeys([]);
    }, [clearSelection, revealWidensScope, setPersistedProjectScopeKeys]);
    const revealActiveRow = useActiveRowReveal(routeReveal, routeRowThreadKey);
    const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
    const scratchMachineLabelFor = (
      thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">,
    ) => {
      if (!showProjectEnvironments) return null;
      const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
      if (
        !project ||
        !isScratchProject(project, serverConfigs.get(thread.environmentId)?.scratchWorkspaceRoot)
      ) {
        return null;
      }
      return environmentLabelById.get(thread.environmentId) ?? null;
    };
    // Pinning from a row keeps rows in place while the menu is open.
    const projectScopeItems = useOrderWhileOpen(
      lookupProjectScopeItems,
      (item) => item.value,
      projectScopeMenuState.open,
    );
    const selectedProjectScopeItem =
      projectScopeKeys.length > 1
        ? null
        : (projectScopeItems.find((item) => item.value === (projectScopeKeys[0] ?? "all")) ??
          projectScopeItems[0]!);
    const filteredProjectScopeItems = filterSidebarProjectScopeItems({
      items: projectScopeItems,
      query: projectScopeMenuState.query,
      matches: (item, query) =>
        projectScopeFilter.contains(item, query, (candidate) => candidate.label),
    });
    const scopedProjectGroups = revealWidensScope ? [] : chosenProjectGroups;
    const scopedProjectRefs = scopedProjectGroups.flatMap((project) => project.memberProjectRefs);
    const scopedProjectKeys = revealWidensScope ? null : chosenScopeProjectKeys;
    const threadSearch = useThreadSearch(
      connectedEnvironmentIds,
      threadSearchQuery,
      scopedProjectGroups.length === 0
        ? {}
        : { projectIds: scopedProjectRefs.map((projectRef) => projectRef.projectId) },
    );
    const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
    const visibleDraftSessionCount = useComposerDraftStore((store) => {
      let count = 0;
      for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
        if (session.promotedTo != null) {
          continue;
        }
        if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
          continue;
        }
        if (
          scopedProjectKeys !== null &&
          !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
        ) {
          continue;
        }
        count += 1;
      }
      return count;
    });

    const openProjectSettings = useStableCallback(
      (projectGroup: SidebarProjectSnapshot, projectRef?: ScopedProjectRef) => {
        if (isMobile) {
          setOpenMobile(false);
        }
        void router.navigate({
          to: "/projects/$projectKey",
          params: {
            projectKey: getSidebarProjectSettingsKey(
              projectGroup,
              projectGroupingSettings,
              projects,
              projectRef,
            ),
          },
        });
      },
    );
    const {
      canPinProjectGroup: canPinProject,
      setProjectGroupPinned,
      toggleProjectGroupPin,
    } = useProjectPin();
    const handleProjectSettings = useStableCallback(
      (
        event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
        projectGroup: SidebarProjectSnapshot,
      ) => {
        event.preventDefault();
        event.stopPropagation();
        suppressNextScopeChangeRef.current = true;
        dispatchProjectScopeMenu({ type: "project-settings-opened" });
        openProjectSettings(projectGroup);
      },
    );
    const startThreadInProjectFolder = useStableCallback((group: SidebarProjectSnapshot) => {
      if (isMobile) setOpenMobile(false);
      void handleNewThread(scopeProjectRef(group.environmentId, group.id));
    });
    const handleProjectFolderContextMenu = useStableCallback(
      (group: SidebarProjectSnapshot, position: { x: number; y: number }) => {
        const api = readLocalApi();
        if (!api) return;
        void (async () => {
          const clicked = await settlePromise(() =>
            api.contextMenu.show(
              [
                { id: "new-thread", label: "New thread" },
                { id: "copy-path", label: "Copy path" },
                ...(canPinProject(group)
                  ? [
                      group.pinned
                        ? { id: "unpin", label: "Unpin project", icon: "pin-off" }
                        : { id: "pin", label: "Pin project", icon: "pin" },
                    ]
                  : []),
                { id: "project-settings", label: "Project settings", icon: "settings" },
              ],
              position,
            ),
          );
          if (clicked._tag === "Failure") return;
          switch (clicked.value) {
            case "new-thread":
              startThreadInProjectFolder(group);
              return;
            case "copy-path":
              copyPathToClipboard(group.workspaceRoot, { path: group.workspaceRoot });
              return;
            case "pin":
            case "unpin":
              setProjectGroupPinned(group, clicked.value === "pin");
              return;
            case "project-settings":
              openProjectSettings(group);
              return;
          }
        })();
      },
    );

    const {
      workingShelfEnabled,
      pinnedThreads,
      draggableThreadKeys,
      activeReorderableThreadKeys,
      activeThreads,
      workingThreads,
      snoozedThreads,
      settledThreads,
      snoozeNow,
      searchableThreads,
      settledVisibleCount,
      settledCount,
      olderSettledShelf,
      hiddenSettledCount,
      showMoreSettled,
      settledShelfExpanded,
      toggleSettledShelf,
      snoozedShelfExpanded,
      toggleSnoozedShelf,
      workingShelfExpanded,
      toggleWorkingShelf,
      projectFolders,
      toggleProjectFolder,
      renderedSettledThreads,
      visibleSnoozedThreads,
      visibleWorkingThreads,
      orderedThreadKeys,
      threadByKey,
      settledThreadKeys,
      snoozedThreadKeys,
      sectionByThreadKey,
      pinnedKeys,
      activeKeys,
      pinnedKeysById,
      activeKeysById,
    } = useSidebarThreads({
      projectScopeKey,
      scopedProjectKeys,
      serverConfigs,
      connectedEnvironmentIds,
      optimisticDrop,
      threads,
      delegatedUnderParent,
      routeRowThreadKey,
      folderGroups: boringSidebarEnabled
        ? scopedProjectGroups.length === 0
          ? // An archived project keeps a folder for its active threads, below the rest.
            [...scopeGroups, ...projectGroups.filter((project) => project.archived)]
          : scopedProjectGroups
        : null,
      keepEmptyFolders: (group) =>
        scopedProjectGroups.length > 0 || (group.pinned && !group.archived),
    });

    // Ranked across environments as the palette ranks them, so one
    // environment's list does not sit above another's better matches; rows
    // already shown keep their places while slower environments answer.
    const threadByMatchKey =
      threadSearch.matches.length === 0
        ? null
        : new Map(
            searchableThreads.map((thread) => [
              threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
              thread,
            ]),
          );
    const rankedServerMatches =
      threadByMatchKey === null
        ? []
        : rankMessageMatches(
            threadSearch.matches,
            (match) => {
              const thread = threadByMatchKey.get(threadSearchMatchKey(match));
              return thread ? threadSearchSubject(thread, null) : undefined;
            },
            foldSearchQuery(threadSearchQuery),
            // oxlint-disable-next-line react/purity -- Recency ranking samples the clock when the search matches change; the compiler recomputes it only then.
            Date.now(),
            // A list filter, as on mobile: a pick would move rows unexplained.
            { picks: false },
          );
    const serverMatchByKey = new Map(
      rankedServerMatches.map((match) => [threadSearchMatchKey(match), match] as const),
    );

  return { revealActiveRow, showProjectEnvironments, scratchMachineLabelFor, projectScopeItems, selectedProjectScopeItem, filteredProjectScopeItems, scopedProjectGroups, scopedProjectKeys, threadSearch, routeDraftIdForRows, visibleDraftSessionCount, openProjectSettings, canPinProject, toggleProjectGroupPin, handleProjectSettings, startThreadInProjectFolder, handleProjectFolderContextMenu, workingShelfEnabled, pinnedThreads, draggableThreadKeys, activeReorderableThreadKeys, activeThreads, workingThreads, snoozedThreads, settledThreads, snoozeNow, searchableThreads, settledVisibleCount, settledCount, olderSettledShelf, hiddenSettledCount, showMoreSettled, settledShelfExpanded, toggleSettledShelf, snoozedShelfExpanded, toggleSnoozedShelf, workingShelfExpanded, toggleWorkingShelf, projectFolders, toggleProjectFolder, renderedSettledThreads, visibleSnoozedThreads, visibleWorkingThreads, orderedThreadKeys, threadByKey, settledThreadKeys, snoozedThreadKeys, sectionByThreadKey, pinnedKeys, activeKeys, pinnedKeysById, activeKeysById, serverMatchByKey };
}
