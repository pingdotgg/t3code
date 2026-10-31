import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
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
  normalizePastedCloneUrl,
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  addProjectRemoteSourceProvider,
  sortAddProjectProviderSources,
  type AddProjectRemoteSource,
  type AddProjectRemoteSourceReadiness,
} from "@t3tools/client-runtime/operations/projects";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { resolveThreadReferenceCopyTarget } from "@t3tools/client-runtime/thread-reference";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
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
import { useLocation, useNavigate } from "@tanstack/react-router";
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
import { openThreadFind } from "./chat/threadFindStore";
import {
  useDeferredValue,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { copyThreadReference } from "../lib/copyThreadReference";
import {
  queueWorkspaceFocusFromPalette,
  restoreWorkspaceFocusFromPalette,
} from "../lib/workspaceFocus";
import {
  composerPromptLink,
  copyPromptLink,
  promptLinkRepositoryOf,
} from "./promptLinks/copyPromptLink";
import { useClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import { readLocalApi } from "../localApi";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { filesystemEnvironment, useFilesystemReadAccess } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useScratchProject } from "../hooks/useScratchProject";
import { useStartTriage } from "../hooks/useStartTriage";
import { pickTriageEnvironment } from "../lib/triageTarget";
import { useNewProject } from "../hooks/useNewProject";
import { useOrderWhileOpen } from "../hooks/useOrderWhileOpen";
import { reportProjectFailure, useProjectPin } from "../hooks/useProjectGroupUpdate";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useProjects, useServerConfigs, useThreadShells, waitForProject } from "../state/entities";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
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
  dispatchCommandPalette,
  getCommandPaletteReturnFocus,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { PULL_REQUESTS_PANEL_REF, useRightPanelStore } from "../rightPanelStore";
import { getLatestThreadForProject, sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import {
  cn,
  getLocalFileManagerName,
  isMacPlatform,
  isWindowsPlatform,
  newProjectId,
} from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../wslPaths";
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
} from "./CommandPalette.logic";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  selectCommandPaletteClientSettings,
  useEnvironmentLookups,
  useProjectLookups,
  useSortedProjectGroups,
} from "./CommandPaletteLookups";
import {
  buildNewThreadInProjectItems,
  buildProjectSearchItems,
} from "./CommandPaletteProjectItems";
import {
  CommandPaletteSubmitButton,
  NewProjectPublishHostPicker,
  NewProjectSummary,
  RemoteRepositorySummary,
  remoteProjectSourceIcon,
  sourceControlHostIcon,
} from "./CommandPaletteAddProject";
import { useCommandPaletteThreadItems } from "./CommandPaletteThreadItems";
import { useCommandPaletteThemeItems } from "./CommandPaletteThemeItems";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Checkbox } from "./ui/checkbox";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { openLinkPullRequestDialog } from "./pullRequest/LinkPullRequestDialog";
import { canShareWithGuestAtom } from "./chat/guestShareAvailability";
import { openGuestShareDialog } from "./chat/guestShareDialogState";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import { settingsForThisPlatform, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import { primaryServerKeybindingsAtom } from "../state/server";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "./ui/command";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { suggestAppAccessForRemote } from "./sourceControlAppAccessToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { buildSidebarProjectPickerEntries } from "../sidebarProjectGrouping";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "~/components/pullRequest/pullRequestListPreferences";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { threadRecentUse } from "@t3tools/shared/paletteSearch";

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

const NEW_THREAD_NO_PROJECT_VALUE = "new-thread-in:no-project";

export function CommandPalette({ children }: { children: ReactNode }) {
  useCommandPaletteMount();
  const state = useCommandPaletteStore();
  const setOpen = (open: boolean) => dispatchCommandPalette({ _tag: "SetOpen", open });
  const openChildSearch = (mode: "files" | "content", context: CommandPaletteReturnContext) =>
    dispatchCommandPalette({ _tag: "OpenChildSearch", mode, context });
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            dispatchCommandPalette({ _tag: "BackToCommand" });
            return;
          }
          setOpen(open);
        }}
      >
        <div className="contents" inert={state.open}>
          {children}
        </div>
        <CommandPaletteDialog
          mode={state.mode}
          session={state.session}
          openIntent={state.openIntent}
          setOpen={setOpen}
          openChildSearch={openChildSearch}
          initialContext={state.restoredSearch}
        />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly mode: SearchOverlayMode;
  readonly session: number;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openChildSearch: (
    mode: "files" | "content",
    context: CommandPaletteReturnContext,
  ) => void;
  readonly initialContext: CommandPaletteReturnContext | undefined;
}) {
  const composerHandleRef = useComposerHandleContext();

  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? "File picker"
          : props.mode === "content"
            ? "Search project contents"
            : "Command palette"
      }
      className={cn("overflow-hidden", props.mode === "content" && "h-105")}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        if (restoreWorkspaceFocusFromPalette()) return false;
        const returnFocus = getCommandPaletteReturnFocus();
        if (returnFocus === false) return false;
        const composer = composerHandleRef?.current;
        // Behind the Settings modal the composer is inert and cannot take focus.
        if (!composer || document.querySelector("[data-app-modal]")) return returnFocus;
        composer.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : props.mode === "content" ? (
        <ProjectContentSearchDialog onOpenChange={props.setOpen} />
      ) : (
        <OpenCommandPaletteDialog
          key={props.session}
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openChildSearch={props.openChildSearch}
          initialContext={props.initialContext}
        />
      )}
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openChildSearch: (
    mode: "files" | "content",
    context: CommandPaletteReturnContext,
  ) => void;
  readonly initialContext: CommandPaletteReturnContext | undefined;
}) {
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
        });
  const copyActiveThreadReference = async () => {
    if (activeThreadReferenceCopyTarget === null) return;
    await copyThreadReference(activeThreadReferenceCopyTarget);
  };
  const threads = useThreadShells();
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
  const browsePath = getFilesystemBrowsePath(
    query,
    browseEnvironmentPlatform,
    browseEnvironmentId !== null && !isRemoteProjectRepositoryStep && newProjectFlow === null,
  );
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates the browse navigation coordinator and in-flight clone lookups when the palette session unmounts
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
    setQuery(nextQuery);
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

  const buildAddProjectSourceGroups = (
    environmentId: EnvironmentId,
    readinessBySource: AddProjectRemoteSourceReadiness,
  ): CommandPaletteView["groups"] => {
    const sourceItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
      {
        kind: "action",
        value: `action:add-project:${environmentId}:local`,
        searchTerms: ["local", "folder", "directory", "browse"],
        title: "Local folder",
        description: "Browse a folder on disk",
        icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => {
          await startAddProjectBrowse(environmentId);
        },
      },
    ];

    if (newProjectsRootFor(environmentId) !== null) {
      sourceItems.unshift({
        kind: "action",
        value: `action:add-project:${environmentId}:new`,
        searchTerms: ["new project", "create", "empty", "repository", "git init"],
        title: "New project",
        description: "Start a new Git repository from a name",
        icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => {
          startNewProject(environmentId, environmentId);
        },
      });
    }

    const orderedSources: ReadonlyArray<AddProjectRemoteSource> = [
      "url",
      ...sortAddProjectProviderSources(readinessBySource),
    ];

    for (const source of orderedSources) {
      const label = addProjectRemoteSourceLabel(source);
      const title = source === "url" ? "Git URL" : `${label} repository`;
      const description =
        source === "url"
          ? "Clone from a remote URL"
          : `Clone ${label} ${addProjectRemoteSourcePathHint(source)}`;
      const readiness = readinessBySource(source);
      const disabledHint = readiness.hint;

      const titleTrailingContent = readiness.ready ? undefined : (
        <span className="ml-auto">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="warning-outline"
                  size="micro"
                  onClick={() => {
                    openSourceControlSettings();
                  }}
                >
                  Setup Required
                </Button>
              }
            />
            <TooltipPopup align="end" side="left">
              {disabledHint ?? "Open Settings -> Source control to configure this provider."}
            </TooltipPopup>
          </Tooltip>
        </span>
      );

      if (!readiness.ready) {
        sourceItems.push({
          kind: "action",
          value: `action:add-project:${environmentId}:${source}:not-ready`,
          searchTerms: ["clone", "remote", "repository", "repo", "git", label, "setup required"],
          title,
          description,
          disabled: true,
          icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
          ...(titleTrailingContent ? { titleTrailingContent } : {}),
          run: async () => {},
        });
        continue;
      }

      sourceItems.push({
        kind: "action",
        value: `action:add-project:${environmentId}:${source}`,
        searchTerms: ["clone", "remote", "repository", "repo", "git", label],
        title,
        description,
        icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
        ...(titleTrailingContent ? { titleTrailingContent } : {}),
        keepOpen: true,
        run: async () => {
          startAddProjectClone(environmentId, source);
        },
      });
    }

    return [{ value: `sources:${environmentId}`, label: "Sources", items: sourceItems }];
  };

  const startAddProjectSourceSelection = (environmentId: EnvironmentId): void => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Environment unavailable",
          description: `${environment?.label ?? "The selected environment"} is not connected.`,
        }),
      );
      return;
    }
    setAddProjectEnvironmentId(environmentId);
    setAddProjectCloneFlow(null);
    pushPaletteView({
      addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
      groups: buildAddProjectSourceGroups(
        environmentId,
        buildPaletteRemoteSourceReadiness(
          browseEnvironmentId === environmentId ? sourceControlDiscovery.data : null,
        ),
      ),
    });
  };

  const buildEnvironmentItem = (
    option: AddProjectEnvironmentOption,
    value: string,
    run: (environmentId: EnvironmentId) => void,
  ): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [option.label, option.environmentId, option.isPrimary ? "this device" : ""],
    title: option.label,
    description: option.isConnected
      ? option.isPrimary
        ? "This device"
        : option.environmentId
      : option.status,
    disabled: !option.isConnected,
    icon: <EnvironmentMachineIcon kind={option.machine} className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      run(option.environmentId);
    },
  });
  const addProjectEnvironmentItems = addProjectEnvironmentOptions.map((option) =>
    buildEnvironmentItem(
      option,
      `action:add-project:environment:${option.environmentId}`,
      startAddProjectSourceSelection,
    ),
  );
  const newProjectEnvironmentOptions = addProjectEnvironmentOptions.filter(
    (option) => option.isConnected && newProjectsRootFor(option.environmentId) !== null,
  );

  const addProjectEnvironmentGroups = [
    {
      value: "environments",
      label: "Environments",
      items: addProjectEnvironmentItems,
    },
  ];

  const openConnectionSettings = () => {
    setOpen(false);
    void navigate({ to: "/settings/connections" });
  };
  const addProjectEntry = resolveAddProjectEntry(
    addProjectEnvironmentOptions,
    defaultAddProjectEnvironmentId,
  );

  const openAddProjectFlow = () => {
    switch (addProjectEntry.kind) {
      case "connect-environment":
        openConnectionSettings();
        return;
      case "choose-environment":
        pushPaletteView({
          addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
          groups: addProjectEnvironmentGroups,
        });
        return;
      case "choose-source":
        startAddProjectSourceSelection(addProjectEntry.environmentId);
        return;
    }
  };

  // The view an "Add project" intent opens to follows the environments as they
  // connect, so it resolves here instead of being fixed when the palette opened.
  const addProjectEntryGroups = (): ReadonlyArray<CommandPaletteGroup> => {
    switch (addProjectEntry.kind) {
      case "connect-environment":
        return [
          {
            value: ADD_PROJECT_ENTRY_GROUP,
            label: "",
            items: [
              {
                kind: "action",
                value: "action:add-project:connect-environment",
                searchTerms: ["connect", "environment", "connection", "settings"],
                title: "Connect an environment",
                description: "No connected environment can add a project",
                icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
                keepOpen: true,
                run: async () => {
                  openConnectionSettings();
                },
              },
            ],
          },
        ];
      case "choose-environment":
        return addProjectEnvironmentGroups;
      case "choose-source":
        return buildAddProjectSourceGroups(
          addProjectEntry.environmentId,
          buildPaletteRemoteSourceReadiness(
            browseEnvironmentId === addProjectEntry.environmentId
              ? sourceControlDiscovery.data
              : null,
          ),
        );
    }
  };

  const openNewProjectFlow = () => {
    const firstOption = newProjectEnvironmentOptions[0];
    if (firstOption) startNewProject(firstOption.environmentId, null);
  };

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (projects.length > 0) {
    const activeProjectTitle =
      projectPickerEntries.find((entry) => entry.isPreferred)?.group.displayName ??
      currentProject?.title ??
      null;

    if (activeProjectTitle) {
      actionItems.push({
        kind: "action",
        value: "action:new-thread",
        searchTerms: ["new thread", "chat", "create", "draft"],
        title: (
          <>
            New thread in <span className="font-semibold">{activeProjectTitle}</span>
          </>
        ),
        searchTitle: `New thread in ${activeProjectTitle}`,
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.newLocal",
        run: async () => {
          await startNewThreadFromContext({
            activeDraftThread,
            activeThread: activeThread ?? undefined,
            defaultProjectRef,
            handleNewThread,
          });
        },
      });
    }

    actionItems.push({
      kind: "submenu",
      value: "action:new-thread-in",
      searchTerms: ["new thread", "project", "pick", "choose", "select"],
      title: "New thread in...",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: NEW_THREAD_IN_GROUP, label: "Projects", items: projectThreadItems }],
    });
  }

  if (scratchTargetEnvironmentId !== null) {
    actionItems.push({
      kind: "action",
      value: "action:new-thread-without-project",
      searchTerms: ["new thread", "no project", "without project", "none", "chat"],
      title: "New thread without a project",
      icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.newWithoutProject",
      run: () => startScratchThread(scratchTargetEnvironmentId),
    });
  }

  if (triageEnvironmentId !== null && canTriage) {
    actionItems.push({
      kind: "action",
      value: "action:triage",
      searchTerms: ["triage", "bug", "issue", "report", "broken", "debug", "help", "support"],
      title: "Triage an issue",
      description: "An agent investigates a T3 Code problem and helps file an issue",
      icon: <BugIcon className={ITEM_ICON_CLASS} />,
      run: () => startTriage(triageEnvironmentId),
    });
  }

  if (activeThreadKey !== null && supportsThreadFind) {
    actionItems.push({
      kind: "action",
      value: "find-current-thread",
      title: "Find in current thread",
      searchTerms: ["find", "search", "messages", "plans"],
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.find",
      run: async () => {
        openThreadFind(activeThreadKey);
      },
    });
  }

  const promptLinkTarget = paletteRouteTarget
    ? paletteRouteTarget.kind === "server"
      ? paletteRouteTarget.threadRef
      : paletteRouteTarget.draftId
    : null;
  const promptLinkProjectRef = activeThread ?? activeDraftThread;
  const promptLinkInput =
    promptLinkTarget === null
      ? null
      : {
          target: promptLinkTarget,
          project: projects.find(
            (project) =>
              project.environmentId === promptLinkProjectRef?.environmentId &&
              project.id === promptLinkProjectRef.projectId,
          ),
          providers:
            (promptLinkProjectRef
              ? providersByEnvironment.get(promptLinkProjectRef.environmentId)
              : undefined) ?? [],
          threadModelSelection: activeThread?.modelSelection ?? null,
        };
  const plainPromptLink = promptLinkInput
    ? composerPromptLink({ ...promptLinkInput, withContext: false })
    : null;
  if (promptLinkInput !== null && plainPromptLink !== null) {
    actionItems.push({
      kind: "action",
      value: "action:copy-prompt-link",
      searchTerms: ["copy", "share", "prompt", "link"],
      title: "Copy prompt link",
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      run: () => copyPromptLink(plainPromptLink),
    });
    if (promptLinkRepositoryOf(promptLinkInput.project) !== null) {
      const contextLink = composerPromptLink({ ...promptLinkInput, withContext: true });
      if (contextLink !== null) {
        actionItems.push({
          kind: "action",
          value: "action:copy-prompt-link-with-context",
          searchTerms: ["copy", "share", "prompt", "link", "repository", "model"],
          title: "Copy prompt link with repo and model",
          icon: <LinkIcon className={ITEM_ICON_CLASS} />,
          run: () => copyPromptLink(contextLink),
        });
      }
    }
  }

  if (activeThreadReferenceCopyTarget !== null) {
    actionItems.push({
      kind: "action",
      value: "action:copy-thread-reference",
      searchTerms:
        activeThreadReferenceCopyTarget.kind === "pull-request"
          ? ["copy", "pull request", "link", "reference"]
          : ["copy", "thread", "thread id", "reference"],
      title:
        activeThreadReferenceCopyTarget.kind === "pull-request" ? "Copy PR link" : "Copy thread",
      description: activeThreadReferenceCopyTarget.description,
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.copyReference",
      run: copyActiveThreadReference,
    });
  }

  if (
    activeThread !== null &&
    threadPullRequestLinkMode(activeThreadServerConfig?.environment.capabilities) !== "unsupported"
  ) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push({
      kind: "action",
      value: "action:link-pull-request",
      searchTerms: ["link", "pull request", "pr", "attach", "stack"],
      title: "Link pull request to thread",
      icon: <PullRequestGlyph.link className={ITEM_ICON_CLASS} />,
      run: async () => {
        openLinkPullRequestDialog(threadRef);
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:open-thread-pull-requests",
      searchTerms: ["pull requests", "linked", "stack", "prs"],
      title: "Show linked pull requests",
      disabled: visibleThreadPullRequests(activeThread.pullRequests).length === 0,
      icon: <PullRequestGlyph.link className={ITEM_ICON_CLASS} />,
      run: async () => {
        useRightPanelStore.getState().open(threadRef, "pull-requests");
      },
    });
  }

  if (activeThread !== null && canShareActiveThreadWithGuest) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push({
      kind: "action",
      value: "action:share-thread-with-guest",
      searchTerms: ["share", "guest", "invite", "link", "teammate"],
      title: "Share with guest",
      icon: <UserPlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openGuestShareDialog(threadRef);
      },
    });
  }

  if (activeThread !== null) {
    const thread = activeThread;
    actionItems.push({
      kind: "action",
      value: "action:restart-agent-session",
      searchTerms: ["restart", "reset", "reload", "agent", "session", "skills", "plugins", "mcp"],
      title: "Restart agent session",
      icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const { environmentId } = thread;
        if (thread.runtime !== null) {
          const stopped = await stopThreadSession({
            environmentId,
            input: { threadId: thread.id },
          });
          if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
        }
        toastManager.add({
          type: "success",
          title: "Agent session will restart",
          description: "Your next message starts a fresh session.",
        });
        const project = projectByKey.get(`${environmentId}:${thread.projectId}`);
        if (!project) return;
        const refreshed = await refreshProviders({
          environmentId,
          input: {
            instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
            cwd: thread.worktreePath ?? project.workspaceRoot,
            fresh: true,
          },
        });
        if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:open-file-picker",
    searchTerms: ["go to file", "open file", "file picker", "find file", "quick open"],
    title: "Go to file",
    icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "filePicker.toggle",
    run: async () => {
      openChildSearch("files", { query, linkedThreadSearch });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:search-project-contents",
    searchTerms: ["search project", "find in files", "grep", "content search", "text search"],
    title: "Search project contents",
    icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "projectSearch.toggle",
    run: async () => {
      openChildSearch("content", { query, linkedThreadSearch });
    },
  });

  if (newProjectEnvironmentOptions.length > 0) {
    actionItems.push({
      kind: "action",
      value: "action:new-project",
      searchTerms: ["new project", "create project", "empty", "repository", "repo", "git init"],
      title: "New project",
      icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        openNewProjectFlow();
      },
    });
  }

  const addProjectAction: CommandPaletteActionItem = {
    kind: "action",
    value: "action:add-project",
    searchTerms: [
      "add project",
      "folder",
      "directory",
      "browse",
      "clone",
      "remote",
      "repository",
      "repo",
      "git",
      ...sourceControlClients.definitions.flatMap((definition) =>
        definition.pickerLabel
          .toLowerCase()
          .split(/[^a-z0-9]+/u)
          .filter(Boolean),
      ),
      "url",
      "environment",
    ],
    title: "Add project",
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      openAddProjectFlow();
    },
  };
  actionItems.push(addProjectAction);

  if (wslAddProjectEnvironmentOption) {
    actionItems.push({
      kind: "action",
      value: "action:add-project:wsl-folder",
      searchTerms: ["add project", "open", "wsl", "linux", "folder", "directory"],
      title: "Open WSL folder",
      description: wslAddProjectEnvironmentOption.label,
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        await startAddProjectBrowse(wslAddProjectEnvironmentOption.environmentId);
      },
    });
  }

  actionItems.push(changeThemeItem);
  actionItems.push(changeAppearanceItem);

  actionItems.push(themeEditorItem);

  if (environments.some((environment) => environment.serverConfig !== null)) {
    actionItems.push({
      kind: "action",
      value: "action:pull-requests",
      searchTerms: [
        ...new Set(
          sourceControlClients.definitions.flatMap((definition) => {
            const shortLabel = definition.changeRequest.shortLabel.toLowerCase();
            return [
              definition.changeRequest.plural,
              `${shortLabel}s`,
              shortLabel,
              ...definition.label.toLowerCase().split(/[^a-z0-9]+/u),
            ].filter(Boolean);
          }),
        ),
        "review",
        "merge",
        "branch",
      ],
      title: "Open pull requests",
      icon: <PullRequestGlyph.pullRequest className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:usage",
    searchTerms: ["usage", "use", "tokens", "cost", "spend", "limits", "stats", "analytics"],
    title: "Open usage",
    icon: <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "usage.open",
    run: async () => {
      await navigate({ to: "/usage" });
    },
  });

  for (const direction of [1, -1] as const) {
    const title = direction === 1 ? "Focus Next Workspace Area" : "Focus Previous Workspace Area";
    actionItems.push({
      kind: "action",
      value: `action:workspace-focus:${direction}`,
      title,
      searchTerms: [title, "accessibility", "navigation", "focus", "F6"],
      icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: direction === 1 ? "workspace.focusNext" : "workspace.focusPrevious",
      run: async () => {
        queueWorkspaceFocusFromPalette(direction);
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: "Open settings",
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings" });
    },
  });

  // Every group, so an archived project's thread still opens its own settings.
  const currentProjectGroup =
    (contextualProjectRef
      ? projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === contextualProjectRef.environmentId &&
              ref.projectId === contextualProjectRef.projectId,
          ),
        )
      : null) ?? null;
  if (currentProjectGroup && canPinProjectGroup(currentProjectGroup)) {
    actionItems.push({
      kind: "action",
      value: "action:project-pin",
      searchTerms: ["pin", "unpin", "project", "favorite"],
      title: currentProjectGroup.pinned ? "Unpin project" : "Pin project",
      description: currentProjectGroup.displayName,
      icon: currentProjectGroup.pinned ? (
        <PinOffIcon className={ITEM_ICON_CLASS} />
      ) : (
        <PinIcon className={ITEM_ICON_CLASS} />
      ),
      run: async () => toggleProjectGroupPin(currentProjectGroup),
    });
  }
  const contextualProjectGroup = currentProjectGroup ?? projectGroups[0] ?? null;
  if (contextualProjectGroup) {
    actionItems.push({
      kind: "action",
      value: "action:project-settings",
      searchTerms: [
        "project",
        "settings",
        "name",
        "icon",
        "scripts",
        "model",
        "workspace",
        "grouping",
        "checkout",
        "remove",
        "t3.json",
      ],
      title: "Project settings",
      description: contextualProjectGroup.displayName,
      icon: <FolderIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/projects/$projectKey",
          params: { projectKey: contextualProjectGroup.projectKey },
        });
      },
    });
  }

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
  // Every setting goes to the palette's own matcher, so settings get the same
  // word starts and typo tolerance as threads.
  const settingsSearchItems: CommandPaletteActionItem[] = settingsForThisPlatform(
    availableSettingsSearchItems,
  ).map((item) => ({
    kind: "action",
    value: `setting:${item.id}`,
    searchTerms: [item.title, SETTINGS_SECTION_LABELS[item.to], ...(item.searchTerms ?? [])],
    title: item.title,
    description: `Settings · ${SETTINGS_SECTION_LABELS[item.to]}`,
    ...(item.secondary ? { secondary: true } : {}),
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({
        to: item.to,
        hash: item.targetId ?? item.id,
        replace: pathname === item.to,
        hashScrollIntoView: false,
      });
    },
  }));
  const sourceSelectionViewValue =
    addProjectEnvironmentId === null ? null : `sources:${addProjectEnvironmentId}`;
  const activeGroups =
    addProjectEnvironmentId !== null &&
    currentView !== null &&
    currentView.groups[0]?.value === sourceSelectionViewValue
      ? buildAddProjectSourceGroups(
          addProjectEnvironmentId,
          buildPaletteRemoteSourceReadiness(sourceControlDiscovery.data),
        )
      : currentView?.groups[0]?.value === ADD_PROJECT_ENTRY_GROUP
        ? addProjectEntryGroups()
        : currentView?.groups[0]?.value === NEW_THREAD_IN_GROUP
          ? [
              {
                value: NEW_THREAD_IN_GROUP,
                label: "Projects",
                // Every project archived and no "No project" home leaves only adding one.
                items: projectThreadItems.length > 0 ? projectThreadItems : [addProjectAction],
              },
            ]
          : currentView?.groups[0]?.value === "themes"
            ? changeThemeItem.groups
            : currentView?.groups[0]?.value === "appearance"
              ? changeAppearanceItem.groups
              : (currentView?.groups ?? rootGroups);

  const isLinkedThreadSearch =
    linkedThreadSearch?.linkedThreads !== undefined && deferredQuery === linkedThreadSearch.query;
  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    ...(deferredQuery.trim().length > 0
      ? {
          allOptions: {
            rootGroups,
            nestedItems: buildNestedSearchItems(actionItems, deferredQuery),
          },
        }
      : {}),
    projectSearchItems: projectSearchItems,
    settingsSearchItems,
    threadSearchItems:
      isLinkedThreadSearch && linkedThreadSearch?.linkedThreads
        ? buildLinkedThreadActionItems({
            ...linkedThreadSearch.linkedThreads,
            query: linkedThreadSearch.query,
            icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
            runThread: async (thread) => {
              await navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              });
            },
          })
        : allThreadItems,
    threadMessageItems: isLinkedThreadSearch ? [] : threadMessageItems,
    now: searchNow,
  });

  const handleAddProjectForEnvironment = async (input: {
    readonly environmentId: EnvironmentId;
    readonly rawCwd: string;
    readonly platform: string;
    readonly currentProjectCwd: string | null;
  }) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === input.environmentId,
    );
    if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Environment unavailable",
          description: `${environment?.label ?? "The selected environment"} is not connected.`,
        }),
      );
      return;
    }
    const rawCwd = input.rawCwd;

    if (isUnsupportedWindowsProjectPath(rawCwd.trim(), input.platform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to add project",
          description: "Windows-style paths are only supported on Windows.",
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawCwd.trim()) && !input.currentProjectCwd) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to add project",
          description: "Relative paths require an active project.",
        }),
      );
      return;
    }

    const cwd = resolveProjectPathForDispatch(rawCwd, input.currentProjectCwd);
    if (cwd.length === 0) return;

    const existing = findProjectByPath(
      projects.filter((project) => project.environmentId === input.environmentId),
      cwd,
    );
    if (existing) {
      // Adding an archived project's folder again brings the project back.
      if (existing.archivedAt != null) {
        void updateProject({
          environmentId: existing.environmentId,
          input: { projectId: existing.id, archived: false },
        }).then((result) => reportProjectFailure("Failed to unarchive project", result));
      }
      const latestThread = getLatestThreadForProject(
        threads.filter((thread) => thread.environmentId === existing.environmentId),
        existing.id,
        clientSettings.sidebarThreadSortOrder,
      );
      if (latestThread && latestThread.settledOverride !== "settled") {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
      } else {
        const navigationResult = await settlePromise(() =>
          handleNewThread(scopeProjectRef(existing.environmentId, existing.id)),
        );
        if (navigationResult._tag === "Failure") {
          const error = squashAtomCommandFailure(navigationResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to open project",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return;
        }
      }
      setOpen(false);
      return;
    }

    if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Cannot add project",
          description: "This connection cannot add projects.",
        }),
      );
      return;
    }
    const projectId = newProjectId();
    const createResult = await createProject({
      environmentId: input.environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(cwd),
        workspaceRoot: cwd,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    });
    if (createResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(createResult)) {
        const error = squashAtomCommandFailure(createResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }

    const navigationResult = await settlePromise(() =>
      handleNewThread(scopeProjectRef(input.environmentId, projectId)),
    );
    if (navigationResult._tag === "Failure") {
      const error = squashAtomCommandFailure(navigationResult);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to add project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    setOpen(false);
  };

  const handleAddProject = async (rawCwd: string) => {
    if (!browseEnvironmentId) return;
    await handleAddProjectForEnvironment({
      environmentId: browseEnvironmentId,
      rawCwd,
      platform: browseEnvironmentPlatform,
      currentProjectCwd: currentProjectCwdForBrowse,
    });
  };

  const newProjectPublishTargets =
    newProjectFlow === null ? [] : getNewProjectPublishTargets(sourceControlDiscovery.data ?? null);
  const newProjectPublishTarget = getNewProjectPublishTarget(
    newProjectPublishTargets,
    newProjectPublishKind,
  );
  const newProjectName = query.trim();
  const canSubmitNewProject =
    newProjectFlow !== null &&
    newProjectName.length > 0 &&
    !isCreatingNewProject &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);

  async function submitNewProject(): Promise<void> {
    if (newProjectFlow === null || !canSubmitNewProject || newProjectSubmittingRef.current) {
      return;
    }
    newProjectSubmittingRef.current = true;
    setIsCreatingNewProject(true);
    const created = await settlePromise(() =>
      createNewProject({
        environmentId: newProjectFlow.environmentId,
        name: newProjectName,
        publishTo: newProjectPublishes ? newProjectPublishTarget : null,
      }),
    );
    newProjectSubmittingRef.current = false;
    setIsCreatingNewProject(false);
    if (created._tag === "Failure") throw squashAtomCommandFailure(created);
    if (created.value) setOpen(false);
  }

  function getDefaultCloneParentPath(environmentId: EnvironmentId): string {
    return getAddProjectInitialQueryForEnvironment(environmentId);
  }

  async function submitAddProjectCloneFlow(destinationPathInput?: string): Promise<void> {
    if (!addProjectCloneFlow) {
      return;
    }
    if (!canCreateProjectInEnvironment(browseEnvironment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Environment unavailable",
          description: `${browseEnvironment?.label ?? "The selected environment"} is not connected.`,
        }),
      );
      return;
    }

    if (addProjectCloneFlow.step === "repository") {
      const rawRepository = query.trim();
      if (rawRepository.length === 0 || isRemoteProjectLookingUp) {
        return;
      }

      const provider = addProjectRemoteSourceProvider(addProjectCloneFlow.source);
      if (!provider) {
        const destinationPath = getCloneDestinationPath(
          getDefaultCloneParentPath(addProjectCloneFlow.environmentId),
          getCloneDirectoryName(rawRepository),
        );
        setAddProjectCloneFlow({
          step: "confirm",
          environmentId: addProjectCloneFlow.environmentId,
          source: addProjectCloneFlow.source,
          repositoryInput: rawRepository,
          repository: null,
          remoteUrl: normalizePastedCloneUrl(rawRepository),
        });
        setHighlightedItemValue(null);
        setQuery(destinationPath);
        setBrowseGeneration((generation) => generation + 1);
        return;
      }

      setIsRemoteProjectLookingUp(true);
      const lookupGeneration = ++cloneLookupGeneration.current;
      const lookupResult = await lookupRepository({
        environmentId: addProjectCloneFlow.environmentId,
        input: {
          provider,
          repository: rawRepository,
        },
      });
      if (lookupGeneration !== cloneLookupGeneration.current) return;
      setIsRemoteProjectLookingUp(false);
      if (lookupResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(lookupResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Repository lookup failed",
              description: errorMessage(squashAtomCommandFailure(lookupResult)),
            }),
          );
        }
        return;
      }
      const repository = lookupResult.value;
      const destinationPath = getCloneDestinationPath(
        getDefaultCloneParentPath(addProjectCloneFlow.environmentId),
        getCloneDirectoryName(repository.nameWithOwner),
      );
      setAddProjectCloneFlow({
        step: "confirm",
        environmentId: addProjectCloneFlow.environmentId,
        source: addProjectCloneFlow.source,
        repositoryInput: rawRepository,
        repository,
        remoteUrl: getDefaultCloneUrl(repository),
      });
      setHighlightedItemValue(null);
      setQuery(destinationPath);
      setBrowseGeneration((generation) => generation + 1);
      return;
    }

    const rawDestination = (destinationPathInput ?? query).trim();
    if (
      !readEnvironmentScope(addProjectCloneFlow.environmentId, AuthSourceControlWriteScope) ||
      !readEnvironmentScope(addProjectCloneFlow.environmentId, AuthOrchestrationOperateScope)
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone unavailable",
          description: "This connection needs permission to write source control and add projects.",
        }),
      );
      return;
    }
    if (rawDestination.length === 0 || isRemoteProjectCloning) return;

    if (isUnsupportedWindowsProjectPath(rawDestination, browseEnvironmentPlatform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: "Windows-style paths are only supported on Windows.",
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawDestination) && !currentProjectCwdForBrowse) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: "Relative paths require an active project.",
        }),
      );
      return;
    }

    const destinationPath = resolveProjectPathForDispatch(
      rawDestination,
      currentProjectCwdForBrowse,
    );
    if (destinationPath.length === 0) {
      return;
    }

    const projectId = newProjectId();
    setIsRemoteProjectCloning(true);
    const startResult = await startProjectClone({
      environmentId: addProjectCloneFlow.environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(destinationPath),
        // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
        createdAt: new Date().toISOString(),
        remoteUrl: addProjectCloneFlow.remoteUrl,
        destinationPath,
      },
    });
    setIsRemoteProjectCloning(false);
    if (startResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(startResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone failed",
            description: errorMessage(squashAtomCommandFailure(startResult)),
          }),
        );
      }
      return;
    }
    setOpen(false);
    void suggestAppAccessForRemote(
      addProjectCloneFlow.environmentId,
      addProjectCloneFlow.remoteUrl,
    );
    const projectRef = scopeProjectRef(addProjectCloneFlow.environmentId, projectId);
    await waitForProject(projectRef, 3_000).catch(() => null);
    const navigationResult = await settlePromise(() => handleNewThread(projectRef));
    if (navigationResult._tag === "Failure") {
      const error = squashAtomCommandFailure(navigationResult);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to open project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }

  const browseTo = async (name: string): Promise<void> => {
    const nextQuery = pinnedCloneDirectoryName
      ? getCloneDestinationBrowsePath({
          browseDirectoryPath: browsePath.directoryPath,
          selectedDirectoryName: name,
          cloneDirectoryName: pinnedCloneDirectoryName,
          caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
        })
      : appendBrowsePathSegment(query, name);
    await browseNavigation.run(
      () => prefetchBrowsePath(getBrowseDirectoryPath(nextQuery)),
      () => {
        setHighlightedItemValue(null);
        setQuery(nextQuery);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  };

  const browseUp = async (): Promise<void> => {
    const parentPath = browsePath.parentPath;
    if (parentPath === null) {
      return;
    }

    const nextQuery = getCloneDestinationPath(parentPath, pinnedCloneDirectoryName);
    await browseNavigation.run(
      () => prefetchBrowsePath(parentPath),
      () => {
        setHighlightedItemValue(null);
        setQuery(nextQuery);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  };

  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? query.trim());

  const canBrowseUp = !relativePathNeedsActiveProject && browsePath.canBrowseUp;

  const browseGroups = buildBrowseGroups({
    browseEntries: visibleBrowseEntries,
    browseQuery: query,
    canBrowseUp,
    upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
    directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
    browseUp,
    browseTo,
  });
  const cloneDestinationBrowseGroups = browseGroups.map((group) =>
    group.value === "directories" ? { ...group, label: "Select where to clone" } : group,
  );

  const newProjectsRoot = newProjectFlow ? newProjectsRootFor(newProjectFlow.environmentId) : null;
  const newProjectPathPreview =
    newProjectsRoot === null ? null : getNewProjectPathPreview(newProjectsRoot, newProjectName);
  const newProjectPublishToggleValue = "new-project:publish";
  const showExistingProjectSources = (environmentId: EnvironmentId) => {
    const sourcesEnvironmentId = newProjectFlow?.sourcesEnvironmentId ?? null;
    if (sourcesEnvironmentId === environmentId) {
      popView();
      return;
    }
    if (sourcesEnvironmentId !== null) {
      dispatchSearch({ type: "back" });
    }
    popView();
    startAddProjectSourceSelection(environmentId);
  };
  const switchNewProjectEnvironment = (environmentId: EnvironmentId) => {
    setNewProjectFlow((flow) => (flow === null ? flow : { ...flow, environmentId }));
    setAddProjectEnvironmentId(environmentId);
  };
  const selectedNewProjectEnvironment =
    newProjectFlow === null
      ? undefined
      : newProjectEnvironmentOptions.find(
          (option) => option.environmentId === newProjectFlow.environmentId,
        );
  const showNewProjectMachines =
    newProjectFlow !== null &&
    (newProjectEnvironmentOptions.length > 1 ||
      (selectedNewProjectEnvironment === undefined && newProjectEnvironmentOptions.length > 0));
  const newProjectEnvironmentLabel = showNewProjectMachines
    ? (selectedNewProjectEnvironment?.label ??
      environmentLabelById.get(newProjectFlow.environmentId) ??
      null)
    : null;
  const newProjectMachineGroup: CommandPaletteView["groups"][number] | null =
    !showNewProjectMachines || newProjectFlow === null
      ? null
      : {
          value: "new-project-machines",
          label: "Environments",
          items: newProjectEnvironmentOptions.map((option) => ({
            ...buildEnvironmentItem(
              option,
              `new-project:environment:${option.environmentId}`,
              switchNewProjectEnvironment,
            ),
            ...(isCreatingNewProject ? { disabled: true } : {}),
            ...(option.environmentId === newProjectFlow.environmentId
              ? {
                  titleTrailingContent: (
                    <CheckIcon className="ms-auto size-4 shrink-0 text-muted-foreground/70" />
                  ),
                }
              : {}),
          })),
        };
  const newProjectExistingGroup: CommandPaletteView["groups"][number] | null =
    newProjectFlow === null
      ? null
      : {
          value: "new-project-existing",
          label: "",
          items: [
            {
              kind: "action",
              value: "new-project:existing",
              searchTerms: [],
              title: "Add existing project",
              description: "Open a folder or clone a repository",
              icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
              titleTrailingContent: (
                <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
              ),
              keepOpen: true,
              run: async () => {
                showExistingProjectSources(newProjectFlow.environmentId);
              },
            },
          ],
        };
  const newProjectOptionGroups: CommandPaletteView["groups"] =
    newProjectPublishTarget === null || newProjectPathPreview === null
      ? []
      : [
          {
            value: "new-project-options",
            label: "Options",
            items: [
              {
                kind: "action",
                value: newProjectPublishToggleValue,
                searchTerms: [],
                title:
                  newProjectPublishTargets.length > 1
                    ? "Create private repository"
                    : `Create private repository on ${newProjectPublishTarget.definition.label}`,
                description:
                  newProjectName.length > 0
                    ? getNewProjectRepository(newProjectPublishTarget, newProjectPathPreview)
                    : (newProjectPublishTarget.owner ??
                      `Your ${newProjectPublishTarget.definition.label} account`),
                icon: sourceControlHostIcon(newProjectPublishTarget.definition, ITEM_ICON_CLASS),
                titleTrailingContent: (
                  <span className="ms-auto flex items-center gap-2">
                    {newProjectPublishTargets.length > 1 ? (
                      <NewProjectPublishHostPicker
                        disabled={isCreatingNewProject}
                        targets={newProjectPublishTargets}
                        value={newProjectPublishTarget.definition.kind}
                        onValueChange={setNewProjectPublishKind}
                      />
                    ) : null}
                    <span className="pointer-events-none flex">
                      <Checkbox checked={newProjectPublishes} tabIndex={-1} aria-hidden />
                    </span>
                  </span>
                ),
                ...(isCreatingNewProject ? { disabled: true } : {}),
                keepOpen: true,
                run: async () => {
                  setNewProjectPublishes((publishes) => !publishes);
                },
              },
            ],
          },
        ];

  let displayedGroups: CommandPaletteView["groups"] = filteredGroups;
  if (newProjectFlow !== null) {
    displayedGroups = [
      ...(newProjectMachineGroup ? [newProjectMachineGroup] : []),
      ...newProjectOptionGroups,
      ...(newProjectExistingGroup ? [newProjectExistingGroup] : []),
    ];
  } else if (addProjectCloneFlow?.step === "repository") {
    displayedGroups = [];
  } else if (addProjectCloneFlow?.step === "confirm") {
    displayedGroups = relativePathNeedsActiveProject ? [] : cloneDestinationBrowseGroups;
  } else if (isBrowsing) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  }
  const resultRows = buildCommandPaletteRows(displayedGroups);
  const autoHighlightsFirstRow =
    !isBrowsing && !isRemoteProjectCloneFlow && newProjectFlow === null;

  const inputPlaceholder =
    newProjectFlow !== null
      ? "Project name"
      : (remoteProjectInputPlaceholder(addProjectCloneFlow) ??
        getCommandPaletteInputPlaceholder(paletteMode));
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canWriteSourceControl = useEnvironmentScope(
    addProjectCloneFlow?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canCreateClonedProject = useEnvironmentScope(
    addProjectCloneFlow?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canCloneProject = canWriteSourceControl && canCreateClonedProject;
  const isCloneDestinationStep = addProjectCloneFlow?.step === "confirm";
  const canSubmitBrowsePath =
    isBrowsing &&
    !relativePathNeedsActiveProject &&
    canCreateProject &&
    (!isCloneDestinationStep || canCloneProject) &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);
  const willCreateProjectPath =
    canSubmitBrowsePath &&
    !isBrowsePending &&
    browseAccessError === null &&
    query.trim().length > 0 &&
    !hasHighlightedBrowseItem &&
    (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
  const useMetaForMod = isMacPlatform(navigator.platform);
  const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
  const submitActionLabel = isCloneDestinationStep
    ? willCreateProjectPath
      ? "Create & Clone"
      : "Clone"
    : willCreateProjectPath
      ? "Create & Add"
      : "Add";
  const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
  const hasHighlightedNewProjectItem = newProjectFlow !== null && highlightedItemValue !== null;
  const createShortcutLabel = hasHighlightedNewProjectItem
    ? `${submitModifierLabel} Enter`
    : "Enter";
  const remoteProjectButtonLabel = addProjectCloneFlow
    ? addProjectCloneFlow.source === "url"
      ? "Continue"
      : "Lookup"
    : null;
  const isRemoteProjectPending = isRemoteProjectLookingUp || isRemoteProjectCloning;
  const canSubmitRemoteProjectFlow =
    addProjectCloneFlow?.step === "repository" &&
    query.trim().length > 0 &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase) &&
    !isRemoteProjectPending;
  const fileManagerName = getLocalFileManagerName(navigator.platform);
  const canOpenProjectFromFileManager =
    isBrowsing &&
    browseEnvironmentId !== null &&
    (browseEnvironmentId === primaryEnvironmentId ||
      (browseEnvironmentIsDesktopLocal && browseDesktopInstanceId !== null)) &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;
  const fileManagerInitialPath = (() => {
    if (!canOpenProjectFromFileManager) {
      return undefined;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return undefined;
    }

    const initialPath = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? trimmedQuery)
      : browseDirectoryPath || trimmedQuery;

    const resolvedPath = resolveProjectPathForDispatch(initialPath, currentProjectCwdForBrowse);
    return resolvedPath.length > 0 ? resolvedPath : undefined;
  })();

  function isPrimaryModifierPressed(event: KeyboardEvent<HTMLInputElement>): boolean {
    return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
      // Confirming an IME candidate must not submit a path or select a row.
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      return;
    }

    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false, editableFocus: true },
    });
    if (command === "thread.pin") {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ??
          (autoHighlightsFirstRow ? (resultRows.itemValues[0] ?? null) : null),
      );
      if (highlightedItem?.kind === "action" && highlightedItem.pin) {
        event.preventDefault();
        event.stopPropagation();
        highlightedItem.pin.toggle();
        return;
      }
    }
    // Global new-thread handlers ignore shortcuts while the palette is open.
    const isJump = threadJumpIndexFromCommand(command ?? "") !== null;
    const isNewThread =
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229 &&
      (command === "chat.new" ||
        command === "chat.newLocal" ||
        command === "chat.newWithoutProject");
    const matchingItem =
      isJump || isNewThread
        ? displayedGroups
            .flatMap((group) => group.items)
            .find((item) => item.shortcutCommand === command)
        : undefined;
    if (isJump || matchingItem) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      event.stopPropagation();
      if (matchingItem) {
        executeItem(matchingItem);
      }
      return;
    }
    if (command === "thread.copyReference") {
      event.preventDefault();
      event.stopPropagation();
      if (activeThreadReferenceCopyTarget === null) return;
      setOpen(false);
      void copyActiveThreadReference();
      return;
    }
    // ChatView ignores shortcuts while the palette is open, so intercept find here.
    if (command === "chat.find" && activeThreadKey !== null && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      if (supportsThreadFind) openThreadFind(activeThreadKey);
      else
        toastManager.add({
          id: "thread-find-unavailable",
          title: "Thread search is unavailable on this server.",
          description: "Update the server to enable it.",
        });
      return;
    }

    if (addProjectCloneFlow?.step === "repository" && event.key === "Enter") {
      event.preventDefault();
      void submitAddProjectCloneFlow();
      return;
    }

    if (
      newProjectFlow !== null &&
      event.key === "Enter" &&
      (!hasHighlightedNewProjectItem || isPrimaryModifierPressed(event)) &&
      // Enter that confirms an IME composition is part of typing the name.
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      // Base UI would otherwise also click the highlighted row.
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      void submitNewProject();
      return;
    }

    const shouldSubmitBrowsePath =
      canSubmitBrowsePath &&
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

    if (shouldSubmitBrowsePath) {
      event.preventDefault();
      if (isCloneDestinationStep) {
        void submitAddProjectCloneFlow(resolvedAddProjectPath);
      } else {
        void handleAddProject(resolvedAddProjectPath);
      }
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
      return;
    }

    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    const firstItemValue = autoHighlightsFirstRow ? resultRows.itemValues[0] : undefined;
    if (
      event.key === "ArrowDown" &&
      highlightClearedRef.current &&
      firstItemValue &&
      !event.nativeEvent.isComposing
    ) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      highlightClearedRef.current = false;
      setHighlightedItemValue(firstItemValue);
      scrollCommandPaletteRowIntoView(
        resultListRef.current,
        resultRows.rowIndexByItemIndex[0] ?? 0,
      );
      return;
    }

    // Virtualization may unmount the highlighted row; handle Enter directly instead of Base UI's click.
    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ?? firstItemValue ?? null,
      );
      if (highlightedItem) {
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        event.stopPropagation();
        executeItem(highlightedItem);
      }
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushPaletteView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }

  const handleOpenProjectFromFileManager = async () => {
    if (!canOpenProjectFromFileManager || isPickingProjectFolder) {
      return;
    }
    const api = readLocalApi();
    if (!api) {
      return;
    }

    setIsPickingProjectFolder(true);
    let pickedPath: string | null = null;
    let desktopWslState: DesktopWslState | null = null;
    try {
      desktopWslState =
        browseEnvironmentId === primaryEnvironmentId && browseEnvironmentPlatform === "Linux"
          ? ((await window.desktopBridge?.getWslState().catch(() => null)) ?? null)
          : null;
      // WSL-only primaries need their pool id from desktop settings; the native picker converts WSL UNC
      // paths.
      const pickerTargetEnvironmentId = resolveProjectPickerTarget({
        browseEnvironmentId,
        primaryEnvironmentId,
        desktopInstanceId: browseDesktopInstanceId,
        wslConfiguration: desktopWslState,
      });
      const pickerOptions = {
        ...(fileManagerInitialPath ? { initialPath: fileManagerInitialPath } : {}),
        ...(pickerTargetEnvironmentId ? { targetEnvironmentId: pickerTargetEnvironmentId } : {}),
      };
      pickedPath = await api.dialogs.pickFolder(
        Object.keys(pickerOptions).length > 0 ? pickerOptions : undefined,
      );
    } catch {
      setIsPickingProjectFolder(false);
      return;
    }
    setIsPickingProjectFolder(false);
    if (!pickedPath) {
      return;
    }
    if (parseWslUncPath(pickedPath)) {
      if (desktopWslState === null) {
        desktopWslState = (await window.desktopBridge?.getWslState().catch(() => null)) ?? null;
      }
      let primaryRunningDistro: string | null = null;
      try {
        primaryRunningDistro =
          window.desktopBridge
            ?.getLocalEnvironmentBootstraps()
            .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ??
          null;
      } catch {}
      const selection = resolveWslProjectSelection(
        pickedPath,
        applyWslEnvironmentConfiguration(
          environments.flatMap((environment) => {
            const backendId = desktopLocalBackendId(environment.entry.target);
            if (!backendId) {
              return [];
            }

            const bootstrap = desktopLocalBootstraps.find(
              (candidate) => candidate.httpBaseUrl === environment.displayUrl,
            );
            const runningDistro = bootstrap?.runningDistro ?? null;
            return [{ environmentId: environment.environmentId, backendId, runningDistro }];
          }),
          primaryEnvironmentId,
          desktopWslState ?? null,
          primaryRunningDistro,
        ),
      );
      if (!selection) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add WSL project",
            description: "Start the matching WSL backend, then choose the folder again.",
          }),
        );
        return;
      }
      await handleAddProjectForEnvironment({
        environmentId: selection.environmentId,
        rawCwd: selection.linuxPath,
        platform: "Linux",
        currentProjectCwd: null,
      });
      return;
    }
    await handleAddProject(pickedPath);
  };

  const inputAccessory =
    newProjectFlow !== null ? (
      <CommandPaletteSubmitButton
        label={isCreatingNewProject ? "Creating" : "Create"}
        shortcutLabel={createShortcutLabel}
        ariaLabel={`Create (${createShortcutLabel})`}
        tooltip={`Create (${createShortcutLabel})`}
        disabled={!canSubmitNewProject}
        onSubmit={() => {
          void submitNewProject();
        }}
      />
    ) : addProjectCloneFlow?.step === "repository" ? (
      <CommandPaletteSubmitButton
        label={isRemoteProjectPending ? "Working" : remoteProjectButtonLabel}
        shortcutLabel="Enter"
        ariaLabel={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
        tooltip={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
        disabled={!canSubmitRemoteProjectFlow}
        onSubmit={() => {
          void submitAddProjectCloneFlow();
        }}
      />
    ) : isBrowsing ? (
      <CommandPaletteSubmitButton
        label={isCloneDestinationStep && isRemoteProjectPending ? "Cloning" : submitActionLabel}
        shortcutLabel={addShortcutLabel}
        ariaLabel={`${submitActionLabel} (${addShortcutLabel})`}
        tooltip={
          isCloneDestinationStep && !canCloneProject
            ? "This connection needs permission to write source control and add projects."
            : canCreateProject
              ? `${submitActionLabel} (${addShortcutLabel})`
              : "This connection cannot add projects."
        }
        disabled={
          !canCreateProject ||
          !canCreateProjectInEnvironment(browseEnvironment?.connection.phase) ||
          relativePathNeedsActiveProject ||
          (isCloneDestinationStep && (!canCloneProject || isRemoteProjectPending))
        }
        onSubmit={() => {
          if (relativePathNeedsActiveProject) {
            return;
          }
          if (isCloneDestinationStep) {
            void submitAddProjectCloneFlow(resolvedAddProjectPath);
          } else {
            void handleAddProject(resolvedAddProjectPath);
          }
        }}
      />
    ) : null;

  const footerActionLabel =
    newProjectFlow !== null
      ? highlightedItemValue === null
        ? "Create"
        : highlightedItemValue === newProjectPublishToggleValue
          ? "Toggle"
          : "Select"
      : addProjectCloneFlow?.step === "repository"
        ? (remoteProjectButtonLabel ?? "Continue")
        : !canSubmitBrowsePath || hasHighlightedBrowseItem
          ? "Select"
          : undefined;

  const footerTrailing = canOpenProjectFromFileManager ? (
    <CommandFooterAction
      disabled={isPickingProjectFolder}
      onClick={() => {
        void handleOpenProjectFromFileManager();
      }}
    >
      {`Open in ${fileManagerName}`}
    </CommandFooterAction>
  ) : isThreadSearchPending && !isLinkedThreadSearch && !isBrowsing ? (
    // In the footer, so the list keeps its height while message results may
    // still arrive below it.
    <span className="text-muted-foreground text-xs">Searching messages…</span>
  ) : null;

  return (
    <CommandPaletteContent
      key={`${viewStack.length}-${browseGeneration}-${isBrowsing}-${newProjectFlow ? "new-project" : (addProjectCloneFlow?.step ?? "none")}`}
      aria-label="Command palette"
      autoHighlight={autoHighlightsFirstRow ? "always" : false}
      footerActionLabel={footerActionLabel}
      footerTrailing={footerTrailing}
      inputAccessory={inputAccessory}
      inputProps={{
        className: hasHighlightedNewProjectItem
          ? "*:data-[slot=autocomplete-input]:pe-38!"
          : addProjectCloneFlow?.step === "repository" || newProjectFlow !== null
            ? "*:data-[slot=autocomplete-input]:pe-32!"
            : isBrowsing
              ? browseInputEndPaddingClass({
                  willCreateProjectPath,
                  hasHighlightedBrowseItem,
                })
              : undefined,
        placeholder: inputPlaceholder,
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : isBrowsing
            ? { startAddon: <FolderPlusIcon /> }
            : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      items={resultRows.itemValues}
      virtualized
      onItemHighlighted={(value, eventDetails) => {
        if (eventDetails.reason === "none" && highlightClearedRef.current) return;
        highlightClearedRef.current = false;
        setHighlightedItemValue(typeof value === "string" ? value : null);
        const rowIndex = resultRows.rowIndexByItemIndex[eventDetails.index];
        if (eventDetails.reason === "keyboard" && rowIndex !== undefined) {
          scrollCommandPaletteRowIntoView(resultListRef.current, rowIndex);
        }
      }}
      onValueChange={handleQueryChange}
      showBackHint={isSubmenu}
      value={query}
    >
      {newProjectPathPreview !== null ? (
        <NewProjectSummary
          name={newProjectName}
          pathPreview={newProjectPathPreview}
          projectsRoot={newProjectsRoot}
          environmentLabel={newProjectEnvironmentLabel}
        />
      ) : null}
      {addProjectCloneFlow?.step === "confirm" ? (
        <RemoteRepositorySummary
          source={addProjectCloneFlow.source}
          title={
            addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.repositoryInput
          }
          description={addProjectCloneFlow.repository?.url ?? addProjectCloneFlow.remoteUrl}
        />
      ) : null}
      {browseAccessError ? (
        <div role="alert" className="px-4 py-3 text-sm text-muted-foreground">
          {browseAccessError}
        </div>
      ) : isBrowsePending && browseResult === null ? (
        <div role="status" className="px-4 py-3 text-sm text-muted-foreground">
          Loading folders...
        </div>
      ) : null}
      <CommandPaletteVirtualizedResults
        rows={resultRows.rows}
        listRef={resultListRef}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={isActionsOnly}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(addProjectCloneFlow?.step === "repository"
          ? {
              emptyStateMessage:
                addProjectCloneFlow.source === "url"
                  ? "Enter a Git clone URL and press Enter to continue."
                  : "Enter a repository path and press Enter to look it up.",
            }
          : addProjectCloneFlow?.step === "confirm"
            ? { emptyStateMessage: "Choose a destination path and press Enter to clone." }
            : relativePathNeedsActiveProject
              ? { emptyStateMessage: "Relative paths require an active project." }
              : willCreateProjectPath
                ? {
                    emptyStateMessage: "Press Enter to create this folder and add it as a project.",
                  }
                : isThreadSearchPending
                  ? { emptyStateMessage: "Searching thread messages…" }
                  : {})}
      />
    </CommandPaletteContent>
  );
}
