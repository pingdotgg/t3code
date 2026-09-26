import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useClientSettings } from "../hooks/useSettings";
import { resolveThreadActionProjectRef } from "../lib/chatThreadActions";
import { sortThreads } from "../lib/threadSort";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "../sidebarProjectGrouping";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { ProjectFavicon } from "./ProjectFavicon";
import { CYCLE_SWITCHER_MODE, type CycleSwitcherMode } from "./CycleSwitcher.logic";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";

export interface CycleSwitcherEntry {
  readonly key: string;
  readonly label: string;
  readonly sublabel: string | null;
  readonly icon: ReactNode;
  readonly isCurrent: boolean;
  readonly commit: () => void;
}

const EMPTY_ENTRIES: ReadonlyArray<CycleSwitcherEntry> = [];

/**
 * Builds the entries displayed by an open switcher. Keeping navigation and
 * sidebar grouping here leaves CycleSwitcher responsible only for interaction
 * state and rendering.
 */
export function useCycleSwitcherEntries(
  mode: CycleSwitcherMode,
): ReadonlyArray<CycleSwitcherEntry> {
  const navigate = useNavigate();
  const clientSettings = useClientSettings();
  const { activeThread, activeDraftThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectOrder = useUiStateStore((store) => store.projectOrder);

  const projectGroupingSettings = selectProjectGroupingSettings(clientSettings);
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const contextualProjectRef = resolveThreadActionProjectRef({
    activeDraftThread,
    activeThread: activeThread ?? undefined,
    defaultProjectRef,
    handleNewThread,
  });
  const unsortedGroups = buildSidebarProjectSnapshots({
    projects: clientSettings.sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
  });
  const projectGroups = sortLogicalProjectsForSidebar(
    unsortedGroups,
    threads,
    clientSettings.sidebarProjectSortOrder,
  );

  if (mode === CYCLE_SWITCHER_MODE.project) {
    return buildSidebarProjectPickerEntries({
      groups: projectGroups,
      preferredProjectRef: contextualProjectRef,
    }).map(({ group, targetProject, isPreferred }) => ({
      key: group.projectKey,
      label: group.displayName,
      sublabel:
        environments.length > 1 && targetProject.environmentLabel
          ? targetProject.environmentLabel
          : null,
      icon: <ProjectFavicon className="size-9" project={targetProject} />,
      isCurrent: isPreferred,
      commit: () => {
        const uiState = useUiStateStore.getState();
        uiState.setSidebarProjectScopeKey(
          uiState.sidebarProjectScopeKey === group.projectKey ? null : group.projectKey,
        );
        uiState.setProjectExpanded(group.projectKey, true);

        const groupKeys = new Set(
          group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
        );
        const latestThread = sortThreads(
          threads.filter(
            (thread) =>
              thread.archivedAt === null &&
              groupKeys.has(`${thread.environmentId}:${thread.projectId}`),
          ),
          clientSettings.sidebarThreadSortOrder,
        )[0];

        if (latestThread) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(latestThread.environmentId, latestThread.id),
            ),
          });
          return;
        }
        void handleNewThread(scopeProjectRef(targetProject.environmentId, targetProject.id));
      },
    }));
  }

  if (contextualProjectRef === null) return EMPTY_ENTRIES;

  const projectByScopedKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );

  const group = projectGroups.find((candidate) =>
    candidate.memberProjectRefs.some(
      (ref) =>
        ref.environmentId === contextualProjectRef.environmentId &&
        ref.projectId === contextualProjectRef.projectId,
    ),
  );
  if (group === undefined) return EMPTY_ENTRIES;

  const allowedProjectKeys = new Set(
    group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
  );
  const activeKey = activeThread ? `${activeThread.environmentId}:${activeThread.id}` : null;
  const now = new Date().toISOString();
  const visibleThreads = threads.filter((thread) => {
    if (
      thread.archivedAt !== null ||
      !allowedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)
    ) {
      return false;
    }
    const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
    if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now })) return false;
    if (capabilities?.threadSettlement === true && thread.settledOverride === "settled") {
      return false;
    }
    return true;
  });
  const sortedThreads = sortThreads(visibleThreads, clientSettings.sidebarThreadSortOrder);
  const activeIndex = activeKey
    ? sortedThreads.findIndex((thread) => `${thread.environmentId}:${thread.id}` === activeKey)
    : -1;
  const orderedThreads =
    activeIndex > 0
      ? [
          sortedThreads[activeIndex]!,
          ...sortedThreads.slice(0, activeIndex),
          ...sortedThreads.slice(activeIndex + 1),
        ]
      : sortedThreads;

  return orderedThreads.map((thread) => {
    const scopedKey = `${thread.environmentId}:${thread.id}`;
    const project = projectByScopedKey.get(`${thread.environmentId}:${thread.projectId}`);
    return {
      key: scopedKey,
      label: thread.title,
      sublabel: thread.branch,
      icon: project ? (
        <ProjectFavicon className="size-5" project={project} />
      ) : (
        <MessageSquareIcon className="size-5" />
      ),
      isCurrent: scopedKey === activeKey,
      commit: () => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
        });
      },
    };
  });
}
