import type { CommandPaletteDialogProps } from "./commandPaletteTypes";
import { useCommandPaletteBrowseState } from "./useCommandPaletteBrowseState";

import {
  useDeferredValue,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { getLatestThreadForProject, sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import { buildThreadRouteParams } from "../../threadRoutes";

import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useOrderWhileOpen } from "../../hooks/useOrderWhileOpen";
import {
  buildNewThreadInProjectItems,
  buildProjectSearchItems,
} from "../CommandPaletteProjectItems";
import {
  resolveCommandPaletteProject,
  ADDON_ICON_CLASS,
  browseInputEndPaddingClass,
  buildBrowseGroups,
  buildRootGroups,
  buildLinkedThreadActionItems,
  buildCommandPaletteRows,
  enumerateCommandPaletteItems,
  newThreadNoProjectIndex,
  findHighlightedCommandPaletteItem,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteProject,
  type CommandPaletteReturnContext,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  buildNestedSearchItems,
  filterPinnedBrowseEntries,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  createCommandPaletteSearchState,
  type CommandPaletteGroup,
  resolveAddProjectEntry,
  type AddProjectCloneFlow,
  type AddProjectEnvironmentOption,
  buildPaletteRemoteSourceReadiness,
  errorMessage,
  getEnvironmentBrowsePlatform,
  remoteProjectInputPlaceholder,
  reduceCommandPaletteSearchState,
  type SearchOverlayMode,
} from "../CommandPalette.logic";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isScratchProject,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "@t3tools/client-runtime/state/projects";
import {
  ArrowLeftIcon,
  BugIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  ChevronRightIcon,
  CornerLeftUpIcon,
  FileSearchIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareDashedIcon,
  LinkIcon,
  MessageSquareIcon,
  PaletteIcon,
  RotateCcwIcon,
  SettingsIcon,
  MonitorIcon,
  PinIcon,
  PinOffIcon,
  SquarePenIcon,
  TextSearchIcon,
  UserPlusIcon,
} from "lucide-react";
import { useCommandPaletteThreadItems } from "../CommandPaletteThreadItems";
import { threadRecentUse } from "@t3tools/shared/paletteSearch";
import { useStableCallback } from "../../hooks/useStableCallback";
import { resolvePastedPath } from "@t3tools/shared/path";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  type DesktopWslState,
  type EnvironmentId,
  type FilesystemBrowseResult,
  SourceControlProviderKind,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  canCreateProjectInEnvironment,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  getNewProjectPathPreview,
  getNewProjectPublishTarget,
  getNewProjectPublishTargets,
  getNewProjectRepository,
  githubIncompleteOwnerRepositoryMessage,
  normalizePastedCloneUrl,
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  addProjectRemoteSourceProvider,
  sortAddProjectProviderSources,
  type AddProjectRemoteSource,
  type AddProjectRemoteSourceReadiness,
} from "@t3tools/client-runtime/operations/projects";
import {
  CommandPaletteSubmitButton,
  NewProjectPublishHostPicker,
  NewProjectSummary,
  RemoteRepositorySummary,
  remoteProjectSourceIcon,
  sourceControlHostIcon,
} from "../CommandPaletteAddProject";


const NEW_THREAD_NO_PROJECT_VALUE = "new-thread-in:no-project";

export function useCommandPaletteProjectState(props: CommandPaletteDialogProps, params: {
  s1: ReturnType<typeof useCommandPaletteBrowseState>,
  }) {
  const { s1 } = params;
  const { setOpen } = props;
  const { browseNavigation, cloneLookupGeneration, projects, projectGroupByTargetKey, threads, clientSettings, navigate, handleNewThread, pickerProjects, projectEnvironmentLocationById, projectPin, rowOrderKey, scratchWorkspaceRootFor, contextualProjectRef, scratchTargetEnvironmentId, projectPickerEntries, startScratchThread, activeThread, threadSearchQuery, dispatchSearch, highlightClearedRef, setHighlightedItemValue, setAddProjectCloneFlow, setNewProjectFlow, viewStack, setAddProjectEnvironmentId, newProjectFlow, clearTypedHighlight, setQuery, canBrowsePaths, query, currentView, getAddProjectInitialQueryForEnvironment, getBrowseCwdForEnvironment, prefetchBrowsePath, environments, setNewProjectPublishes, setNewProjectPublishKind } = s1;
    useEffect(
      () => () => {
        browseNavigation.invalidate();
        // A replaced or closed session must not report its in-flight lookup.
        cloneLookupGeneration.current += 1;
      },
      [browseNavigation],
    );

    const openProjectFromSearch = async (project: (typeof projects)[number]) => {
      const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
      const groupedProjectKeys = group
        ? new Set(
            group.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          )
        : null;
      const latestThread = groupedProjectKeys
        ? (sortThreads(
            threads.filter(
              (thread) =>
                thread.archivedAt === null &&
                groupedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
            ),
            clientSettings.sidebarThreadSortOrder,
          )[0] ?? null)
        : getLatestThreadForProject(
            threads.filter((thread) => thread.environmentId === project.environmentId),
            project.id,
            clientSettings.sidebarThreadSortOrder,
          );
      if (latestThread) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(latestThread.environmentId, latestThread.id)),
        });
        return;
      }

      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    };

    // Pinning from a row keeps rows in place while the palette is open.
    const projectSearchItems = useOrderWhileOpen(
      buildProjectSearchItems({
        projects: pickerProjects,
        projectGroupByTargetKey,
        locationByEnvironmentId: projectEnvironmentLocationById,
        runProject: openProjectFromSearch,
        pin: projectPin,
      }),
      rowOrderKey("project"),
      true,
    );

    const openingOrderThreadItems = useOrderWhileOpen(
      (() => {
        const isScratch = (project: CommandPaletteProject) =>
          isScratchProject(project, scratchWorkspaceRootFor(project.environmentId));
        const projectItems = buildNewThreadInProjectItems({
          projects: pickerProjects.filter((project) => !isScratch(project)),
          projectGroupByTargetKey,
          locationByEnvironmentId: projectEnvironmentLocationById,
          pin: projectPin,
          runProject: async (project) => {
            const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
            const contextualRefBelongsToGroup =
              contextualProjectRef !== null &&
              group?.memberProjectRefs.some(
                (projectRef) =>
                  projectRef.environmentId === contextualProjectRef.environmentId &&
                  projectRef.projectId === contextualProjectRef.projectId,
              );
            await handleNewThread(
              contextualRefBelongsToGroup
                ? contextualProjectRef
                : scopeProjectRef(project.environmentId, project.id),
            );
          },
        });
        if (scratchTargetEnvironmentId === null) return projectItems;

        const noProjectIndex = newThreadNoProjectIndex(
          projectPickerEntries.map(({ group, targetProject, isPreferred }) => ({
            isScratch: isScratchProject(
              targetProject,
              scratchWorkspaceRootFor(targetProject.environmentId),
            ),
            pinned: group.pinned,
            isPreferred,
          })),
        );
        return [
          ...projectItems.slice(0, noProjectIndex),
          {
            kind: "action" as const,
            value: NEW_THREAD_NO_PROJECT_VALUE,
            searchTerms: ["no project", "without project", "none"],
            title: "No project",
            icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
            shortcutCommand: "chat.newWithoutProject" as const,
            run: () => startScratchThread(scratchTargetEnvironmentId),
          },
          ...projectItems.slice(noProjectIndex),
        ];
      })(),
      rowOrderKey("new-thread-in"),
      true,
    );
    // Jump shortcuts follow the rows as shown, so a pin cannot move a number to another row.
    const projectJumpItems = new Map(
      enumerateCommandPaletteItems(
        openingOrderThreadItems.filter((item) => item.value !== NEW_THREAD_NO_PROJECT_VALUE),
      ).map((item) => [item.value, item] as const),
    );
    const projectThreadItems = openingOrderThreadItems.map(
      (item) => projectJumpItems.get(item.value) ?? item,
    );

    const {
      threadItems: allThreadItems,
      threadMessageItems,
      now: searchNow,
      isSearchPending: isThreadSearchPending,
    } = useCommandPaletteThreadItems({ activeThread: activeThread ?? null, threadSearchQuery });
    // Recent means used recently: written in or opened, whichever is later. The
    // open thread would always lead that list, so it is left out.
    const activeThreadValue = activeThread
      ? `thread:${activeThread.environmentId}:${activeThread.id}`
      : null;
    const recentThreadItems = allThreadItems
      .filter((item) => item.value !== activeThreadValue)
      .toSorted(
        (left, right) =>
          (right.threadSearch ? threadRecentUse(right.threadSearch) : 0) -
          (left.threadSearch ? threadRecentUse(left.threadSearch) : 0),
      )
      .slice(0, RECENT_THREAD_LIMIT);

    const pushPaletteView = useStableCallback((view: CommandPaletteView): void => {
      browseNavigation.invalidate();
      dispatchSearch({ type: "push", view });
      highlightClearedRef.current = true;
      setHighlightedItemValue(null);
    });

    function popView(): void {
      browseNavigation.invalidate();
      setAddProjectCloneFlow(null);
      setNewProjectFlow(null);
      if (viewStack.length <= 1) {
        setAddProjectEnvironmentId(null);
      } else if (newProjectFlow?.sourcesEnvironmentId) {
        setAddProjectEnvironmentId(newProjectFlow.sourcesEnvironmentId);
      }
      dispatchSearch({ type: "back" });
      setHighlightedItemValue(null);
    }

    function handleQueryChange(nextQuery: string): void {
      browseNavigation.invalidate();
      clearTypedHighlight();
      setQuery(canBrowsePaths ? resolvePastedPath(query, nextQuery) : nextQuery);
      if (nextQuery === "" && currentView?.initialQuery) {
        popView();
      }
    }

    const startAddProjectBrowse = async (environmentId: EnvironmentId): Promise<void> => {
      const initialQuery = getAddProjectInitialQueryForEnvironment(environmentId);
      const initialBrowsePath = getBrowseDirectoryPath(initialQuery);
      const browseCwd = getBrowseCwdForEnvironment(environmentId);
      const view: CommandPaletteView = {
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [],
        initialQuery,
      };

      await browseNavigation.run(
        () =>
          initialBrowsePath.length > 0
            ? prefetchBrowsePath(initialBrowsePath, environmentId, browseCwd)
            : Promise.resolve(),
        () => {
          setAddProjectEnvironmentId(environmentId);
          setAddProjectCloneFlow(null);
          pushPaletteView(view);
        },
      );
    };

    const startAddProjectClone = (
      environmentId: EnvironmentId,
      source: AddProjectRemoteSource,
    ): void => {
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow({ step: "repository", environmentId, source });
      pushPaletteView({
        addonIcon: remoteProjectSourceIcon(source, ADDON_ICON_CLASS),
        groups: [],
        initialQuery: "",
      });
    };

    const newProjectsRootFor = (environmentId: EnvironmentId | null): string | null =>
      environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
        ?.newProjectsRoot ?? null;

    const startNewProject = (
      environmentId: EnvironmentId,
      sourcesEnvironmentId: EnvironmentId | null,
    ): void => {
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow(null);
      setNewProjectFlow({ environmentId, sourcesEnvironmentId });
      setNewProjectPublishes(false);
      setNewProjectPublishKind(null);
      pushPaletteView({
        addonIcon: <FolderGit2Icon className={ADDON_ICON_CLASS} />,
        groups: [],
      });
    };

    const openSourceControlSettings = () => {
      setOpen(false);
      void navigate({ to: "/settings/source-control" });
    };

  return { projectSearchItems, projectThreadItems, allThreadItems, threadMessageItems, searchNow, isThreadSearchPending, recentThreadItems, pushPaletteView, popView, handleQueryChange, startAddProjectBrowse, startAddProjectClone, newProjectsRootFor, startNewProject, openSourceControlSettings };
}
