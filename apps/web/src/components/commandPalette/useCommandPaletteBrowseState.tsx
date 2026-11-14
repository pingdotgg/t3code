import type { CommandPaletteDialogProps } from "./commandPaletteTypes";

import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  useDeferredValue,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  useAnyEnvironmentHiding,
  useHiddenThreadKeys,
  useEnvironmentThreadRefs,
  useProjects,
  useServerConfigs,
  useVisibleThreadShells,
  waitForProject,
} from "../../state/entities";
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
import type { LegendListRef } from "@legendapp/list/react";
import { useClientSettings } from "../../hooks/useSettings";
import {
  selectCommandPaletteClientSettings,
  useEnvironmentLookups,
  useProjectLookups,
  useSortedProjectGroups,
} from "../CommandPaletteLookups";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStartTriage } from "../../hooks/useStartTriage";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { threadEnvironment } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useDesktopLocalBootstraps } from "../../connection/useDesktopLocalBootstraps";
import { useAvailableSettingsSearchItems } from "../settings/useAvailableSettingsSearchItems";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { PULL_REQUESTS_PANEL_REF, useRightPanelStore } from "../../rightPanelStore";

import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useOpenPanelPullRequestUrl } from "../../hooks/useOpenPanelPullRequestUrl";
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
import { useAtomValue } from "@effect/atom-react";
import { canShareWithGuestAtom } from "../chat/guestShareAvailability";
import { resolveThreadReferenceCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { isSidebarHiddenThread } from "../Sidebar.logic";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useCommandPaletteThemeItems } from "../CommandPaletteThemeItems";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  getFilesystemBrowseTabCompletion,
} from "@t3tools/client-runtime/state/filesystem";
import { useNewProject } from "../../hooks/useNewProject";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../../lib/chatThreadActions";
import { buildSidebarProjectPickerEntries } from "../../sidebarProjectGrouping";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { reportProjectFailure, useProjectPin } from "../../hooks/useProjectGroupUpdate";
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
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { desktopLocalBackendId } from "../../connection/desktopLocal";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useEnvironmentQuery } from "../../state/query";
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
import { pickTriageEnvironment } from "../../lib/triageTarget";
import {
  cn,
  getLocalFileManagerName,
  isMacPlatform,
  isWindowsPlatform,
  newProjectId,
} from "../../lib/utils";
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


const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

const ADD_PROJECT_ENTRY_GROUP = "add-project";

const NEW_THREAD_IN_GROUP = "projects";


/** The submenu an open intent starts in; its groups resolve while rendering. */
function openIntentView(intent: CommandPaletteOpenIntent | null): CommandPaletteView | null {
  switch (intent?.kind) {
    case "add-project":
      return {
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: ADD_PROJECT_ENTRY_GROUP, label: "", items: [] }],
      };
    case "new-thread-in":
      return {
        addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: NEW_THREAD_IN_GROUP, label: "Projects", items: [] }],
      };
    case "change-theme":
      return {
        addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: "themes", label: "Change theme", items: [] }],
      };
    case "search":
    case undefined:
      return null;
  }
}

export function useCommandPaletteBrowseState(props: CommandPaletteDialogProps) {
    const navigate = useNavigate();
    const pathname = useLocation({ select: (location) => location.pathname });
    const { openChildSearch, setOpen } = props;
    // Keyed by palette session: the intent and restored search only seed this
    // mount, and closing must not change what the closing palette shows.
    const [initialSearch] = useState(
      () =>
        props.initialContext ?? {
          query: props.openIntent?.kind === "search" ? props.openIntent.query : "",
          linkedThreadSearch: props.openIntent?.kind === "search" ? props.openIntent : null,
        },
    );
    const linkedThreadSearch = initialSearch.linkedThreadSearch;
    // Rows were captured when the palette opened; drop any hidden since then.
    const hiddenKeys = useHiddenThreadKeys();
    const linkedEnvironmentId = linkedThreadSearch?.linkedThreads?.environmentId ?? null;
    const hidingAnywhere = useAnyEnvironmentHiding();
    const linkedThreadRefs = useEnvironmentThreadRefs(linkedEnvironmentId);
    const [searchState, dispatchSearch] = useReducer(reduceCommandPaletteSearchState, null, () => {
      const view = props.initialContext ? null : openIntentView(props.openIntent);
      return view
        ? { query: "", views: [{ view, parentQuery: "" }] }
        : createCommandPaletteSearchState(initialSearch.query);
    });
    const { query, views: viewStack } = searchState;
    const setQuery = (query: string) => dispatchSearch({ type: "query", query });
    const deferredQuery = useDeferredValue(query);
    const isActionsOnly = deferredQuery.startsWith(">");
    const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
    const resultListRef = useRef<LegendListRef | null>(null);
    // A pushed view drops the typed highlight until the user moves it again.
    const highlightClearedRef = useRef(viewStack.length > 0);
    function clearTypedHighlight(): void {
      highlightClearedRef.current = true;
      setHighlightedItemValue(null);
    }
    const clientSettings = useClientSettings(selectCommandPaletteClientSettings);
    const createProject = useAtomCommand(projectEnvironment.create, {
      reportFailure: false,
    });
    const updateProject = useOrchestrationCommand(projectEnvironment.update, {
      label: "project unarchive",
    });
    const { scratchEnvironmentId, scratchWorkspaceRootFor, startScratchThread } = useScratchProject();
    const startTriage = useStartTriage();
    const lookupRepository = useAtomQueryRunner(sourceControlEnvironment.repository, {
      reportFailure: false,
    });
    const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
      reportFailure: false,
      reportDefect: false,
    });
    const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
      reportFailure: false,
    });
    const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
      reportFailure: false,
    });
    const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
      reportFailure: false,
    });
    const { environments } = useEnvironments();
    const desktopLocalBootstraps = useDesktopLocalBootstraps();
    const primaryEnvironmentId = usePrimaryEnvironmentId();
    const availableSettingsSearchItems = useAvailableSettingsSearchItems();
    const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
      useHandleNewThread();
    const paletteRouteTarget = useThreadRouteTarget();
    const projects = useProjects();
    const referenceThreadRef =
      pathname === "/pull-requests"
        ? environments.some((environment) => environment.serverConfig !== null)
          ? PULL_REQUESTS_PANEL_REF
          : null
        : activeThread
          ? scopeThreadRef(activeThread.environmentId, activeThread.id)
          : null;
    const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(referenceThreadRef);
    const activeThreadServerConfig = useServerConfigs().get(
      activeThread?.environmentId ?? ("" as EnvironmentId),
    );
    const canShareActiveThreadWithGuest = useAtomValue(
      canShareWithGuestAtom(activeThread?.environmentId ?? ("" as EnvironmentId)),
    );
    const activeThreadReferenceCopyTarget =
      referenceThreadRef === null || (pathname === "/pull-requests" && !openPanelPullRequestUrl)
        ? null
        : resolveThreadReferenceCopyTarget({
            threadRef: referenceThreadRef,
            title: activeThread?.title ?? "",
            openPanelPullRequestUrl,
            pullRequests: activeThread?.pullRequests,
            linkedPullRequestUrl:
              activeThread?.linkedPullRequest?.url ?? activeThread?.branchPullRequest?.url ?? null,
            hostedAppUrl: configuredHostedAppUrl(),
          });
    const copyActiveThreadReference = async () => {
      if (activeThreadReferenceCopyTarget === null) return;
      await copyThreadReference(activeThreadReferenceCopyTarget);
    };
    // Side chats and subagents open inside their parent, so opening a project never lands on one.
    const threads = useVisibleThreadShells().filter((thread) => !isSidebarHiddenThread(thread));
    const keybindings = useAtomValue(primaryServerKeybindingsAtom);
    const providersByEnvironment = useEnvironmentProviders();
    const { changeThemeItem, changeAppearanceItem, themeEditorItem } = useCommandPaletteThemeItems();
    const currentView = viewStack.at(-1)?.view ?? null;
    const threadSearchQuery = currentView === null && !isActionsOnly ? deferredQuery : "";
    const [browseGeneration, setBrowseGeneration] = useState(0);
    const [browseNavigation] = useState(createBrowseNavigationCoordinator);
    const [addProjectEnvironmentId, setAddProjectEnvironmentId] = useState<EnvironmentId | null>(
      null,
    );
    const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
    const [addProjectCloneFlow, setAddProjectCloneFlow] = useState<AddProjectCloneFlow | null>(null);
    const [newProjectFlow, setNewProjectFlow] = useState<{
      readonly environmentId: EnvironmentId;
      readonly sourcesEnvironmentId: EnvironmentId | null;
    } | null>(null);
    const [newProjectPublishes, setNewProjectPublishes] = useState(false);
    const [newProjectPublishKind, setNewProjectPublishKind] =
      useState<SourceControlProviderKind | null>(null);
    const [isCreatingNewProject, setIsCreatingNewProject] = useState(false);
    // State lags a render behind, so a repeated Enter could start a second create.
    const newProjectSubmittingRef = useRef(false);
    const createNewProject = useNewProject();
    const cloneLookupGeneration = useRef(0);
    const nextCloneLookupGeneration = () => {
      cloneLookupGeneration.current += 1;
      return cloneLookupGeneration.current;
    };
    const isCurrentCloneLookupGeneration = (generation: number) => cloneLookupGeneration.current === generation;
    const [isRemoteProjectLookingUp, setIsRemoteProjectLookingUp] = useState(false);
    const [isRemoteProjectCloning, setIsRemoteProjectCloning] = useState(false);
    const { environmentLabelById, projectEnvironmentLocationById } = useEnvironmentLookups();
    const projectGroups = useSortedProjectGroups(environmentLabelById);
    const contextualProjectRef = resolveThreadActionProjectRef({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
    const projectPickerEntries = buildSidebarProjectPickerEntries({
      groups: pickableProjectGroups(projectGroups),
      preferredProjectRef: contextualProjectRef,
    });
    const pickerProjects = projectPickerEntries.map(({ group, targetProject }) => ({
      ...targetProject,
      displayName: group.displayName,
    }));
    const projectGroupByTargetKey = new Map(
      projectPickerEntries.map(({ group, targetProject }) => [
        `${targetProject.environmentId}:${targetProject.id}`,
        group,
      ]),
    );
    const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();
    // A row's target record can change when another machine's copy loads, so the kept
    // order follows the project group instead.
    const rowOrderKey = (prefix: string) => (item: CommandPaletteActionItem) =>
      projectGroupByTargetKey.get(item.value.slice(prefix.length + 1))?.projectKey ?? item.value;
    const projectPin = (project: CommandPaletteProject) => {
      const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
      return group && canPinProjectGroup(group)
        ? {
            name: group.displayName,
            pinned: group.pinned,
            toggle: () => toggleProjectGroupPin(group),
          }
        : null;
    };

    const addProjectEnvironmentOptions = (() => {
      const options = environments
        .filter((environment) => canCreateProjectInEnvironment(environment.connection.phase))
        .map((environment): AddProjectEnvironmentOption => {
          const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
          return {
            environmentId: environment.environmentId,
            label: resolveEnvironmentOptionLabel({
              isPrimary,
              environmentId: environment.environmentId,
              runtimeLabel: environment.label,
            }),
            isPrimary,
            machine: resolveEnvironmentMachineKind(environment.serverConfig),
            isConnected: canCreateProjectInEnvironment(environment.connection.phase),
            status: connectionStatusText(environment.connection),
          };
        });

      options.sort((left, right) => {
        if (left.isPrimary !== right.isPrimary) {
          return left.isPrimary ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      });

      return options;
    })();
    const defaultAddProjectEnvironmentId =
      addProjectEnvironmentOptions.find((option) => option.isConnected)?.environmentId ?? null;
    const wslAddProjectEnvironmentOption =
      addProjectEnvironmentOptions.find((option) => {
        if (!option.isConnected) {
          return false;
        }
        const environment = environments.find(
          (candidate) => candidate.environmentId === option.environmentId,
        );
        return environment
          ? desktopLocalBackendId(environment.entry.target)?.startsWith("wsl:") === true
          : false;
      }) ?? null;
    const browseEnvironmentId = addProjectEnvironmentId ?? defaultAddProjectEnvironmentId;
    const canCreateProject = useEnvironmentScope(browseEnvironmentId, AuthOrchestrationOperateScope);
    const browseEnvironment =
      environments.find((environment) => environment.environmentId === browseEnvironmentId) ?? null;
    const browseEnvironmentIsDesktopLocal =
      browseEnvironment !== null && isDesktopLocalConnectionTarget(browseEnvironment.entry.target);
    // pickFolder routes desktop-local environments by pool id, not catalog environmentId.
    const browseDesktopInstanceId = (() => {
      if (!browseEnvironmentIsDesktopLocal || browseEnvironment === null) {
        return null;
      }
      const displayUrl = browseEnvironment.displayUrl;
      if (displayUrl === null) {
        return null;
      }
      return (
        desktopLocalBootstraps.find((bootstrap) => bootstrap.httpBaseUrl === displayUrl)?.id ?? null
      );
    })();
    const sourceControlDiscovery = useEnvironmentQuery(
      browseEnvironmentId === null
        ? null
        : sourceControlEnvironment.discovery({
            environmentId: browseEnvironmentId,
            input: {},
          }),
    );
    const browseEnvironmentPlatform = getEnvironmentBrowsePlatform(
      browseEnvironment?.serverConfig?.environment.platform.os,
    );
    const isRemoteProjectCloneFlow = addProjectCloneFlow !== null;
    const isRemoteProjectRepositoryStep = addProjectCloneFlow?.step === "repository";
    const pinnedCloneDirectoryName =
      addProjectCloneFlow?.step === "confirm"
        ? getCloneDirectoryName(
            addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.remoteUrl,
          )
        : "";
    const canBrowsePaths =
      browseEnvironmentId !== null && !isRemoteProjectRepositoryStep && newProjectFlow === null;
    const browsePath = getFilesystemBrowsePath(query, browseEnvironmentPlatform, canBrowsePaths);
    const isBrowsing = browsePath.isBrowsing;
    const browseDirectoryPath = browsePath.directoryPath;
    const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });
    const getAddProjectInitialQueryForEnvironment = (environmentId: EnvironmentId | null): string => {
      const environment = environments.find((candidate) => candidate.environmentId === environmentId);
      const environmentSettings = environment?.serverConfig?.settings ?? null;
      const baseDirectory = environmentSettings?.addProjectBaseDirectory?.trim() ?? "";
      if (baseDirectory.length === 0) {
        return "~/";
      }
      return ensureBrowseDirectoryPath(baseDirectory);
    };

    const { projectByKey } = useProjectLookups();

    const activeThreadKey = activeThread
      ? scopedThreadKey(scopeThreadRef(activeThread.environmentId, activeThread.id))
      : null;
    const supportsThreadFind =
      environments.find((environment) => environment.environmentId === activeThread?.environmentId)
        ?.serverConfig?.threadFind === true;
    const currentProjectEnvironmentId =
      activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
    const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
    const scratchTargetEnvironmentId = scratchEnvironmentId(currentProjectEnvironmentId);
    const supportsTriage = (environmentId: EnvironmentId | null) =>
      environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
        ?.environment.capabilities.triage === true;
    const triageEnvironmentId = pickTriageEnvironment({
      onScreen: currentProjectEnvironmentId,
      primary: primaryEnvironmentId,
      connected: environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
      supportsTriage,
    });
    const canTriage =
      useAtomValue(serverEnvironment.prepareTriage.permissionAtom(triageEnvironmentId)) &&
      supportsTriage(triageEnvironmentId);
    const currentProject = resolveCommandPaletteProject(
      projectByKey,
      currentProjectEnvironmentId,
      currentProjectId,
    );
    const currentProjectCwd = currentProject?.workspaceRoot ?? null;
    const currentProjectCwdForBrowse =
      browseEnvironmentId && currentProjectEnvironmentId === browseEnvironmentId
        ? currentProjectCwd
        : null;
    const getBrowseCwdForEnvironment = (environmentId: EnvironmentId | null): string | null =>
      environmentId && currentProjectEnvironmentId === environmentId ? currentProjectCwd : null;
    const relativePathNeedsActiveProject =
      isExplicitRelativeProjectPath(query.trim()) && currentProjectCwdForBrowse === null;
    const browseAccess = useFilesystemReadAccess(browseEnvironmentId);
    const hasBrowseTarget =
      isBrowsing &&
      browsePath.directoryPath.length > 0 &&
      browseEnvironmentId !== null &&
      !relativePathNeedsActiveProject;
    const browseQuery = useEnvironmentQuery(
      browseAccess.canReadFiles && hasBrowseTarget
        ? filesystemEnvironment.browse({
            environmentId: browseEnvironmentId,
            input: {
              partialPath: browsePath.directoryPath,
              ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
            },
          })
        : null,
    );
    const browseResult = browseQuery.data;
    const isBrowsePending = hasBrowseTarget && (browseAccess.isPending || browseQuery.isPending);
    const browseAccessError =
      hasBrowseTarget && !browseAccess.isPending && !browseAccess.canReadFiles
        ? (browseAccess.error ?? "This connection cannot browse host folders.")
        : null;
    const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
    const { visibleEntries: visibleBrowseEntries, exactEntry: exactBrowseEntry } =
      pinnedCloneDirectoryName
        ? filterPinnedBrowseEntries({
            browseEntries,
            filterQuery: browsePath.filterQuery,
            pinnedDirectoryName: pinnedCloneDirectoryName,
            caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
          })
        : filterFilesystemBrowseEntries(browseEntries, browsePath.filterQuery);

    const prefetchBrowsePath = async (
      partialPath: string,
      environmentId: EnvironmentId | null = browseEnvironmentId,
      cwd: string | null = currentProjectCwdForBrowse,
    ): Promise<void> => {
      if (!environmentId) {
        return;
      }
      const environment = environments.find((candidate) => candidate.environmentId === environmentId);
      if (
        !readEnvironmentScope(environmentId, AuthFilesystemReadScope) ||
        !canPreloadBrowsePath(environment?.connection.phase)
      ) {
        return;
      }

      await loadBrowsePath({
        environmentId,
        input: {
          partialPath,
          ...(cwd ? { cwd } : {}),
        },
      });
    };

  return { navigate, pathname, openChildSearch, setOpen, linkedThreadSearch, hiddenKeys, hidingAnywhere, linkedThreadRefs, dispatchSearch, query, viewStack, setQuery, deferredQuery, isActionsOnly, highlightedItemValue, setHighlightedItemValue, resultListRef, highlightClearedRef, clearTypedHighlight, clientSettings, createProject, updateProject, scratchWorkspaceRootFor, startScratchThread, startTriage, lookupRepository, startProjectClone, stopThreadSession, refreshProviders, environments, desktopLocalBootstraps, primaryEnvironmentId, availableSettingsSearchItems, activeDraftThread, activeThread, defaultProjectRef, handleNewThread, paletteRouteTarget, projects, activeThreadServerConfig, canShareActiveThreadWithGuest, activeThreadReferenceCopyTarget, copyActiveThreadReference, threads, keybindings, providersByEnvironment, changeThemeItem, changeAppearanceItem, themeEditorItem, currentView, threadSearchQuery, browseGeneration, setBrowseGeneration, browseNavigation, addProjectEnvironmentId, setAddProjectEnvironmentId, isPickingProjectFolder, setIsPickingProjectFolder, addProjectCloneFlow, setAddProjectCloneFlow, newProjectFlow, setNewProjectFlow, newProjectPublishes, setNewProjectPublishes, newProjectPublishKind, setNewProjectPublishKind, isCreatingNewProject, setIsCreatingNewProject, newProjectSubmittingRef, createNewProject, cloneLookupGeneration, nextCloneLookupGeneration, isCurrentCloneLookupGeneration, isRemoteProjectLookingUp, setIsRemoteProjectLookingUp, isRemoteProjectCloning, setIsRemoteProjectCloning, environmentLabelById, projectEnvironmentLocationById, projectGroups, contextualProjectRef, projectPickerEntries, pickerProjects, projectGroupByTargetKey, canPinProjectGroup, toggleProjectGroupPin, rowOrderKey, projectPin, addProjectEnvironmentOptions, defaultAddProjectEnvironmentId, wslAddProjectEnvironmentOption, browseEnvironmentId, canCreateProject, browseEnvironment, browseEnvironmentIsDesktopLocal, browseDesktopInstanceId, sourceControlDiscovery, browseEnvironmentPlatform, isRemoteProjectCloneFlow, pinnedCloneDirectoryName, canBrowsePaths, browsePath, isBrowsing, browseDirectoryPath, paletteMode, getAddProjectInitialQueryForEnvironment, projectByKey, activeThreadKey, supportsThreadFind, scratchTargetEnvironmentId, triageEnvironmentId, canTriage, currentProject, currentProjectCwdForBrowse, getBrowseCwdForEnvironment, relativePathNeedsActiveProject, browseResult, isBrowsePending, browseAccessError, visibleBrowseEntries, exactBrowseEntry, prefetchBrowsePath };
}
