"use client";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type DesktopWslState,
  type EnvironmentId,
  type FilesystemBrowseResult,
  type ProjectId,
  type SourceControlDiscoveryResult,
  type SourceControlProviderKind,
  type SourceControlRepositoryInfo,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CornerLeftUpIcon,
  FolderIcon,
  FolderPlusIcon,
  LinkIcon,
  MessageSquareIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useAtomValue } from "@effect/atom-react";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useClientSettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { filesystemEnvironment } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../lib/projectPaths";
import { onOpenCommandPalette } from "../commandPaletteBus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { getLatestThreadForProject, sortThreads } from "../lib/threadSort";
import { cn, isMacPlatform, isWindowsPlatform, newProjectId } from "../lib/utils";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../wslPaths";
import {
  ADDON_ICON_CLASS,
  buildBrowseGroups,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  enumerateCommandPaletteItems,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterBrowseEntries,
  filterCommandPaletteGroups,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
} from "./CommandPalette.logic";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "./Icons";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../keybindings";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandPanel,
} from "./ui/command";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "../sidebarProjectGrouping";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

function getLocalFileManagerName(platform: string): string {
  if (isMacPlatform(platform)) {
    return "Finder";
  }
  if (isWindowsPlatform(platform)) {
    return "Explorer";
  }
  return "Files";
}

function getEnvironmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") {
    return "Win32";
  }
  if (os === "darwin") {
    return "MacIntel";
  }
  if (os === "linux") {
    return "Linux";
  }
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

interface AddProjectEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
}

type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;
type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

const REMOTE_PROJECT_SOURCES: ReadonlyArray<AddProjectRemoteSource> = [
  "url",
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];
const REMOTE_PROJECT_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];

function remoteProjectSourceLabel(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    case "azure-devops":
      return "Azure DevOps";
    case "url":
      return "Git URL";
  }
}

function remoteProjectSourcePathHint(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "owner/repo";
    case "gitlab":
      return "group/project";
    case "bitbucket":
      return "workspace/repository";
    case "azure-devops":
      return "project/repository";
    case "url":
      return "URL";
  }
}

function remoteProjectSourceProvider(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

function remoteProjectSourceIcon(source: AddProjectRemoteSource, className: string): ReactNode {
  switch (source) {
    case "github":
      return <GitHubIcon className={className} />;
    case "gitlab":
      return <GitLabIcon className={className} />;
    case "bitbucket":
      return <BitbucketIcon className={className} />;
    case "azure-devops":
      return <AzureDevOpsIcon className={className} />;
    case "url":
      return <LinkIcon className={className} />;
  }
}

function remoteProjectInputPlaceholder(flow: AddProjectCloneFlow | null): string | null {
  if (!flow) return null;
  if (flow.step === "confirm") return null;
  if (flow.source === "url") {
    return "Enter Git clone URL";
  }
  return `Enter ${remoteProjectSourceLabel(flow.source)} repository (${remoteProjectSourcePathHint(flow.source)})`;
}

function sourceProviderKind(source: AddProjectRemoteSource): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): ReadonlyArray<AddProjectRemoteProviderKind> {
  return REMOTE_PROJECT_PROVIDER_SOURCES.toSorted((left, right) => {
    const leftReady = readinessBySource[left].ready;
    const rightReady = readinessBySource[right].ready;
    if (leftReady !== rightReady) {
      return leftReady ? -1 : 1;
    }
    return remoteProjectSourceLabel(left).localeCompare(remoteProjectSourceLabel(right));
  });
}

type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  { readonly ready: boolean; readonly hint: string | null }
>;

function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const unavailable = {
    ready: false,
    hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
  } as const;
  const defaultReadiness: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    bitbucket: unavailable,
    "azure-devops": unavailable,
  };

  if (!discovery) {
    return defaultReadiness;
  }

  const providerByKind = new Map(
    discovery.sourceControlProviders.map((provider) => [provider.kind, provider]),
  );
  const readiness = { ...defaultReadiness };

  for (const source of REMOTE_PROJECT_SOURCES) {
    const kind = sourceProviderKind(source);
    if (!kind) continue;
    const provider = providerByKind.get(kind);
    if (!provider) {
      readiness[source] = unavailable;
      continue;
    }
    if (provider.status !== "available") {
      readiness[source] = { ready: false, hint: provider.installHint };
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      readiness[source] = {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
      };
      continue;
    }
    readiness[source] = { ready: true, hint: null };
  }

  return readiness;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "An error occurred.";
}

interface CommandPaletteOpenIntent {
  readonly kind: "add-project" | "new-thread-in";
}

interface CommandPaletteUiState {
  readonly open: boolean;
  readonly openIntent: CommandPaletteOpenIntent | null;
}

type CommandPaletteUiAction =
  | { readonly _tag: "SetOpen"; readonly open: boolean }
  | { readonly _tag: "Toggle" }
  | { readonly _tag: "OpenAddProject" }
  | { readonly _tag: "OpenNewThreadIn" }
  | { readonly _tag: "ClearOpenIntent" };

function reduceCommandPaletteUiState(
  state: CommandPaletteUiState,
  action: CommandPaletteUiAction,
): CommandPaletteUiState {
  switch (action._tag) {
    case "SetOpen":
      return {
        open: action.open,
        openIntent: action.open ? state.openIntent : null,
      };
    case "Toggle":
      return { open: !state.open, openIntent: null };
    case "OpenAddProject":
      return { open: true, openIntent: { kind: "add-project" } };
    case "OpenNewThreadIn":
      return { open: true, openIntent: { kind: "new-thread-in" } };
    case "ClearOpenIntent":
      return state.openIntent ? { ...state, openIntent: null } : state;
  }
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    openIntent: null,
  });
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);
  const toggleOpen = useCallback(() => dispatch({ _tag: "Toggle" }), []);
  const openAddProject = useCallback(() => dispatch({ _tag: "OpenAddProject" }), []);
  const openNewThreadIn = useCallback(() => dispatch({ _tag: "OpenNewThreadIn" }), []);
  const clearOpenIntent = useCallback(() => dispatch({ _tag: "ClearOpenIntent" }), []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "commandPalette.toggle") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, terminalOpen, toggleOpen]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "new-thread-in") {
          openNewThreadIn();
        } else if (detail.open === "add-project") {
          openAddProject();
        } else {
          setOpen(true);
        }
      }),
    [openAddProject, openNewThreadIn, setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog open={state.open} onOpenChange={setOpen}>
        {children}
        <CommandPaletteDialog
          open={state.open}
          openIntent={state.openIntent}
          setOpen={setOpen}
          clearOpenIntent={clearOpenIntent}
        />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly open: boolean;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly clearOpenIntent: () => void;
}) {
  if (!props.open) {
    return null;
  }

  return (
    <OpenCommandPaletteDialog
      openIntent={props.openIntent}
      setOpen={props.setOpen}
      clearOpenIntent={props.clearOpenIntent}
    />
  );
}

function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly clearOpenIntent: () => void;
}) {
  const navigate = useNavigate();
  const { clearOpenIntent, openIntent, setOpen } = props;
  const composerHandleRef = useComposerHandleContext();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const clientSettings = useClientSettings();
  const createProject = useAtomCommand(projectEnvironment.create, {
    reportFailure: false,
  });
  const lookupRepository = useAtomQueryRunner(sourceControlEnvironment.repository, {
    reportFailure: false,
  });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const desktopLocalBootstraps = useDesktopLocalBootstraps();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const [addProjectEnvironmentId, setAddProjectEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const [addProjectCloneFlow, setAddProjectCloneFlow] = useState<AddProjectCloneFlow | null>(null);
  const [isRemoteProjectLookingUp, setIsRemoteProjectLookingUp] = useState(false);
  const [isRemoteProjectCloning, setIsRemoteProjectCloning] = useState(false);
  const projectGroupingSettings = useMemo(
    () => selectProjectGroupingSettings(clientSettings),
    [clientSettings],
  );

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: clientSettings.sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      clientSettings.sidebarProjectSortOrder,
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
    ],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        unsortedProjectGroups,
        threads,
        clientSettings.sidebarProjectSortOrder,
      ),
    [clientSettings.sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const contextualProjectRef = useMemo(
    () =>
      resolveThreadActionProjectRef({
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef,
        handleNewThread,
      }),
    [activeDraftThread, activeThread, defaultProjectRef, handleNewThread],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: contextualProjectRef,
      }),
    [contextualProjectRef, projectGroups],
  );
  const pickerProjects = useMemo(
    () =>
      projectPickerEntries.map(({ group, targetProject }) => ({
        ...targetProject,
        title: group.displayName,
      })),
    [projectPickerEntries],
  );
  const projectGroupByTargetKey = useMemo(
    () =>
      new Map(
        projectPickerEntries.map(({ group, targetProject }) => [
          `${targetProject.environmentId}:${targetProject.id}`,
          group,
        ]),
      ),
    [projectPickerEntries],
  );

  const addProjectEnvironmentOptions = useMemo(() => {
    const options = environments.map((environment): AddProjectEnvironmentOption => {
      const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
      return {
        environmentId: environment.environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary,
          environmentId: environment.environmentId,
          runtimeLabel: environment.label,
        }),
        isPrimary,
      };
    });

    options.sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });

    return options;
  }, [environments]);
  const defaultAddProjectEnvironmentId = addProjectEnvironmentOptions[0]?.environmentId ?? null;
  const wslAddProjectEnvironmentOption = useMemo(
    () =>
      addProjectEnvironmentOptions.find((option) => {
        const environment = environments.find(
          (candidate) => candidate.environmentId === option.environmentId,
        );
        return environment
          ? desktopLocalBackendId(environment.entry.target)?.startsWith("wsl:") === true
          : false;
      }) ?? null,
    [addProjectEnvironmentOptions, environments],
  );
  const browseEnvironmentId = addProjectEnvironmentId ?? defaultAddProjectEnvironmentId;
  const browseEnvironment =
    environments.find((environment) => environment.environmentId === browseEnvironmentId) ?? null;
  // A desktop-local secondary backend (today: the WSL backend). The picker is
  // available against these too — the desktop dispatches pickFolder into the
  // backend's filesystem when routed by its instance id.
  const browseEnvironmentIsDesktopLocal =
    browseEnvironment !== null && isDesktopLocalConnectionTarget(browseEnvironment.entry.target);
  // Map the browsed desktop-local env to its desktop pool instance id (e.g.
  // "wsl:ubuntu"). The catalog environmentId is descriptor-derived and won't
  // route on the desktop side; pickFolder only recognizes the pool id, which
  // the bootstrap list exposes. Match on backend URL, exactly as Sidebar's
  // LocalSecondaryStatus does (environment.displayUrl === bootstrap.httpBaseUrl).
  const browseDesktopInstanceId = useMemo(() => {
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
  }, [browseEnvironment, browseEnvironmentIsDesktopLocal, desktopLocalBootstraps]);
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
  const isBrowsing =
    !isRemoteProjectRepositoryStep && isFilesystemBrowseQuery(query, browseEnvironmentPlatform);
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });
  const getAddProjectInitialQueryForEnvironment = useCallback(
    (environmentId: EnvironmentId | null): string => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      const environmentSettings = environment?.serverConfig?.settings ?? null;
      const baseDirectory = environmentSettings?.addProjectBaseDirectory?.trim() ?? "";
      if (baseDirectory.length === 0) {
        return "~/";
      }
      return ensureBrowseDirectoryPath(baseDirectory);
    },
    [environments],
  );

  const projectCwdById = useMemo(
    () =>
      new Map<ProjectId, string>(projects.map((project) => [project.id, project.workspaceRoot])),
    [projects],
  );
  const projectTitleById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );

  const activeThreadId = activeThread?.id;
  const currentProjectEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const currentProjectCwd = currentProjectId
    ? (projectCwdById.get(currentProjectId) ?? null)
    : null;
  const currentProjectCwdForBrowse =
    browseEnvironmentId && currentProjectEnvironmentId === browseEnvironmentId
      ? currentProjectCwd
      : null;
  const relativePathNeedsActiveProject =
    isExplicitRelativeProjectPath(query.trim()) && currentProjectCwdForBrowse === null;
  const browseDirectoryPath = isBrowsing ? getBrowseDirectoryPath(query) : "";
  const browseFilterQuery =
    isBrowsing && !hasTrailingPathSeparator(query) ? getBrowseLeafPathSegment(query) : "";
  const browseQuery = useEnvironmentQuery(
    isBrowsing &&
      browseDirectoryPath.length > 0 &&
      browseEnvironmentId !== null &&
      !relativePathNeedsActiveProject
      ? filesystemEnvironment.browse({
          environmentId: browseEnvironmentId,
          input: {
            partialPath: browseDirectoryPath,
            ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
          },
        })
      : null,
  );
  const browseResult = browseQuery.data;
  const isBrowsePending = browseQuery.isPending;
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const { filteredEntries: filteredBrowseEntries, exactEntry: exactBrowseEntry } = useMemo(
    () => filterBrowseEntries({ browseEntries, browseFilterQuery, highlightedItemValue }),
    [browseEntries, browseFilterQuery, highlightedItemValue],
  );

  const openProjectFromSearch = useMemo(
    () => async (project: (typeof projects)[number]) => {
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
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
        return;
      }

      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [
      clientSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
      projectGroupByTargetKey,
      threads,
    ],
  );

  const projectSearchItems = useMemo(
    () =>
      buildProjectActionItems({
        projects: pickerProjects,
        valuePrefix: "project",
        searchTerms: (project) => {
          const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
          return (
            group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []
          );
        },
        icon: (project) => (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.workspaceRoot}
            className={ITEM_ICON_CLASS}
          />
        ),
        runProject: openProjectFromSearch,
      }),
    [openProjectFromSearch, pickerProjects, projectGroupByTargetKey],
  );

  const projectThreadItems = useMemo(
    () =>
      enumerateCommandPaletteItems(
        buildProjectActionItems({
          projects: pickerProjects,
          valuePrefix: "new-thread-in",
          searchTerms: (project) => {
            const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
            return (
              group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []
            );
          },
          icon: (project) => (
            <ProjectFavicon
              environmentId={project.environmentId}
              cwd={project.workspaceRoot}
              className={ITEM_ICON_CLASS}
            />
          ),
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
        }),
      ),
    [contextualProjectRef, handleNewThread, pickerProjects, projectGroupByTargetKey],
  );

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        sortOrder: clientSettings.sidebarThreadSortOrder,
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
        renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
        runThread: async (thread) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      }),
    [activeThreadId, clientSettings.sidebarThreadSortOrder, navigate, projectTitleById, threads],
  );
  const recentThreadItems = allThreadItems.slice(0, RECENT_THREAD_LIMIT);

  function pushPaletteView(view: CommandPaletteView): void {
    setViewStack((previousViews) => [
      ...previousViews,
      {
        addonIcon: view.addonIcon,
        groups: view.groups,
        ...(view.initialQuery ? { initialQuery: view.initialQuery } : {}),
      },
    ]);
    setHighlightedItemValue(null);
    setQuery(view.initialQuery ?? "");
  }

  function pushView(item: CommandPaletteSubmenuItem): void {
    pushPaletteView({
      addonIcon: item.addonIcon,
      groups: item.groups,
      ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
    });
  }

  function popView(): void {
    setAddProjectCloneFlow(null);
    if (viewStack.length <= 1) {
      setAddProjectEnvironmentId(null);
    }
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    setHighlightedItemValue(null);
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const startAddProjectBrowse = useCallback(
    (environmentId: EnvironmentId): void => {
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow(null);
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [],
        initialQuery: getAddProjectInitialQueryForEnvironment(environmentId),
      });
    },
    [getAddProjectInitialQueryForEnvironment],
  );

  const startAddProjectClone = useCallback(
    (environmentId: EnvironmentId, source: AddProjectRemoteSource): void => {
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow({ step: "repository", environmentId, source });
      pushPaletteView({
        addonIcon: remoteProjectSourceIcon(source, ADDON_ICON_CLASS),
        groups: [],
        initialQuery: "",
      });
    },
    [],
  );

  const openSourceControlSettings = useCallback(() => {
    setOpen(false);
    void navigate({ to: "/settings/source-control" });
  }, [navigate, setOpen]);

  const buildAddProjectSourceGroups = useCallback(
    (
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
            startAddProjectBrowse(environmentId);
          },
        },
      ];

      const orderedSources: ReadonlyArray<AddProjectRemoteSource> = [
        "url",
        ...sortAddProjectProviderSources(readinessBySource),
      ];

      for (const source of orderedSources) {
        const label = remoteProjectSourceLabel(source);
        const title = source === "url" ? "Git URL" : `${label} repository`;
        const description =
          source === "url"
            ? "Clone from a remote URL"
            : `Clone ${label} ${remoteProjectSourcePathHint(source)}`;
        const readiness = readinessBySource[source];
        const disabledHint = readiness.hint;

        const titleTrailingContent = readiness.ready ? undefined : (
          <span className="ml-auto">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-5 rounded-[.25rem] px-1.5 text-[10px] text-warning-foreground"
                    onClick={() => {
                      openSourceControlSettings();
                    }}
                  >
                    Setup Required
                  </Button>
                }
              />
              <TooltipPopup align="end" side="left">
                {disabledHint ?? "Open Settings -> Source Control to configure this provider."}
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
    },
    [openSourceControlSettings, startAddProjectBrowse, startAddProjectClone],
  );

  const startAddProjectSourceSelection = useCallback(
    (environmentId: EnvironmentId): void => {
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow(null);
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: buildAddProjectSourceGroups(
          environmentId,
          buildAddProjectRemoteSourceReadiness(
            browseEnvironmentId === environmentId ? sourceControlDiscovery.data : null,
          ),
        ),
      });
    },
    [browseEnvironmentId, buildAddProjectSourceGroups, sourceControlDiscovery.data],
  );

  const addProjectEnvironmentItems: CommandPaletteActionItem[] = addProjectEnvironmentOptions.map(
    (option) => ({
      kind: "action",
      value: `action:add-project:environment:${option.environmentId}`,
      searchTerms: [option.label, option.environmentId, option.isPrimary ? "this device" : ""],
      title: option.label,
      description: option.isPrimary ? "This device" : option.environmentId,
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        startAddProjectSourceSelection(option.environmentId);
      },
    }),
  );

  const addProjectEnvironmentGroups = useMemo<CommandPaletteView["groups"]>(
    () => [
      {
        value: "environments",
        label: "Environments",
        items: addProjectEnvironmentItems,
      },
    ],
    [addProjectEnvironmentItems],
  );

  const openAddProjectFlow = useCallback(() => {
    if (addProjectEnvironmentOptions.length > 1) {
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: addProjectEnvironmentGroups,
      });
      return;
    }

    const environmentId = defaultAddProjectEnvironmentId;
    if (!environmentId) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to browse projects",
          description: "No environment is available.",
        }),
      );
      return;
    }

    void startAddProjectSourceSelection(environmentId);
  }, [
    addProjectEnvironmentGroups,
    addProjectEnvironmentOptions.length,
    defaultAddProjectEnvironmentId,
    startAddProjectSourceSelection,
  ]);

  useLayoutEffect(() => {
    if (openIntent?.kind !== "add-project") {
      return;
    }
    clearOpenIntent();
    openAddProjectFlow();
  }, [clearOpenIntent, openAddProjectFlow, openIntent]);

  useLayoutEffect(() => {
    if (openIntent?.kind !== "new-thread-in" || projectThreadItems.length === 0) {
      return;
    }
    clearOpenIntent();
    setAddProjectCloneFlow(null);
    setViewStack([]);
    setQuery("");
    const currentPrefix =
      currentProjectEnvironmentId && currentProjectId
        ? `new-thread-in:${currentProjectEnvironmentId}:${currentProjectId}`
        : null;
    const prioritized = currentPrefix
      ? [
          ...projectThreadItems.filter((item) => item.value === currentPrefix),
          ...projectThreadItems.filter((item) => item.value !== currentPrefix),
        ]
      : projectThreadItems;
    pushPaletteView({
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "projects",
          label: "Projects",
          items: enumerateCommandPaletteItems(prioritized),
        },
      ],
    });
  }, [
    clearOpenIntent,
    currentProjectEnvironmentId,
    currentProjectId,
    openIntent,
    projectThreadItems,
  ]);

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (projects.length > 0) {
    const activeProjectTitle =
      projectPickerEntries.find((entry) => entry.isPreferred)?.group.displayName ??
      (currentProjectId ? (projectTitleById.get(currentProjectId) ?? null) : null);

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
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.new",
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
      groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
    });
  }

  actionItems.push({
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
      "github",
      "gitlab",
      "bitbucket",
      "azure",
      "devops",
      "url",
      "environment",
    ],
    title: "Add project",
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      openAddProjectFlow();
    },
  });

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
        startAddProjectBrowse(wslAddProjectEnvironmentOption.environmentId);
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

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
  const sourceSelectionViewValue =
    addProjectEnvironmentId === null ? null : `sources:${addProjectEnvironmentId}`;
  const activeGroups =
    addProjectEnvironmentId !== null &&
    currentView !== null &&
    currentView.groups[0]?.value === sourceSelectionViewValue
      ? buildAddProjectSourceGroups(
          addProjectEnvironmentId,
          buildAddProjectRemoteSourceReadiness(sourceControlDiscovery.data),
        )
      : (currentView?.groups ?? rootGroups);

  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    projectSearchItems: projectSearchItems,
    threadSearchItems: allThreadItems,
  });

  const handleAddProjectForEnvironment = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly rawCwd: string;
      readonly platform: string;
      readonly currentProjectCwd: string | null;
    }) => {
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
        const latestThread = getLatestThreadForProject(
          threads.filter((thread) => thread.environmentId === existing.environmentId),
          existing.id,
          clientSettings.sidebarThreadSortOrder,
        );
        if (latestThread) {
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

      const projectId = newProjectId();
      const targetEnvironmentProviders =
        environments.find((environment) => environment.environmentId === input.environmentId)
          ?.serverConfig?.providers ??
        (input.environmentId === primaryEnvironmentId ? providers : []);
      const createResult = await createProject({
        environmentId: input.environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(cwd),
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: resolveDefaultProviderModelSelection(
            targetEnvironmentProviders,
            null,
          ),
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
    },
    [
      handleNewThread,
      createProject,
      environments,
      navigate,
      primaryEnvironmentId,
      projects,
      providers,
      setOpen,
      clientSettings.sidebarThreadSortOrder,
      threads,
    ],
  );

  const handleAddProject = useCallback(
    async (rawCwd: string) => {
      if (!browseEnvironmentId) return;
      await handleAddProjectForEnvironment({
        environmentId: browseEnvironmentId,
        rawCwd,
        platform: browseEnvironmentPlatform,
        currentProjectCwd: currentProjectCwdForBrowse,
      });
    },
    [
      browseEnvironmentId,
      browseEnvironmentPlatform,
      currentProjectCwdForBrowse,
      handleAddProjectForEnvironment,
    ],
  );

  function getDefaultCloneParentPath(environmentId: EnvironmentId): string {
    return getAddProjectInitialQueryForEnvironment(environmentId);
  }

  async function submitAddProjectCloneFlow(destinationPathInput?: string): Promise<void> {
    if (!addProjectCloneFlow) {
      return;
    }

    if (addProjectCloneFlow.step === "repository") {
      const rawRepository = query.trim();
      if (rawRepository.length === 0 || isRemoteProjectLookingUp) {
        return;
      }

      const provider = remoteProjectSourceProvider(addProjectCloneFlow.source);
      if (!provider) {
        const destinationPath = getDefaultCloneParentPath(addProjectCloneFlow.environmentId);
        setAddProjectCloneFlow({
          step: "confirm",
          environmentId: addProjectCloneFlow.environmentId,
          source: addProjectCloneFlow.source,
          repositoryInput: rawRepository,
          repository: null,
          remoteUrl: rawRepository,
        });
        setHighlightedItemValue(null);
        setQuery(destinationPath);
        setBrowseGeneration((generation) => generation + 1);
        return;
      }

      setIsRemoteProjectLookingUp(true);
      const lookupResult = await lookupRepository({
        environmentId: addProjectCloneFlow.environmentId,
        input: {
          provider,
          repository: rawRepository,
        },
      });
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
      const destinationPath = getDefaultCloneParentPath(addProjectCloneFlow.environmentId);
      setAddProjectCloneFlow({
        step: "confirm",
        environmentId: addProjectCloneFlow.environmentId,
        source: addProjectCloneFlow.source,
        repositoryInput: rawRepository,
        repository,
        remoteUrl: repository.sshUrl,
      });
      setHighlightedItemValue(null);
      setQuery(destinationPath);
      setBrowseGeneration((generation) => generation + 1);
      return;
    }

    const rawDestination = (destinationPathInput ?? query).trim();
    if (rawDestination.length === 0 || isRemoteProjectCloning) {
      return;
    }

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

    setIsRemoteProjectCloning(true);
    const cloneResult = await cloneRepository({
      environmentId: addProjectCloneFlow.environmentId,
      input: {
        remoteUrl: addProjectCloneFlow.remoteUrl,
        destinationPath,
      },
    });
    setIsRemoteProjectCloning(false);
    if (cloneResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(cloneResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone failed",
            description: errorMessage(squashAtomCommandFailure(cloneResult)),
          }),
        );
      }
      return;
    }
    await handleAddProject(cloneResult.value.cwd);
  }

  function browseTo(name: string): void {
    const nextQuery = appendBrowsePathSegment(query, name);
    setHighlightedItemValue(null);
    setQuery(nextQuery);
    setBrowseGeneration((generation) => generation + 1);
  }

  function browseUp(): void {
    const parentPath = getBrowseParentPath(query);
    if (parentPath === null) {
      return;
    }

    setHighlightedItemValue(null);
    setQuery(parentPath);
    setBrowseGeneration((generation) => generation + 1);
  }

  // Resolve the add-project path from browse data when available. When the
  // query has a trailing separator (e.g. "~/projects/foo/"), parentPath is the
  // directory itself. Otherwise the user typed a partial leaf name, so we need
  // the exact browse entry's fullPath or fall back to the raw query.
  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? query.trim());

  const canBrowseUp =
    isBrowsing && !relativePathNeedsActiveProject && canNavigateUp(browseDirectoryPath);

  const browseGroups = buildBrowseGroups({
    browseEntries: filteredBrowseEntries,
    browseQuery: query,
    canBrowseUp,
    upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
    directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
    browseUp,
    browseTo,
  });
  const cloneDestinationBrowseGroups = useMemo(
    () =>
      browseGroups.map((group) =>
        group.value === "directories" ? { ...group, label: "Select where to clone" } : group,
      ),
    [browseGroups],
  );

  const remoteProjectContext = useMemo(() => {
    if (addProjectCloneFlow?.step !== "confirm") {
      return null;
    }

    return {
      title: addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.repositoryInput,
      description: addProjectCloneFlow.repository?.url ?? addProjectCloneFlow.remoteUrl,
      icon: remoteProjectSourceIcon(addProjectCloneFlow.source, ITEM_ICON_CLASS),
    };
  }, [addProjectCloneFlow]);

  let displayedGroups: CommandPaletteView["groups"] = filteredGroups;
  if (addProjectCloneFlow?.step === "repository") {
    displayedGroups = [];
  } else if (addProjectCloneFlow?.step === "confirm") {
    displayedGroups = relativePathNeedsActiveProject ? [] : cloneDestinationBrowseGroups;
  } else if (isBrowsing) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  }

  const inputPlaceholder =
    remoteProjectInputPlaceholder(addProjectCloneFlow) ??
    getCommandPaletteInputPlaceholder(paletteMode);
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canSubmitBrowsePath = isBrowsing && !relativePathNeedsActiveProject;
  const willCreateProjectPath =
    canSubmitBrowsePath &&
    !isBrowsePending &&
    query.trim().length > 0 &&
    !hasHighlightedBrowseItem &&
    (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
  const useMetaForMod = isMacPlatform(navigator.platform);
  const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
  const isCloneDestinationStep = addProjectCloneFlow?.step === "confirm";
  const submitActionLabel = isCloneDestinationStep
    ? willCreateProjectPath
      ? "Create & Clone"
      : "Clone"
    : willCreateProjectPath
      ? "Create & Add"
      : "Add";
  const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
  const remoteProjectButtonLabel = addProjectCloneFlow
    ? addProjectCloneFlow.source === "url"
      ? "Continue"
      : "Lookup"
    : null;
  const isRemoteProjectPending = isRemoteProjectLookingUp || isRemoteProjectCloning;
  const canSubmitRemoteProjectFlow =
    addProjectCloneFlow?.step === "repository" &&
    query.trim().length > 0 &&
    !isRemoteProjectPending;
  const fileManagerName = getLocalFileManagerName(navigator.platform);
  const canOpenProjectFromFileManager =
    isBrowsing &&
    browseEnvironmentId !== null &&
    // For a desktop-local (WSL) env, only offer the picker once we have resolved
    // its desktop pool instance id. Without it pickFolder can't be routed to the
    // WSL filesystem and would open the primary (Windows) picker, then add the
    // chosen Windows path against the WSL env -- a wrong-path footgun. Stay
    // hidden until the bootstrap mapping is available rather than mis-routing.
    (browseEnvironmentId === primaryEnvironmentId ||
      (browseEnvironmentIsDesktopLocal && browseDesktopInstanceId !== null)) &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;
  const fileManagerInitialPath = useMemo(() => {
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
  }, [
    browseDirectoryPath,
    browseResult?.parentPath,
    canOpenProjectFromFileManager,
    currentProjectCwdForBrowse,
    query,
  ]);

  function isPrimaryModifierPressed(event: KeyboardEvent<HTMLInputElement>): boolean {
    return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false },
    });
    if (threadJumpIndexFromCommand(command ?? "") !== null) {
      const matchingItem = displayedGroups
        .flatMap((group) => group.items)
        .find((item) => item.shortcutCommand === command);
      if (matchingItem) {
        event.preventDefault();
        event.stopPropagation();
        executeItem(matchingItem);
        return;
      }
    }

    if (addProjectCloneFlow?.step === "repository" && event.key === "Enter") {
      event.preventDefault();
      void submitAddProjectCloneFlow();
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
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushView(item);
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

  const handleOpenProjectFromFileManager = useCallback(async () => {
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
      // Route the picker to the browsed env's backend filesystem. The desktop
      // only resolves a "wsl:*" pool instance id, so for a desktop-local env we
      // pass the bootstrap-mapped instance id (not the catalog environmentId).
      // A WSL-only primary has no secondary bootstrap, so resolve its instance
      // id from desktop settings. Windows and combo-mode primaries still omit
      // the target to preserve the native primary picker. The desktop converts
      // a WSL UNC selection back to a Linux path before returning.
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
      // Ignore picker failures and leave the palette open.
      setIsPickingProjectFolder(false);
      return;
    }
    setIsPickingProjectFolder(false);
    if (!pickedPath) {
      return;
    }
    if (parseWslUncPath(pickedPath)) {
      desktopWslState ??= (await window.desktopBridge?.getWslState().catch(() => null)) ?? null;
      let primaryRunningDistro: string | null = null;
      try {
        primaryRunningDistro =
          window.desktopBridge
            ?.getLocalEnvironmentBootstraps()
            .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ??
          null;
      } catch {
        // Keep UNC routing strict when the live primary identity cannot be read.
      }
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
  }, [
    browseDesktopInstanceId,
    browseEnvironmentId,
    browseEnvironmentPlatform,
    canOpenProjectFromFileManager,
    desktopLocalBootstraps,
    environments,
    fileManagerInitialPath,
    handleAddProject,
    handleAddProjectForEnvironment,
    isPickingProjectFolder,
    primaryEnvironmentId,
  ]);

  return (
    <CommandDialogPopup
      aria-label="Command palette"
      className="overflow-hidden p-0"
      data-command-palette="true"
      data-testid="command-palette"
      finalFocus={() => {
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        setOpen(false);
      }}
    >
      <Command
        key={`${viewStack.length}-${browseGeneration}-${isBrowsing}-${addProjectCloneFlow?.step ?? "none"}`}
        aria-label="Command palette"
        autoHighlight={isBrowsing || isRemoteProjectCloneFlow ? false : "always"}
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={handleQueryChange}
        value={query}
      >
        <div className="relative">
          <CommandInput
            className={
              addProjectCloneFlow?.step === "repository"
                ? "pe-32"
                : isBrowsing
                  ? willCreateProjectPath
                    ? "pe-36"
                    : "pe-16"
                  : undefined
            }
            placeholder={inputPlaceholder}
            wrapperClassName={
              isSubmenu ? "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto" : undefined
            }
            {...(isSubmenu
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
              : isBrowsing && !isSubmenu
                ? {
                    startAddon: <FolderPlusIcon />,
                  }
                : {})}
            onKeyDown={handleKeyDown}
          />
          {addProjectCloneFlow?.step === "repository" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="xs"
                    tabIndex={-1}
                    className="absolute inset-e-2.5 top-1/2 gap-1.5 pe-1 ps-2 -translate-y-1/2"
                    aria-label={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
                    disabled={!canSubmitRemoteProjectFlow}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
                      void submitAddProjectCloneFlow();
                    }}
                  />
                }
              >
                <span>{isRemoteProjectPending ? "Working" : remoteProjectButtonLabel}</span>
                <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
                  <Kbd>Enter</Kbd>
                </KbdGroup>
              </TooltipTrigger>
              <TooltipPopup side="top">
                {remoteProjectButtonLabel ?? "Continue"} (Enter)
              </TooltipPopup>
            </Tooltip>
          ) : isBrowsing ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="xs"
                    tabIndex={-1}
                    className={cn(
                      "absolute inset-e-2.5 top-1/2 pe-1 ps-2 -translate-y-1/2",
                      hasHighlightedBrowseItem ? "gap-1" : "gap-1.5",
                    )}
                    aria-label={`${submitActionLabel} (${addShortcutLabel})`}
                    disabled={
                      relativePathNeedsActiveProject ||
                      (isCloneDestinationStep && isRemoteProjectPending)
                    }
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
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
                }
              >
                <span>
                  {isCloneDestinationStep && isRemoteProjectPending ? "Cloning" : submitActionLabel}
                </span>
                <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
                  <Kbd>{hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter"}</Kbd>
                </KbdGroup>
              </TooltipTrigger>
              <TooltipPopup side="top">
                {submitActionLabel} ({addShortcutLabel})
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <CommandPanel className="max-h-[min(28rem,70vh)]">
          {remoteProjectContext ? (
            <div className="p-2 pb-0">
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                Repository
              </div>
              <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
                {remoteProjectContext.icon}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-foreground text-sm">
                    {remoteProjectContext.title}
                  </span>
                  <span className="truncate text-muted-foreground/85 text-xs">
                    {remoteProjectContext.description}
                  </span>
                </span>
              </div>
            </div>
          ) : null}
          <CommandPaletteResults
            groups={displayedGroups}
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
                        emptyStateMessage:
                          "Press Enter to create this folder and add it as a project.",
                      }
                    : {})}
          />
        </CommandPanel>
        <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
          <div className="flex items-center gap-3">
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span>Navigate</span>
            </KbdGroup>
            {addProjectCloneFlow?.step === "repository" ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Enter</Kbd>
                <span>{remoteProjectButtonLabel ?? "Continue"}</span>
              </KbdGroup>
            ) : !canSubmitBrowsePath || hasHighlightedBrowseItem ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Enter</Kbd>
                <span>Select</span>
              </KbdGroup>
            ) : null}
            {isSubmenu ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Backspace</Kbd>
                <span>Back</span>
              </KbdGroup>
            ) : null}
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span>Close</span>
            </KbdGroup>
          </div>
          {canOpenProjectFromFileManager ? (
            <Button
              variant="ghost"
              size="xs"
              className="h-auto px-2 text-muted-foreground text-xs hover:bg-transparent hover:text-foreground"
              disabled={isPickingProjectFolder}
              onClick={() => {
                void handleOpenProjectFromFileManager();
              }}
            >
              {`Open in ${fileManagerName}`}
            </Button>
          ) : null}
        </CommandFooter>
      </Command>
    </CommandDialogPopup>
  );
}
