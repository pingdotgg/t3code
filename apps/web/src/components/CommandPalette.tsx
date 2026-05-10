"use client";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import {
  DEFAULT_MODEL,
  type EnvironmentId,
  type FilesystemBrowseResult,
  type ProjectId,
  ProviderInstanceId,
  type SourceControlDiscoveryResult,
  type SourceControlProviderKind,
  type SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { readEnvironmentApi } from "../environmentApi";
import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import {
  getSourceControlDiscoverySnapshot,
  refreshSourceControlDiscovery,
} from "../lib/sourceControlDiscoveryState";
import {
  startNewThreadInProjectFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
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
import { isTerminalFocused } from "../lib/terminalFocus";
import { getLatestThreadForProject } from "../lib/threadSort";
import { cn, isMacPlatform, isWindowsPlatform, newCommandId, newProjectId } from "../lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import {
  ADDON_ICON_CLASS,
  buildBrowseGroups,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
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
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "./Icons";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { useServerKeybindings } from "../rpc/serverState";
import { resolveShortcutCommand } from "../keybindings";
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

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];
const BROWSE_STALE_TIME_MS = 30_000;

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

export function CommandPalette({ children }: { children: ReactNode }) {
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const toggleOpen = useCommandPaletteStore((store) => store.toggleOpen);
  const keybindings = useServerKeybindings();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
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

  return (
    <ComposerHandleContext.Provider value={composerHandleRef}>
      <CommandDialog open={open} onOpenChange={setOpen}>
        {children}
        <CommandPaletteDialog />
      </CommandDialog>
    </ComposerHandleContext.Provider>
  );
}

function CommandPaletteDialog() {
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);

  useEffect(() => {
    return () => {
      setOpen(false);
    };
  }, [setOpen]);

  if (!open) {
    return null;
  }

  return <OpenCommandPaletteDialog />;
}

function OpenCommandPaletteDialog() {
  const navigate = useNavigate();
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const openIntent = useCommandPaletteStore((store) => store.openIntent);
  const clearOpenIntent = useCommandPaletteStore((store) => store.clearOpenIntent);
  const composerHandleRef = useComposerHandleContext();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const queryClient = useQueryClient();
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const settings = useSettings();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const keybindings = useServerKeybindings();
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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironmentLabel = readPrimaryEnvironmentDescriptor()?.label ?? null;
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);

  const addProjectEnvironmentOptions = useMemo(() => {
    const options: AddProjectEnvironmentOption[] = [];
    const seenEnvironmentIds = new Set<EnvironmentId>();

    if (primaryEnvironmentId) {
      seenEnvironmentIds.add(primaryEnvironmentId);
      options.push({
        environmentId: primaryEnvironmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: true,
          environmentId: primaryEnvironmentId,
          runtimeLabel: primaryEnvironmentLabel,
        }),
        isPrimary: true,
      });
    }

    for (const record of Object.values(savedEnvironmentRegistry)) {
      if (seenEnvironmentIds.has(record.environmentId)) {
        continue;
      }

      const runtimeState = savedEnvironmentRuntimeById[record.environmentId];
      options.push({
        environmentId: record.environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: false,
          environmentId: record.environmentId,
          runtimeLabel: runtimeState?.descriptor?.label ?? null,
          savedLabel: record.label,
        }),
        isPrimary: false,
      });
    }

    options.sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });

    return options;
  }, [
    primaryEnvironmentId,
    primaryEnvironmentLabel,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);
  const defaultAddProjectEnvironmentId = addProjectEnvironmentOptions[0]?.environmentId ?? null;
  const browseEnvironmentId = addProjectEnvironmentId ?? defaultAddProjectEnvironmentId;
  const browseEnvironmentPlatform = useMemo(() => {
    const os =
      browseEnvironmentId && primaryEnvironmentId && browseEnvironmentId === primaryEnvironmentId
        ? (readPrimaryEnvironmentDescriptor()?.platform.os ?? null)
        : browseEnvironmentId
          ? (savedEnvironmentRuntimeById[browseEnvironmentId]?.descriptor?.platform.os ??
            savedEnvironmentRuntimeById[browseEnvironmentId]?.serverConfig?.environment.platform
              .os ??
            null)
          : null;
    return getEnvironmentBrowsePlatform(os);
  }, [browseEnvironmentId, primaryEnvironmentId, savedEnvironmentRuntimeById]);
  const isRemoteProjectCloneFlow = addProjectCloneFlow !== null;
  const isRemoteProjectRepositoryStep = addProjectCloneFlow?.step === "repository";
  const isBrowsing =
    !isRemoteProjectRepositoryStep && isFilesystemBrowseQuery(query, browseEnvironmentPlatform);
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });
  const getAddProjectInitialQueryForEnvironment = useCallback(
    (environmentId: EnvironmentId | null): string => {
      const environmentSettings =
        environmentId && primaryEnvironmentId && environmentId === primaryEnvironmentId
          ? settings
          : environmentId
            ? savedEnvironmentRuntimeById[environmentId]?.serverConfig?.settings
            : null;
      const baseDirectory = environmentSettings?.addProjectBaseDirectory?.trim() ?? "";
      if (baseDirectory.length === 0) {
        return "~/";
      }
      return ensureBrowseDirectoryPath(baseDirectory);
    },
    [primaryEnvironmentId, savedEnvironmentRuntimeById, settings],
  );

  const projectCwdById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.cwd])),
    [projects],
  );
  const projectTitleById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.name])),
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

  const fetchBrowseResult = useCallback(
    async (partialPath: string): Promise<FilesystemBrowseResult | null> => {
      if (!browseEnvironmentId) return null;
      const api = readEnvironmentApi(browseEnvironmentId);
      if (!api) return null;
      return api.filesystem.browse({
        partialPath,
        ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
      });
    },
    [browseEnvironmentId, currentProjectCwdForBrowse],
  );

  const { data: browseResult, isPending: isBrowsePending } = useQuery({
    queryKey: [
      "filesystemBrowse",
      browseEnvironmentId,
      browseDirectoryPath,
      currentProjectCwdForBrowse,
    ],
    queryFn: () => fetchBrowseResult(browseDirectoryPath),
    staleTime: BROWSE_STALE_TIME_MS,
    enabled:
      isBrowsing &&
      browseDirectoryPath.length > 0 &&
      browseEnvironmentId !== null &&
      !relativePathNeedsActiveProject,
  });
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const {
    filteredEntries: filteredBrowseEntries,
    highlightedEntry: highlightedBrowseEntry,
    exactEntry: exactBrowseEntry,
  } = useMemo(
    () => filterBrowseEntries({ browseEntries, browseFilterQuery, highlightedItemValue }),
    [browseEntries, browseFilterQuery, highlightedItemValue],
  );

  const prefetchBrowsePath = useCallback(
    (partialPath: string) => {
      void queryClient.prefetchQuery({
        queryKey: [
          "filesystemBrowse",
          browseEnvironmentId,
          partialPath,
          currentProjectCwdForBrowse,
        ],
        queryFn: () => fetchBrowseResult(partialPath),
        staleTime: BROWSE_STALE_TIME_MS,
      });
    },
    [browseEnvironmentId, currentProjectCwdForBrowse, fetchBrowseResult, queryClient],
  );

  // Prefetch the parent and the most likely next child so browse navigation
  // stays warm without scanning every child directory in large trees.
  useEffect(() => {
    if (!isBrowsing || filteredBrowseEntries.length === 0) return;

    if (canNavigateUp(query)) {
      prefetchBrowsePath(getBrowseParentPath(query)!);
    }

    const nextChild = highlightedBrowseEntry ?? exactBrowseEntry;
    if (nextChild) {
      prefetchBrowsePath(appendBrowsePathSegment(query, nextChild.name));
    }
  }, [
    exactBrowseEntry,
    filteredBrowseEntries.length,
    highlightedBrowseEntry,
    isBrowsing,
    prefetchBrowsePath,
    query,
  ]);

  const openProjectFromSearch = useMemo(
    () => async (project: (typeof projects)[number]) => {
      const latestThread = getLatestThreadForProject(
        threads.filter((thread) => thread.environmentId === project.environmentId),
        project.id,
        settings.sidebarThreadSortOrder,
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

      await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
        envMode: settings.defaultThreadEnvMode,
      });
    },
    [
      handleNewThread,
      navigate,
      settings.defaultThreadEnvMode,
      settings.sidebarThreadSortOrder,
      threads,
    ],
  );

  const projectSearchItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "project",
        icon: (project) => (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.cwd}
            className={ITEM_ICON_CLASS}
          />
        ),
        runProject: openProjectFromSearch,
      }),
    [openProjectFromSearch, projects],
  );

  const projectThreadItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "new-thread-in",
        icon: (project) => (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.cwd}
            className={ITEM_ICON_CLASS}
          />
        ),
        runProject: async (project) => {
          await startNewThreadInProjectFromContext(
            {
              activeDraftThread,
              activeThread,
              defaultProjectRef,
              defaultThreadEnvMode: settings.defaultThreadEnvMode,
              handleNewThread,
            },
            scopeProjectRef(project.environmentId, project.id),
          );
        },
      }),
    [
      activeDraftThread,
      activeThread,
      defaultProjectRef,
      handleNewThread,
      projects,
      settings.defaultThreadEnvMode,
    ],
  );

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        sortOrder: settings.sidebarThreadSortOrder,
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
    [activeThreadId, navigate, projectTitleById, settings.sidebarThreadSortOrder, threads],
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
      const target = { environmentId };
      const initialDiscovery = getSourceControlDiscoverySnapshot(target).data;
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: buildAddProjectSourceGroups(
          environmentId,
          buildAddProjectRemoteSourceReadiness(initialDiscovery),
        ),
      });

      if (initialDiscovery) {
        return;
      }

      void refreshSourceControlDiscovery(target).then((discovery) => {
        setViewStack((previousViews) => {
          const currentTopView = previousViews.at(-1);
          if (currentTopView?.groups[0]?.value !== `sources:${environmentId}`) {
            return previousViews;
          }
          return [
            ...previousViews.slice(0, -1),
            {
              addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
              groups: buildAddProjectSourceGroups(
                environmentId,
                buildAddProjectRemoteSourceReadiness(discovery),
              ),
            },
          ];
        });
      });
    },
    [buildAddProjectSourceGroups],
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

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (projects.length > 0) {
    const activeProjectTitle = currentProjectId
      ? (projectTitleById.get(currentProjectId) ?? null)
      : null;

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
            activeThread,
            defaultProjectRef,
            defaultThreadEnvMode: settings.defaultThreadEnvMode,
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
  const activeGroups = currentView ? currentView.groups : rootGroups;

  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    projectSearchItems: projectSearchItems,
    threadSearchItems: allThreadItems,
  });

  const handleAddProject = useCallback(
    async (rawCwd: string) => {
      if (!browseEnvironmentId) return;
      const api = readEnvironmentApi(browseEnvironmentId);
      if (!api) return;

      if (isUnsupportedWindowsProjectPath(rawCwd.trim(), browseEnvironmentPlatform)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: "Windows-style paths are only supported on Windows.",
          }),
        );
        return;
      }

      if (isExplicitRelativeProjectPath(rawCwd.trim()) && !currentProjectCwdForBrowse) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: "Relative paths require an active project.",
          }),
        );
        return;
      }

      const cwd = resolveProjectPathForDispatch(rawCwd, currentProjectCwdForBrowse);
      if (cwd.length === 0) return;

      const existing = findProjectByPath(
        projects.filter((project) => project.environmentId === browseEnvironmentId),
        cwd,
      );
      if (existing) {
        const latestThread = getLatestThreadForProject(
          threads.filter((thread) => thread.environmentId === existing.environmentId),
          existing.id,
          settings.sidebarThreadSortOrder,
        );
        if (latestThread) {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(latestThread.environmentId, latestThread.id),
            ),
          });
        } else {
          await handleNewThread(scopeProjectRef(existing.environmentId, existing.id), {
            envMode: settings.defaultThreadEnvMode,
          }).catch(() => undefined);
        }
        setOpen(false);
        return;
      }

      try {
        const projectId = newProjectId();
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title: inferProjectTitleFromPath(cwd),
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: new Date().toISOString(),
        });
        await handleNewThread(scopeProjectRef(browseEnvironmentId, projectId), {
          envMode: settings.defaultThreadEnvMode,
        }).catch(() => undefined);
        setOpen(false);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [
      browseEnvironmentId,
      browseEnvironmentPlatform,
      currentProjectCwdForBrowse,
      handleNewThread,
      navigate,
      projects,
      setOpen,
      settings.defaultThreadEnvMode,
      settings.sidebarThreadSortOrder,
      threads,
    ],
  );

  function getDefaultCloneParentPath(environmentId: EnvironmentId): string {
    return getAddProjectInitialQueryForEnvironment(environmentId);
  }

  async function submitAddProjectCloneFlow(destinationPathInput?: string): Promise<void> {
    if (!addProjectCloneFlow) {
      return;
    }

    const api = readEnvironmentApi(addProjectCloneFlow.environmentId);
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to clone project",
          description: "Environment API is not available.",
        }),
      );
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
      try {
        const repository = await api.sourceControl.lookupRepository({
          provider,
          repository: rawRepository,
        });
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
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Repository lookup failed",
            description: errorMessage(error),
          }),
        );
      } finally {
        setIsRemoteProjectLookingUp(false);
      }
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
    try {
      const result = await api.sourceControl.cloneRepository({
        remoteUrl: addProjectCloneFlow.remoteUrl,
        destinationPath,
      });
      await handleAddProject(result.cwd);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: errorMessage(error),
        }),
      );
    } finally {
      setIsRemoteProjectCloning(false);
    }
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
    primaryEnvironmentId !== null &&
    browseEnvironmentId === primaryEnvironmentId &&
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
    try {
      pickedPath = await api.dialogs.pickFolder(
        fileManagerInitialPath ? { initialPath: fileManagerInitialPath } : undefined,
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
    await handleAddProject(pickedPath);
  }, [
    canOpenProjectFromFileManager,
    fileManagerInitialPath,
    handleAddProject,
    isPickingProjectFolder,
  ]);

  return (
    <CommandDialogPopup
      aria-label="Command palette"
      className="overflow-hidden p-0"
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
              title={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
            >
              <span>{isRemoteProjectPending ? "Working" : remoteProjectButtonLabel}</span>
              <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
                <Kbd>Enter</Kbd>
              </KbdGroup>
            </Button>
          ) : isBrowsing ? (
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
                relativePathNeedsActiveProject || (isCloneDestinationStep && isRemoteProjectPending)
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
              title={`${submitActionLabel} (${addShortcutLabel})`}
            >
              <span>
                {isCloneDestinationStep && isRemoteProjectPending ? "Cloning" : submitActionLabel}
              </span>
              <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
                <Kbd>{hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter"}</Kbd>
              </KbdGroup>
            </Button>
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
                  <span className="truncate text-muted-foreground/70 text-xs">
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
              <span className={cn("text-muted-foreground/80")}>Navigate</span>
            </KbdGroup>
            {addProjectCloneFlow?.step === "repository" ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Enter</Kbd>
                <span className={cn("text-muted-foreground/80")}>
                  {remoteProjectButtonLabel ?? "Continue"}
                </span>
              </KbdGroup>
            ) : !canSubmitBrowsePath || hasHighlightedBrowseItem ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Enter</Kbd>
                <span className={cn("text-muted-foreground/80")}>Select</span>
              </KbdGroup>
            ) : null}
            {isSubmenu ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Backspace</Kbd>
                <span className={cn("text-muted-foreground/80")}>Back</span>
              </KbdGroup>
            ) : null}
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span className={cn("text-muted-foreground/80")}>Close</span>
            </KbdGroup>
          </div>
          {canOpenProjectFromFileManager ? (
            <Button
              variant="ghost"
              size="xs"
              className="h-auto px-2 text-xs text-muted-foreground/80 hover:bg-transparent hover:text-foreground"
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
