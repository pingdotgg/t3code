"use client";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_DRIVER_KIND,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type FilesystemBrowseResult,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CornerLeftUpIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useArchivedThreadSnapshots } from "../archivedThreadsState";
import { readEnvironmentApi } from "../environmentApi";
import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  readEnvironmentConnection,
} from "../environments/runtime";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import {
  startNewThreadInProjectFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { DEFAULT_NEW_THREAD_WORKSPACE } from "../lib/newThreadDefaults";
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
  mapThreadShell,
  useStore,
} from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import {
  ADDON_ICON_CLASS,
  ARCHIVED_PALETTE_SCOPE,
  buildBrowseGroups,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  buildTranscriptActionItems,
  type TranscriptSearchItem,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterBrowseEntries,
  filterCommandPaletteGroups,
  filterPaletteItemsByScopes,
  filterTranscriptMatchesByScopes,
  formatPaletteScopeLabels,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  isSamePaletteScope,
  ITEM_ICON_CLASS,
  parsePaletteScopeQualifiers,
  parseTrailingPaletteScopeQualifier,
  RECENT_THREAD_LIMIT,
  resolvePaletteScopeThreadKeys,
  paletteScopeKey,
  selectPaletteScopeEnvironmentIds,
  type PaletteScope,
} from "./CommandPalette.logic";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
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
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];
const EMPTY_THREAD_SEARCH_ITEMS: ReadonlyArray<CommandPaletteActionItem> = [];
const EMPTY_COMMAND_PALETTE_GROUPS: ReadonlyArray<CommandPaletteGroup> = [];
const EMPTY_ENVIRONMENT_IDS: ReadonlyArray<EnvironmentId> = [];
const EMPTY_TRANSCRIPT_SEARCH_ITEMS: TranscriptSearchItem[] = [];
const BROWSE_STALE_TIME_MS = 30_000;
const TRANSCRIPT_SEARCH_DEBOUNCE_MS = 125;

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

function PaletteScopeChip(props: {
  scope: PaletteScope;
  project: { environmentId: EnvironmentId; cwd: string } | undefined;
  onRemove: (scope: PaletteScope) => void;
}) {
  return (
    <span className="flex h-6 max-w-36 shrink-0 items-center gap-1 rounded-md border border-border bg-muted py-0 ps-1.5 pe-1 text-xs text-foreground">
      {props.scope.kind === "project" && props.project ? (
        <ProjectFavicon
          environmentId={props.project.environmentId}
          cwd={props.project.cwd}
          className="size-3.5 shrink-0 text-muted-foreground/80"
        />
      ) : props.scope.kind === "archived" ? (
        <ArchiveIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
      ) : (
        <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
      )}
      <span className="truncate" title={props.scope.label}>
        {props.scope.label}
      </span>
      <button
        type="button"
        aria-label={`Remove ${props.scope.kind} filter ${props.scope.label}`}
        title={`Remove ${props.scope.label} filter`}
        onClick={() => props.onRemove(props.scope)}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

function OpenCommandPaletteDialog() {
  const navigate = useNavigate();
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const openIntent = useCommandPaletteStore((store) => store.openIntent);
  const projectSelection = useRef(openIntent?.onProjectSelected);
  const clearOpenIntent = useCommandPaletteStore((store) => store.clearOpenIntent);
  const composerHandleRef = useComposerHandleContext();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [scopes, setScopes] = useState<PaletteScope[]>([]);
  const [transcriptSearchResult, setTranscriptSearchResult] = useState<{
    archived: boolean;
    items: TranscriptSearchItem[];
  }>({ archived: false, items: EMPTY_TRANSCRIPT_SEARCH_ITEMS });
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const queryClient = useQueryClient();
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const settings = useSettings();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const activeThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const searchArchived = scopes.some((scope) => scope.kind === "archived");
  const addScope = useCallback((scope: PaletteScope): void => {
    setScopes((previous) =>
      previous.some((active) => isSamePaletteScope(active, scope))
        ? previous
        : [...previous, scope],
    );
    setHighlightedItemValue(null);
  }, []);
  const transcriptSearchItems =
    transcriptSearchResult.archived === searchArchived
      ? transcriptSearchResult.items
      : EMPTY_TRANSCRIPT_SEARCH_ITEMS;
  const allTranscriptSearchEnvironmentIds = useStore(
    useShallow((state) => [
      ...new Set([
        ...selectProjectsAcrossEnvironments(state).map((project) => project.environmentId),
        ...selectSidebarThreadsAcrossEnvironments(state).map((thread) => thread.environmentId),
      ]),
    ]),
  );
  // Scoped search skips environments with nothing in scope, so the slowest
  // environment no longer sets transcript latency.
  const transcriptSearchEnvironmentIds = useMemo(() => {
    const scoped = selectPaletteScopeEnvironmentIds(scopes);
    return scoped ?? allTranscriptSearchEnvironmentIds;
  }, [allTranscriptSearchEnvironmentIds, scopes]);
  const archivedState = useArchivedThreadSnapshots(
    searchArchived ? transcriptSearchEnvironmentIds : EMPTY_ENVIRONMENT_IDS,
  );
  const threads = useMemo(
    () =>
      searchArchived
        ? archivedState.snapshots.flatMap(({ environmentId, snapshot }) =>
            snapshot.threads
              .filter((thread) => thread.archivedAt !== null)
              .map((thread) => mapThreadShell(thread, environmentId).summary),
          )
        : activeThreads,
    [activeThreads, archivedState.snapshots, searchArchived],
  );
  const keybindings = useServerKeybindings();
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const [addProjectEnvironmentId, setAddProjectEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
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
  const isBrowsing = isFilesystemBrowseQuery(query, browseEnvironmentPlatform);
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
  const scopedThreadIdsByEnvironment = useMemo(() => {
    if (scopes.length === 0) return null;
    const keys = resolvePaletteScopeThreadKeys(scopes, threads);
    const byEnvironment = new Map<EnvironmentId, Set<ThreadId>>();
    const add = (environmentId: EnvironmentId, threadId: ThreadId) => {
      if (!keys.has(paletteScopeKey(environmentId, threadId))) return;
      const ids = byEnvironment.get(environmentId) ?? new Set<ThreadId>();
      ids.add(threadId);
      byEnvironment.set(environmentId, ids);
    };
    for (const thread of threads) add(thread.environmentId, thread.id);
    for (const scope of scopes) {
      if (scope.kind === "thread") add(scope.environmentId, scope.threadId);
    }
    return byEnvironment;
  }, [scopes, threads]);

  useEffect(() => {
    const normalizedQuery = deferredQuery.trim().replace(/\s+/g, " ");
    if (
      normalizedQuery.length < 3 ||
      normalizedQuery.startsWith(">") ||
      currentView !== null ||
      isBrowsing
    ) {
      setTranscriptSearchResult({ archived: searchArchived, items: EMPTY_TRANSCRIPT_SEARCH_ITEMS });
      return;
    }

    setTranscriptSearchResult({ archived: searchArchived, items: EMPTY_TRANSCRIPT_SEARCH_ITEMS });
    let current = true;
    const timer = window.setTimeout(() => {
      void Promise.allSettled(
        transcriptSearchEnvironmentIds.flatMap((environmentId) => {
          const threadIds = scopedThreadIdsByEnvironment?.get(environmentId);
          if (scopedThreadIdsByEnvironment && !threadIds?.size) return [];
          const api = readEnvironmentApi(environmentId);
          return api
            ? [
                api.orchestration
                  .searchTranscript({
                    query: normalizedQuery,
                    ...(searchArchived ? { archived: true } : {}),
                    ...(threadIds ? { threadIds: [...threadIds] } : {}),
                  })
                  .then((result) =>
                    result.matches.map(
                      (match) => ({ environmentId, match }) satisfies TranscriptSearchItem,
                    ),
                  ),
              ]
            : [];
        }),
      ).then((results) => {
        if (!current) return;
        if (searchArchived && results.some((result) => result.status === "rejected")) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not search archived conversations",
              description: "Some environments could not be searched. Try again after reconnecting.",
            }),
          );
        }
        setTranscriptSearchResult({
          archived: searchArchived,
          items: results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
        });
      });
    }, TRANSCRIPT_SEARCH_DEBOUNCE_MS);

    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [
    currentView,
    isBrowsing,
    deferredQuery,
    scopedThreadIdsByEnvironment,
    searchArchived,
    transcriptSearchEnvironmentIds,
  ]);

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
        activeThreads.filter((thread) => thread.environmentId === project.environmentId),
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
        ...DEFAULT_NEW_THREAD_WORKSPACE,
      });
    },
    [activeThreads, handleNewThread, navigate, settings.sidebarThreadSortOrder],
  );

  const renderProjectFavicon = useCallback(
    (project: (typeof projects)[number]) => (
      <ProjectFavicon
        environmentId={project.environmentId}
        cwd={project.cwd}
        className={ITEM_ICON_CLASS}
      />
    ),
    [],
  );

  const projectSearchItems = useMemo(
    () =>
      filterPaletteItemsByScopes(
        buildProjectActionItems({
          projects,
          valuePrefix: "project",
          icon: renderProjectFavicon,
          runProject: async (project) => {
            if (searchArchived) {
              addScope({
                kind: "project",
                environmentId: project.environmentId,
                projectId: project.id,
                label: project.name,
              });
              setQuery("");
              inputRef.current?.focus();
            } else {
              await openProjectFromSearch(project);
            }
          },
        }).map((item) => (searchArchived ? { ...item, keepOpen: true } : item)),
        scopes,
        threads,
      ),
    [
      addScope,
      openProjectFromSearch,
      projects,
      renderProjectFavicon,
      scopes,
      searchArchived,
      threads,
    ],
  );

  const projectThreadItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "new-thread-in",
        icon: renderProjectFavicon,
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
      renderProjectFavicon,
      settings.defaultThreadEnvMode,
    ],
  );
  const shouldBuildThreadSearchItems =
    currentView === null && !isActionsOnly && deferredQuery.trim().length > 0;
  const openThreadFromSearch = useCallback(
    async (ref: ScopedThreadRef & { messageId?: string }) => {
      if (searchArchived) {
        const connection = readEnvironmentConnection(ref.environmentId);
        if (!connection) throw new Error("The thread's environment is disconnected.");
        const snapshot = await connection.client.orchestration.getThreadSnapshot({
          threadId: ref.threadId,
        });
        useStore.getState().syncServerThreadDetail(snapshot.thread, ref.environmentId);
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
        search: (previous) => (ref.messageId ? { ...previous, message: ref.messageId } : previous),
      });
    },
    [navigate, searchArchived],
  );
  const buildThreadItems = useCallback(
    (limit?: number) =>
      buildThreadActionItems({
        threads,
        archived: searchArchived,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        sortOrder: settings.sidebarThreadSortOrder,
        icon: searchArchived ? (
          <ArchiveIcon className={ITEM_ICON_CLASS} />
        ) : (
          <MessageSquareIcon className={ITEM_ICON_CLASS} />
        ),
        renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
        renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
        runThread: async (thread) =>
          openThreadFromSearch(scopeThreadRef(thread.environmentId, thread.id)),
        ...(limit === undefined ? {} : { limit }),
      }),
    [
      activeThreadId,
      openThreadFromSearch,
      projectTitleById,
      searchArchived,
      settings.sidebarThreadSortOrder,
      threads,
    ],
  );
  const threadSearchItems = useMemo(
    () =>
      shouldBuildThreadSearchItems
        ? filterPaletteItemsByScopes(buildThreadItems(), scopes, threads)
        : EMPTY_THREAD_SEARCH_ITEMS,
    [buildThreadItems, scopes, shouldBuildThreadSearchItems, threads],
  );
  const recentThreadItems = useMemo(() => {
    if (threadSearchItems.length > 0) {
      return threadSearchItems.slice(0, RECENT_THREAD_LIMIT);
    }

    return filterPaletteItemsByScopes(
      buildThreadItems(scopes.length > 0 ? undefined : RECENT_THREAD_LIMIT),
      scopes,
      threads,
    ).slice(0, RECENT_THREAD_LIMIT);
  }, [buildThreadItems, scopes, threadSearchItems, threads]);

  const removeScope = useCallback((scope: PaletteScope): void => {
    setScopes((previous) => previous.filter((active) => !isSamePaletteScope(active, scope)));
    setHighlightedItemValue(null);
    inputRef.current?.focus();
  }, []);

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
    setScopes([]);
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
    if (viewStack.length <= 1) {
      setAddProjectEnvironmentId(null);
    }
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    setHighlightedItemValue(null);
    if (isFilesystemBrowseQuery(nextQuery, browseEnvironmentPlatform)) {
      if (scopes.length > 0) {
        setScopes([]);
      }
      setQuery(nextQuery);
      return;
    }
    const { scopes: qualifierScopes, text } =
      currentView === null
        ? parsePaletteScopeQualifiers(nextQuery, projects, threads)
        : { scopes: [], text: nextQuery };
    if (qualifierScopes.length > 0) {
      setScopes((previous) => {
        const merged = [...previous];
        for (const scope of qualifierScopes) {
          if (!merged.some((active) => isSamePaletteScope(active, scope))) {
            merged.push(scope);
          }
        }
        return merged;
      });
      setQuery(text);
    } else {
      setQuery(nextQuery);
    }
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const startAddProjectBrowse = useCallback(
    (environmentId: EnvironmentId): void => {
      setAddProjectEnvironmentId(environmentId);
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [],
        initialQuery: getAddProjectInitialQueryForEnvironment(environmentId),
      });
    },
    [getAddProjectInitialQueryForEnvironment],
  );

  const addProjectEnvironmentItems: CommandPaletteActionItem[] = addProjectEnvironmentOptions.map(
    (option) => ({
      kind: "action",
      value: `action:add-project:environment:${option.environmentId}`,
      searchTerms: [
        option.label,
        option.environmentId,
        option.isPrimary ? "primary environment" : "",
      ],
      title: option.label,
      description: option.environmentId,
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        startAddProjectBrowse(option.environmentId);
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

    startAddProjectBrowse(environmentId);
  }, [
    addProjectEnvironmentGroups,
    addProjectEnvironmentOptions.length,
    defaultAddProjectEnvironmentId,
    startAddProjectBrowse,
  ]);

  useEffect(() => {
    if (openIntent?.kind !== "add-project") {
      return;
    }
    projectSelection.current = openIntent.onProjectSelected;
    clearOpenIntent();
    if (openIntent.environmentId) {
      startAddProjectBrowse(openIntent.environmentId);
    } else {
      openAddProjectFlow();
    }
  }, [clearOpenIntent, openAddProjectFlow, openIntent, startAddProjectBrowse]);

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (!searchArchived) {
    actionItems.push({
      kind: "action",
      value: "action:search-archived",
      searchTerms: ["archived", "archive", "search archived threads"],
      title: "Search archived threads",
      description: "Only archived threads",
      icon: <ArchiveIcon className={ITEM_ICON_CLASS} />,
      scope: ARCHIVED_PALETTE_SCOPE,
      keepOpen: true,
      run: async () => {
        addScope(ARCHIVED_PALETTE_SCOPE);
        setQuery("");
        inputRef.current?.focus();
      },
    });
  }

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

  if (addProjectEnvironmentOptions.length > 1) {
    actionItems.push({
      kind: "submenu",
      value: "action:add-project",
      searchTerms: ["add project", "folder", "directory", "browse", "environment"],
      title: "Add project",
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
      groups: addProjectEnvironmentGroups,
    });
  } else {
    actionItems.push({
      kind: "action",
      value: "action:add-project",
      searchTerms: ["add project", "folder", "directory", "browse"],
      title: "Add project",
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        openAddProjectFlow();
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

  const rootGroups = buildRootGroups({
    actionItems: searchArchived ? [] : actionItems,
    recentThreadItems,
  });
  const activeGroups = currentView ? currentView.groups : rootGroups;

  const filteredActiveGroups = useMemo(
    () =>
      filterCommandPaletteGroups({
        activeGroups,
        query: deferredQuery,
        isInSubmenu: currentView !== null,
        projectSearchItems: EMPTY_THREAD_SEARCH_ITEMS,
        threadSearchItems: EMPTY_THREAD_SEARCH_ITEMS,
      }),
    [activeGroups, currentView, deferredQuery],
  );
  const filteredSearchGroups = useMemo(() => {
    if (currentView) {
      return EMPTY_COMMAND_PALETTE_GROUPS;
    }

    return filterCommandPaletteGroups({
      activeGroups: EMPTY_COMMAND_PALETTE_GROUPS,
      query: deferredQuery,
      isInSubmenu: false,
      projectSearchItems,
      threadSearchItems,
    });
  }, [currentView, deferredQuery, projectSearchItems, threadSearchItems]);
  const filteredGroups = useMemo(
    () => (currentView ? filteredActiveGroups : [...filteredActiveGroups, ...filteredSearchGroups]),
    [currentView, filteredActiveGroups, filteredSearchGroups],
  );
  const transcriptGroup = useMemo<CommandPaletteGroup | null>(() => {
    if (transcriptSearchItems.length === 0 || currentView !== null || isActionsOnly) {
      return null;
    }
    const items = buildTranscriptActionItems({
      matches: filterTranscriptMatchesByScopes(transcriptSearchItems, scopes, threads),
      metadataGroups: filteredGroups,
      icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
      runThread: openThreadFromSearch,
    });
    return items.length > 0
      ? { value: "conversation-matches", label: "Conversation matches", items }
      : null;
  }, [
    currentView,
    filteredGroups,
    isActionsOnly,
    openThreadFromSearch,
    scopes,
    searchArchived,
    threads,
    transcriptSearchItems,
  ]);

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
        if (projectSelection.current) {
          projectSelection.current(scopeProjectRef(existing.environmentId, existing.id));
          setOpen(false);
          return;
        }
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
            ...DEFAULT_NEW_THREAD_WORKSPACE,
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
            instanceId: defaultInstanceIdForDriver(DEFAULT_PROVIDER_DRIVER_KIND),
            model: DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_DRIVER_KIND] ?? DEFAULT_MODEL,
          },
          createdAt: new Date().toISOString(),
        });
        if (projectSelection.current) {
          projectSelection.current(scopeProjectRef(browseEnvironmentId, projectId));
        } else {
          await handleNewThread(scopeProjectRef(browseEnvironmentId, projectId), {
            ...DEFAULT_NEW_THREAD_WORKSPACE,
          }).catch(() => undefined);
        }
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
      settings.sidebarThreadSortOrder,
      threads,
    ],
  );

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

  let displayedGroups = filteredGroups;
  if (transcriptGroup) {
    displayedGroups = [...displayedGroups, transcriptGroup];
  }
  if (isBrowsing) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  }

  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canSubmitBrowsePath = isBrowsing && !relativePathNeedsActiveProject;

  const findDisplayedItem = (
    value: string | null,
  ): CommandPaletteActionItem | CommandPaletteSubmenuItem | null => {
    if (value === null) {
      return null;
    }
    for (const group of displayedGroups) {
      const found = group.items.find((item) => item.value === value);
      if (found) {
        return found;
      }
    }
    return null;
  };

  // Automatic highlight changes can omit the callback or leave a removed row.
  const highlightedItem =
    findDisplayedItem(highlightedItemValue) ?? displayedGroups[0]?.items[0] ?? null;
  const highlightedScopeItem =
    currentView === null && !isBrowsing && !isActionsOnly ? (highlightedItem?.scope ?? null) : null;
  const pendingQualifier =
    currentView === null && !isBrowsing && !isActionsOnly
      ? parseTrailingPaletteScopeQualifier(query, projects, threads)
      : null;
  const showScopeHint = highlightedScopeItem !== null || pendingQualifier !== null;

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const shouldSubmitBrowsePath =
      canSubmitBrowsePath &&
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

    if (shouldSubmitBrowsePath) {
      event.preventDefault();
      void handleAddProject(resolvedAddProjectPath);
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
      return;
    }

    if (
      event.key === "Backspace" &&
      query === "" &&
      !isSubmenu &&
      !isBrowsing &&
      scopes.length > 0
    ) {
      event.preventDefault();
      setScopes((previous) => previous.slice(0, -1));
      setHighlightedItemValue(null);
      return;
    }

    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.nativeEvent.isComposing &&
      showScopeHint
    ) {
      const scope = pendingQualifier ?? highlightedScopeItem;
      if (scope) {
        event.preventDefault();
        addScope(scope);
        setQuery("");
      }
    }
  }

  const scopedLabels = scopes.length > 0 ? formatPaletteScopeLabels(scopes) : null;
  const showScopeChips = scopes.length > 0 && !isSubmenu && !isBrowsing;
  const inputPlaceholder =
    scopedLabels && !isSubmenu && !isBrowsing
      ? `Search in ${scopedLabels}...`
      : getCommandPaletteInputPlaceholder(paletteMode);
  const willCreateProjectPath =
    canSubmitBrowsePath &&
    !isBrowsePending &&
    query.trim().length > 0 &&
    !hasHighlightedBrowseItem &&
    (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
  const useMetaForMod = isMacPlatform(navigator.platform);
  const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
  const submitActionLabel = willCreateProjectPath ? "Create & Add" : "Add";
  const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
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

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
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
      className="overflow-hidden bg-chat-background p-0 before:bg-transparent"
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
        key={`${viewStack.length}-${browseGeneration}-${isBrowsing}`}
        aria-label="Command palette"
        autoHighlight={isBrowsing ? false : "always"}
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={handleQueryChange}
        value={query}
      >
        <div className="relative flex items-center gap-1.5">
          {showScopeChips ? (
            <div
              className="flex min-w-0 max-w-1/2 shrink-0 items-center gap-1 overflow-x-auto ps-3"
              role="group"
              aria-label="Active search scopes"
            >
              {scopes.map((scope) => (
                <PaletteScopeChip
                  key={
                    scope.kind === "archived"
                      ? "archived"
                      : scope.kind === "project"
                        ? `project:${scope.environmentId}:${scope.projectId}`
                        : `thread:${scope.environmentId}:${scope.threadId}`
                  }
                  scope={scope}
                  project={
                    scope.kind === "project"
                      ? projects.find(
                          (project) =>
                            project.environmentId === scope.environmentId &&
                            project.id === scope.projectId,
                        )
                      : undefined
                  }
                  onRemove={removeScope}
                />
              ))}
            </div>
          ) : null}
          <div className="relative min-w-0 flex-1">
            <CommandInput
              ref={inputRef}
              className={isBrowsing ? (willCreateProjectPath ? "pe-36" : "pe-16") : undefined}
              placeholder={inputPlaceholder}
              wrapperClassName={
                isSubmenu
                  ? "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto"
                  : undefined
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
            {isBrowsing ? (
              <Button
                variant="outline"
                size="xs"
                tabIndex={-1}
                className={cn(
                  "absolute end-2.5 top-1/2 pe-1 ps-2 -translate-y-1/2",
                  hasHighlightedBrowseItem ? "gap-1" : "gap-1.5",
                )}
                aria-label={`${submitActionLabel} (${addShortcutLabel})`}
                disabled={relativePathNeedsActiveProject}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  if (relativePathNeedsActiveProject) {
                    return;
                  }
                  void handleAddProject(resolvedAddProjectPath);
                }}
                title={`${submitActionLabel} (${addShortcutLabel})`}
              >
                <span>{submitActionLabel}</span>
                <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
                  <Kbd>{hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter"}</Kbd>
                </KbdGroup>
              </Button>
            ) : null}
          </div>
        </div>
        <CommandPanel className="max-h-[min(28rem,70vh)] bg-chat-background">
          {searchArchived && archivedState.error ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-destructive"
            >
              <span>Could not load archived threads: {archivedState.error}</span>
              <Button variant="outline" size="xs" onClick={archivedState.refresh}>
                Retry
              </Button>
            </div>
          ) : searchArchived && archivedState.isLoading && threads.length === 0 ? (
            <div role="status" className="px-3 py-2 text-sm text-muted-foreground">
              Loading archived threads...
            </div>
          ) : null}
          <CommandPaletteResults
            groups={displayedGroups}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={isActionsOnly}
            keybindings={keybindings}
            onExecuteItem={executeItem}
            query={deferredQuery}
            {...(relativePathNeedsActiveProject
              ? { emptyStateMessage: "Relative paths require an active project." }
              : willCreateProjectPath
                ? {
                    emptyStateMessage: "Press Enter to create this folder and add it as a project.",
                  }
                : scopedLabels && displayedGroups.length === 0
                  ? {
                      emptyStateMessage: `No matches in ${scopedLabels} for "${deferredQuery.trim()}".`,
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
            {!canSubmitBrowsePath || hasHighlightedBrowseItem ? (
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
            {showScopeHint ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Tab</Kbd>
                <span className={cn("text-muted-foreground/80")}>Scope</span>
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
