"use client";

import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  canCreateProjectInEnvironment,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  getNewProjectGitHubRepository,
  getNewProjectGitHubTarget,
  getNewProjectPathPreview,
  isDefaultCloneParentDirectory,
  normalizePastedCloneUrl,
  resolveCloneParentDirectory,
  resolveNewProjectParentDirectory,
} from "@t3tools/client-runtime/operations/projects";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { resolveThreadReferenceCopyTarget } from "@t3tools/shared/threadReference";
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
  type DesktopWslState,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type FilesystemBrowseResult,
  type ProjectId,
  type SourceControlDiscoveryResult,
  type SourceControlProviderKind,
  type SourceControlRepositoryInfo,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  ArrowLeftIcon,
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
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  RotateCcwIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
  TextSearchIcon,
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
import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useClientSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { getThemeDefinition } from "../themePalette";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  ThemePreviewCircle,
} from "./settings/ThemePreviewCircles";
import { readLocalApi } from "../localApi";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { filesystemEnvironment } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useScratchProject } from "../hooks/useScratchProject";
import { useNewProject } from "../hooks/useNewProject";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs, useThreadShells, waitForProject } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../lib/projectPaths";
import { onOpenCommandPalette } from "../commandPaletteBus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  PULL_REQUESTS_PANEL_REF,
  selectActiveRightPanel,
  useRightPanelStore,
} from "../rightPanelStore";
import { getLatestThreadForProject, sortThreads } from "../lib/threadSort";
import {
  cn,
  getLocalFileManagerName,
  isMacPlatform,
  isWindowsPlatform,
  newProjectId,
} from "../lib/utils";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../wslPaths";
import {
  ADDON_ICON_CLASS,
  browseInputEndPaddingClass,
  buildBrowseGroups,
  buildCommandPaletteProjectMetadata,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  buildLinkedThreadActionItems,
  buildCommandPaletteRows,
  enumerateCommandPaletteItems,
  findHighlightedCommandPaletteItem,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  filterPinnedBrowseEntries,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  reduceCommandPaletteUiState,
  type SearchOverlayMode,
} from "./CommandPalette.logic";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon, ForgejoIcon } from "./Icons";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Checkbox } from "./ui/checkbox";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { openLinkPullRequestDialog } from "./pullRequest/LinkPullRequestDialog";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import { searchSettings, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import {
  COMMAND_PALETTE_META_ICON_CLASS,
  CommandPaletteMetaDot,
  ThreadCommandSubtitle,
} from "./ThreadCommandSubtitle";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "./ui/command";
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
import type { Project } from "../types";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "~/components/pullRequest/pullRequestListPreferences";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

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
  readonly machine: EnvironmentMachineKind;
  readonly isPrimary: boolean;
  readonly isConnected: boolean;
  readonly status: string;
}

type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "forgejo" | "bitbucket" | "azure-devops"
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
  "forgejo",
  "bitbucket",
  "azure-devops",
];
const REMOTE_PROJECT_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  "github",
  "gitlab",
  "forgejo",
  "bitbucket",
  "azure-devops",
];

function remoteProjectSourceLabel(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "forgejo":
      return "Forgejo / Gitea";
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
    case "forgejo":
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
    case "forgejo":
      return <ForgejoIcon className={className} />;
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

function projectFaviconIcon(project: Project): ReactNode {
  return <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />;
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
    forgejo: unavailable,
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

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
  "projectSearch.toggle": "content",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}

const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", icon: MonitorIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
] as const;

function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't save theme selection",
      description: "Try again.",
    }),
  );
}

function projectFavicon(project: Project) {
  return <ProjectFavicon project={project} className="size-4" />;
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);
  const toggleMode = useCallback(
    (mode: SearchOverlayMode) => dispatch({ _tag: "ToggleMode", mode }),
    [],
  );
  const openAddProject = useCallback(() => dispatch({ _tag: "OpenAddProject" }), []);
  const openNewThreadIn = useCallback(() => dispatch({ _tag: "OpenNewThreadIn" }), []);
  const clearOpenIntent = useCallback(() => dispatch({ _tag: "ClearOpenIntent" }), []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme, appearanceMode, setAppearanceMode } = useTheme();
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
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );

  useEffect(() => {
    if (!state.open || state.mode === "command") return;
    const onEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode("command");
    };
    window.addEventListener("keydown", onEscapeKeyDown, true);
    return () => window.removeEventListener("keydown", onEscapeKeyDown, true);
  }, [state.mode, state.open, toggleMode]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Resolve with the complete shortcut context so customized bindings
      // using any documented `when` condition (e.g. previewFocus) work.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          modelPickerOpen: composerHandleRef.current?.isModelPickerOpen() ?? false,
        },
      });
      if (command === "appearance.cycle") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const nextMode =
          appearanceMode === "system" ? "light" : appearanceMode === "light" ? "dark" : "system";
        if (!setAppearanceMode(nextMode)) {
          notifyThemeSaveFailure();
        } else {
          toastManager.add({
            id: "appearance-cycle",
            title: `Appearance: ${APPEARANCE_OPTIONS.find((option) => option.mode === nextMode)?.label}`,
            timeout: 1500,
          });
        }
        return;
      }
      if (command === "theme.select") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        dispatch({ _tag: "OpenChangeTheme" });
        return;
      }
      if (command === "themeEditor.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleThemeEditorForTheme({
          theme,
          themeHalves,
          initialAppearance: resolvedTheme,
        });
        return;
      }
      if (command === "usage.open") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        void navigate({ to: "/usage" });
        return;
      }
      const mode = overlayModeForCommand(command);
      if (mode === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    appearanceMode,
    keybindings,
    navigate,
    previewOpen,
    resolvedTheme,
    setAppearanceMode,
    setOpen,
    terminalOpen,
    theme,
    themeHalves,
    toggleMode,
  ]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "new-thread-in") {
          openNewThreadIn();
        } else if (detail.open === "add-project") {
          openAddProject();
        } else if (detail.query !== undefined) {
          dispatch({
            _tag: "OpenSearch",
            query: detail.query,
            ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
          });
        } else {
          setOpen(true);
        }
      }),
    [openAddProject, openNewThreadIn, setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            toggleMode("command");
            return;
          }
          setOpen(open);
        }}
      >
        {/* Block background focus calls for the entire time the palette is open. */}
        <div className="contents" inert={state.open}>
          {children}
        </div>
        <CommandPaletteDialog
          mode={state.mode}
          openIntent={state.openIntent}
          setOpen={setOpen}
          openOverlayMode={toggleMode}
          clearOpenIntent={clearOpenIntent}
        />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
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
        composerHandleRef?.current?.focusAtEnd();
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
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openOverlayMode={props.openOverlayMode}
          clearOpenIntent={props.clearOpenIntent}
        />
      )}
    </CommandDialogPopup>
  );
}

/** Keep command navigation and project actions scoped to the currently browsed environment. */
function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { clearOpenIntent, openIntent, openOverlayMode, setOpen } = props;
  const [query, setQuery] = useState(openIntent?.kind === "search" ? openIntent.query : "");
  const [linkedThreadSearch, setLinkedThreadSearch] = useState(
    openIntent?.kind === "search" ? openIntent : null,
  );
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const resultListRef = useRef<LegendListRef | null>(null);
  // Typing or entering a submenu clears the highlight. Base UI keeps its own on the
  // first row, but the palette shows none until the user navigates, and the first
  // ArrowDown lands on it.
  const highlightClearedRef = useRef(false);
  function clearTypedHighlight(): void {
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
  }
  const clientSettings = useClientSettings();
  const createProject = useAtomCommand(projectEnvironment.create, {
    reportFailure: false,
  });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, startScratchThread } = useScratchProject();
  const lookupRepository = useAtomQueryRunner(sourceControlEnvironment.repository, {
    reportFailure: false,
  });
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const updateEnvironmentSettings = useAtomCommand(serverEnvironment.updateSettings, {
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
  const projects = useProjects();
  const referenceThreadRef =
    pathname === "/pull-requests"
      ? environments.some(
          (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
        )
        ? PULL_REQUESTS_PANEL_REF
        : null
      : activeThread
        ? scopeThreadRef(activeThread.environmentId, activeThread.id)
        : null;
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(referenceThreadRef);
  const activeThreadServerConfig = useServerConfigs().get(
    activeThread?.environmentId ?? ("" as EnvironmentId),
  );
  const activeThreadReferenceCopyTarget =
    referenceThreadRef === null || (pathname === "/pull-requests" && !openPanelPullRequestUrl)
      ? null
      : resolveThreadReferenceCopyTarget({
          threadId: referenceThreadRef.threadId,
          openPanelPullRequestUrl,
          pullRequests: activeThread?.pullRequests,
          linkedPullRequestUrl:
            activeThread?.linkedPullRequest?.url ?? activeThread?.branchPullRequest?.url ?? null,
        });
  const copyActiveThreadReference = useCallback(async () => {
    const target = activeThreadReferenceCopyTarget;
    if (target === null) return;
    try {
      const didCopy = await writeTextToClipboard(target.value, target.clipboardTarget);
      if (!didCopy) return;
      toastManager.add({
        type: "success",
        title: target.successTitle,
        description: target.value,
      });
    } catch (error) {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: target.failureTitle,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [activeThreadReferenceCopyTarget]);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const themeCards = useMemo(() => {
    const seen = new Set<string>();
    return [
      ...STANDARD_THEME_CARDS.map((card) => ({ ...card, id: null })),
      ...[...BUILT_IN_THEMES, ...customThemes, ...environmentThemes]
        .filter((definition) => {
          if (seen.has(definition.id)) return false;
          seen.add(definition.id);
          return true;
        })
        .map(getThemeCardDefinition),
    ];
  }, [customThemes, environmentThemes]);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providerEntryByEnvironmentAndInstanceId = useMemo(() => {
    const map = new Map<string, ProviderInstanceEntry>();
    for (const environment of environments) {
      const serverConfig = environment.serverConfig;
      const environmentProviders =
        serverConfig?.providers ??
        (environment.environmentId === primaryEnvironmentId ? providers : []);
      const derived = deriveProviderInstanceEntries(environmentProviders);
      // Settings fill the ACP registry identity (agent id, icon URL) the
      // derived entries alone do not carry.
      const entries = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings)
        : derived;
      for (const entry of entries) {
        map.set(`${environment.environmentId}:${entry.instanceId}`, entry);
      }
    }
    return map;
  }, [environments, primaryEnvironmentId, providers]);
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const environmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const threadSearchQuery = currentView === null && !isActionsOnly ? deferredQuery : "";
  const threadSearch = useThreadSearch(environmentIds, threadSearchQuery);
  const threadContentMatchByKey = useMemo(
    () =>
      new Map(
        threadSearch.matches.flatMap((match) =>
          match.source === "user" || match.source === "assistant"
            ? [[threadSearchMatchKey(match), match] as const]
            : [],
        ),
      ),
    [threadSearch.matches],
  );
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const browseNavigationRef = useRef<ReturnType<typeof createBrowseNavigationCoordinator> | null>(
    null,
  );
  if (browseNavigationRef.current === null) {
    browseNavigationRef.current = createBrowseNavigationCoordinator();
  }
  const browseNavigation = browseNavigationRef.current;
  const [addProjectEnvironmentId, setAddProjectEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const [addProjectCloneFlow, setAddProjectCloneFlow] = useState<AddProjectCloneFlow | null>(null);
  // The name step of New project: while set, the palette input is the name.
  const [newProjectFlow, setNewProjectFlow] = useState<{
    readonly environmentId: EnvironmentId;
    /** Machine of the Add project sources view under this step; null from the palette root. */
    readonly sourcesEnvironmentId: EnvironmentId | null;
    readonly parentDirectory: string | null;
    /** The name to restore after choosing a folder; null while naming the project. */
    readonly folderSelectionName: string | null;
  } | null>(null);
  const [newProjectPublishesToGitHub, setNewProjectPublishesToGitHub] = useState(false);
  const [isCreatingNewProject, setIsCreatingNewProject] = useState(false);
  // State lags a render behind, so a repeated Enter could start a second create.
  const newProjectSubmittingRef = useRef(false);
  const createNewProject = useNewProject();
  const cloneLookupGeneration = useRef(0);
  const [isRemoteProjectLookingUp, setIsRemoteProjectLookingUp] = useState(false);
  const [isRemoteProjectCloning, setIsRemoteProjectCloning] = useState(false);
  const [isSavingProjectFolder, setIsSavingProjectFolder] = useState(false);
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
  const projectEnvironmentLocationById = useMemo(
    () =>
      new Map(
        environments.map((environment) => {
          const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
          const isLocal = isPrimary || isDesktopLocalConnectionTarget(environment.entry.target);
          return [
            environment.environmentId,
            {
              kind: isLocal ? "local" : "remote",
              label: isPrimary
                ? "Local"
                : isLocal
                  ? `${environment.label} (Local)`
                  : environment.label,
              machine: resolveEnvironmentMachineKind(environment.serverConfig),
            },
          ] as const;
        }),
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
        displayName: group.displayName,
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
  }, [environments]);
  const defaultAddProjectEnvironmentId =
    addProjectEnvironmentOptions.find((option) => option.isConnected)?.environmentId ?? null;
  const wslAddProjectEnvironmentOption = useMemo(
    () =>
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
  const isChoosingNewProjectFolder = newProjectFlow?.folderSelectionName != null;
  // The destination step pins the repository folder onto the browsed path, so
  // the proposed clone target is "<chosen folder>/<repo>" instead of the bare
  // folder. A lookup reports "owner/repo"; a pasted clone URL falls back to its
  // own last segment, minus ".git".
  const pinnedCloneDirectoryName =
    addProjectCloneFlow?.step === "confirm"
      ? getCloneDirectoryName(
          addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.remoteUrl,
        )
      : "";
  const browsePath = useMemo(
    () =>
      getFilesystemBrowsePath(
        query,
        browseEnvironmentPlatform,
        browseEnvironmentId !== null &&
          !isRemoteProjectRepositoryStep &&
          (newProjectFlow === null || isChoosingNewProjectFolder),
      ),
    [
      browseEnvironmentId,
      browseEnvironmentPlatform,
      isRemoteProjectRepositoryStep,
      newProjectFlow,
      isChoosingNewProjectFolder,
      query,
    ],
  );
  const isBrowsing = browsePath.isBrowsing;
  const browseDirectoryPath = browsePath.directoryPath;
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
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
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
  // Where "without a project" threads start: the current environment when it
  // offers them, otherwise the first connected one that does.
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    currentProjectEnvironmentId ?? primaryEnvironmentId,
  );
  const currentProjectCwd = currentProjectId
    ? (projectCwdById.get(currentProjectId) ?? null)
    : null;
  const currentProjectCwdForBrowse =
    browseEnvironmentId && currentProjectEnvironmentId === browseEnvironmentId
      ? currentProjectCwd
      : null;
  const getBrowseCwdForEnvironment = useCallback(
    (environmentId: EnvironmentId | null): string | null =>
      environmentId && currentProjectEnvironmentId === environmentId ? currentProjectCwd : null,
    [currentProjectCwd, currentProjectEnvironmentId],
  );
  const relativePathNeedsActiveProject =
    isExplicitRelativeProjectPath(query.trim()) && currentProjectCwdForBrowse === null;
  const browseQuery = useEnvironmentQuery(
    isBrowsing &&
      browsePath.directoryPath.length > 0 &&
      browseEnvironmentId !== null &&
      !relativePathNeedsActiveProject
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
  const isBrowsePending = browseQuery.isPending;
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const { visibleEntries: visibleBrowseEntries, exactEntry: exactBrowseEntry } = useMemo(
    () =>
      pinnedCloneDirectoryName
        ? filterPinnedBrowseEntries({
            browseEntries,
            filterQuery: browsePath.filterQuery,
            pinnedDirectoryName: pinnedCloneDirectoryName,
            caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
          })
        : filterFilesystemBrowseEntries(browseEntries, browsePath.filterQuery),
    [browseEntries, browseEnvironmentPlatform, browsePath.filterQuery, pinnedCloneDirectoryName],
  );

  const prefetchBrowsePath = useCallback(
    async (
      partialPath: string,
      environmentId: EnvironmentId | null = browseEnvironmentId,
      cwd: string | null = currentProjectCwdForBrowse,
    ): Promise<void> => {
      if (!environmentId) {
        return;
      }
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!canPreloadBrowsePath(environment?.connection.phase)) {
        return;
      }

      await loadBrowsePath({
        environmentId,
        input: {
          partialPath,
          ...(cwd ? { cwd } : {}),
        },
      });
    },
    [browseEnvironmentId, currentProjectCwdForBrowse, environments, loadBrowsePath],
  );

  useEffect(
    () => () => {
      browseNavigation.invalidate();
    },
    [browseNavigation],
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
          const members = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)
            ?.memberProjects ?? [project];
          return buildCommandPaletteProjectMetadata({
            projects: members,
            locationByEnvironmentId: projectEnvironmentLocationById,
          }).searchTerms;
        },
        renderDescription: (project) => {
          const members = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)
            ?.memberProjects ?? [project];
          const metadata = buildCommandPaletteProjectMetadata({
            projects: members,
            locationByEnvironmentId: projectEnvironmentLocationById,
          });
          const location = projectEnvironmentLocationById.get(project.environmentId) ?? {
            kind: "remote" as const,
            label: "Remote",
            machine: "server" as const,
          };
          return (
            <ProjectSearchDescription
              environmentLabels={metadata.environmentLabels}
              grouped={members.length > 1}
              location={location}
              workspaceRoot={project.workspaceRoot}
            />
          );
        },
        icon: projectFaviconIcon,
        runProject: openProjectFromSearch,
      }),
    [
      openProjectFromSearch,
      pickerProjects,
      projectEnvironmentLocationById,
      projectGroupByTargetKey,
    ],
  );

  const projectThreadItems = useMemo(
    () =>
      enumerateCommandPaletteItems([
        ...buildProjectActionItems({
          // The no-project home shows once, as the "No project" item below.
          projects: pickerProjects.filter(
            (project) => !isScratchProject(project, scratchWorkspaceRootFor(project.environmentId)),
          ),
          valuePrefix: "new-thread-in",
          searchTerms: (project) => {
            const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
            const location = projectEnvironmentLocationById.get(project.environmentId);
            return [
              ...(group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ??
                []),
              ...(location ? [location.label] : []),
            ];
          },
          renderDescription: (project) => {
            const location = projectEnvironmentLocationById.get(project.environmentId) ?? {
              kind: "remote",
              label: "Remote",
              machine: "server" as const,
            };
            return (
              <span className="flex min-w-0 items-center gap-1">
                <span className="inline-flex min-w-0 items-center gap-1">
                  {location.kind === "remote" ? (
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={location.machine}
                      className={COMMAND_PALETTE_META_ICON_CLASS}
                    />
                  ) : null}
                  <span className="truncate">{location.label}</span>
                </span>
                <CommandPaletteMetaDot />
                <span className="truncate">{project.workspaceRoot}</span>
              </span>
            );
          },
          icon: projectFaviconIcon,
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
        ...(scratchTargetEnvironmentId === null
          ? []
          : [
              {
                kind: "action" as const,
                value: "new-thread-in:no-project",
                searchTerms: ["no project", "without project", "none"],
                title: "No project",
                icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
                shortcutCommand: "chat.newWithoutProject" as const,
                run: () => startScratchThread(scratchTargetEnvironmentId),
              },
            ]),
      ]),
    [
      contextualProjectRef,
      handleNewThread,
      pickerProjects,
      projectEnvironmentLocationById,
      projectGroupByTargetKey,
      scratchTargetEnvironmentId,
      scratchWorkspaceRootFor,
      startScratchThread,
    ],
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
        renderDescription: (thread, { projectTitle }) => {
          const modelInstanceId =
            thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
          const providerEntry =
            providerEntryByEnvironmentAndInstanceId.get(
              `${thread.environmentId}:${modelInstanceId}`,
            ) ?? null;
          return (
            <ThreadCommandSubtitle
              project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
              projectTitle={projectTitle ?? null}
              environmentLabel={
                projectEnvironmentLocationById.get(thread.environmentId)?.label ?? "Remote"
              }
              branch={thread.branch}
              worktreePath={thread.worktreePath}
              isCurrent={thread.id === activeThreadId}
              driverKind={providerEntry?.driverKind ?? null}
              providerDisplayName={
                thread.runtime?.providerName ?? providerEntry?.displayName ?? modelInstanceId
              }
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
            />
          );
        },
        getContentMatch: (thread) => {
          const match = threadContentMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          );
          return match && (match.source === "user" || match.source === "assistant")
            ? {
                source: match.source,
                snippet: match.snippet,
                query: threadSearch.query,
              }
            : undefined;
        },
        runThread: async (thread) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      }),
    [
      activeThreadId,
      clientSettings.sidebarThreadSortOrder,
      navigate,
      projectCwdById,
      projectByKey,
      projectEnvironmentLocationById,
      projectTitleById,
      providerEntryByEnvironmentAndInstanceId,
      threadContentMatchByKey,
      threadSearch.query,
      threads,
    ],
  );
  const recentThreadItems = allThreadItems.slice(0, RECENT_THREAD_LIMIT);

  const pushPaletteView = useCallback(
    (view: CommandPaletteView): void => {
      browseNavigation.invalidate();
      setViewStack((previousViews) => [
        ...previousViews,
        {
          addonIcon: view.addonIcon,
          groups: view.groups,
          ...(view.initialQuery ? { initialQuery: view.initialQuery } : {}),
        },
      ]);
      highlightClearedRef.current = true;
      setHighlightedItemValue(null);
      setQuery(view.initialQuery ?? "");
    },
    [browseNavigation],
  );

  function pushView(item: CommandPaletteSubmenuItem): void {
    pushPaletteView({
      addonIcon: item.addonIcon,
      groups: item.groups,
      ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
    });
  }

  function popView(): void {
    browseNavigation.invalidate();
    if (newProjectFlow?.folderSelectionName != null) {
      setQuery(newProjectFlow.folderSelectionName);
      setNewProjectFlow({ ...newProjectFlow, folderSelectionName: null });
      setHighlightedItemValue(null);
      return;
    }
    setAddProjectCloneFlow(null);
    setNewProjectFlow(null);
    if (viewStack.length <= 1) {
      setAddProjectEnvironmentId(null);
    } else if (newProjectFlow?.sourcesEnvironmentId) {
      // The machine switcher may have moved off the sources view's machine.
      setAddProjectEnvironmentId(newProjectFlow.sourcesEnvironmentId);
    }
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    browseNavigation.invalidate();
    clearTypedHighlight();
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery && !isChoosingNewProjectFolder) {
      popView();
    }
  }

  const startAddProjectBrowse = useCallback(
    async (environmentId: EnvironmentId): Promise<void> => {
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
    },
    [
      browseNavigation,
      getAddProjectInitialQueryForEnvironment,
      getBrowseCwdForEnvironment,
      prefetchBrowsePath,
      pushPaletteView,
    ],
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
    [pushPaletteView],
  );

  /** Folder that holds an environment's name-only projects, or null when it has none. */
  const newProjectsRootFor = useCallback(
    (environmentId: EnvironmentId | null): string | null =>
      environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
        ?.newProjectsRoot ?? null,
    [environments],
  );

  const startNewProject = useCallback(
    (environmentId: EnvironmentId, sourcesEnvironmentId: EnvironmentId | null): void => {
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow(null);
      setNewProjectFlow({
        environmentId,
        sourcesEnvironmentId,
        parentDirectory: null,
        folderSelectionName: null,
      });
      setNewProjectPublishesToGitHub(false);
      pushPaletteView({
        addonIcon: <FolderGit2Icon className={ADDON_ICON_CLASS} />,
        groups: [],
      });
    },
    [pushPaletteView],
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
    [
      newProjectsRootFor,
      openSourceControlSettings,
      startAddProjectBrowse,
      startAddProjectClone,
      startNewProject,
    ],
  );

  const startAddProjectSourceSelection = useCallback(
    (environmentId: EnvironmentId): void => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
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
    [
      browseEnvironmentId,
      buildAddProjectSourceGroups,
      environments,
      pushPaletteView,
      sourceControlDiscovery.data,
    ],
  );

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
    // With no connected environment there is nothing to browse, so the only
    // useful next step is connecting one.
    if (addProjectEnvironmentOptions.length === 0) {
      setOpen(false);
      void navigate({ to: "/settings/connections" });
      return;
    }

    if (addProjectEnvironmentOptions.length > 1 || defaultAddProjectEnvironmentId === null) {
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: addProjectEnvironmentGroups,
      });
      return;
    }

    void startAddProjectSourceSelection(defaultAddProjectEnvironmentId);
  }, [
    addProjectEnvironmentGroups,
    addProjectEnvironmentOptions.length,
    defaultAddProjectEnvironmentId,
    navigate,
    pushPaletteView,
    setOpen,
    startAddProjectSourceSelection,
  ]);

  // New project starts on this device (options list it first); the name step
  // lists the other machines when there is a choice.
  const openNewProjectFlow = () => {
    const firstOption = newProjectEnvironmentOptions[0];
    if (firstOption) startNewProject(firstOption.environmentId, null);
  };

  useLayoutEffect(() => {
    if (openIntent?.kind !== "search") return;
    browseNavigation.invalidate();
    cloneLookupGeneration.current += 1;
    setIsRemoteProjectLookingUp(false);
    setAddProjectCloneFlow(null);
    setNewProjectFlow(null);
    setViewStack([]);
    setLinkedThreadSearch(openIntent);
    setQuery(openIntent.query);
    clearOpenIntent();
  }, [browseNavigation, clearOpenIntent, openIntent]);

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
    browseNavigation.invalidate();
    setAddProjectCloneFlow(null);
    setNewProjectFlow(null);
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
    browseNavigation,
    currentProjectEnvironmentId,
    currentProjectId,
    openIntent,
    projectThreadItems,
    pushPaletteView,
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

  if (activeThreadReferenceCopyTarget !== null) {
    actionItems.push({
      kind: "action",
      value: "action:copy-thread-reference",
      searchTerms: ["copy", "pull request", "pr link", "thread id", "reference"],
      title:
        activeThreadReferenceCopyTarget.kind === "pull-request" ? "Copy PR link" : "Copy thread ID",
      description: activeThreadReferenceCopyTarget.value,
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
    if (activeThreadServerConfig?.environment.capabilities.threadPullRequests === true) {
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
  }

  if (activeThread !== null) {
    const thread = activeThread;
    actionItems.push({
      kind: "action",
      value: "action:restart-agent-session",
      searchTerms: ["restart", "reset", "reload", "agent", "session", "skills", "plugins", "mcp"],
      title: "Restart agent session",
      icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
      // Stopping the provider process keeps the conversation: the next message
      // spawns a fresh one that resumes it and reloads skills, plugins, and MCP
      // servers. The fresh workspace scan updates the composer's slash menu.
      // Failures throw into executeItem's error toast.
      run: async () => {
        const { environmentId } = thread;
        if (thread.runtime !== null) {
          const stopped = await stopThreadSession({
            environmentId,
            input: { threadId: thread.id },
          });
          if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
        }
        // The server stops the process after accepting the command. A failed
        // stop shows in the thread.
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
      openOverlayMode("files");
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
      openOverlayMode("content");
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
      "forgejo",
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
        await startAddProjectBrowse(wslAddProjectEnvironmentOption.environmentId);
      },
    });
  }

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: "Change theme",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: "Change theme",
        items: themeCards.map(({ id, label, previews }) => ({
          kind: "action",
          value: id === null ? "theme:standard" : `theme:palette:${id}`,
          title: label,
          description: previews.length === 1 ? `For ${previews[0]!.mode} mode` : undefined,
          searchTerms: [label, "theme", "appearance"],
          icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: (
            <span className="flex shrink-0 items-center gap-2">
              {(themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null) === id ? (
                <span className="text-xs text-muted-foreground/70">Current</span>
              ) : null}
              <span className="flex items-center gap-1" aria-hidden>
                {previews.map((preview) => (
                  <ThemePreviewCircle
                    key={preview.mode}
                    colors={preview.colors}
                    mode={preview.mode}
                    className="size-3 border-0"
                  />
                ))}
              </span>
            </span>
          ),
          run: async () => {
            const saved =
              previews.length === 1 && id !== null
                ? setThemeHalf(previews[0]!.mode, id)
                : setTheme(id ?? appearanceMode);
            if (!saved) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };
  actionItems.push(changeThemeItem);

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
    title: "Change appearance",
    icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: "Change appearance",
        items: APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => ({
          kind: "action",
          value: `appearance:${mode}`,
          title: label,
          searchTerms: [label, "appearance", "mode"],
          icon: <Icon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            appearanceMode === mode ? (
              <span className="text-xs text-muted-foreground/70">Current</span>
            ) : undefined,
          run: async () => {
            if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };
  actionItems.push(changeAppearanceItem);

  useLayoutEffect(() => {
    if (openIntent?.kind !== "change-theme") return;
    clearOpenIntent();
    browseNavigation.invalidate();
    cloneLookupGeneration.current += 1;
    setIsRemoteProjectLookingUp(false);
    setAddProjectCloneFlow(null);
    setNewProjectFlow(null);
    setViewStack([]);
    pushPaletteView({
      addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "themes", label: "Change theme", items: [] }],
    });
  }, [browseNavigation, clearOpenIntent, openIntent, pushPaletteView]);

  actionItems.push({
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    title: "Toggle theme editor",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "themeEditor.toggle",
    run: async () => {
      toggleThemeEditorForTheme({
        theme,
        themeHalves,
        initialAppearance: resolvedTheme,
      });
    },
  });

  if (
    environments.some(
      (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
    )
  ) {
    actionItems.push({
      kind: "action",
      value: "action:pull-requests",
      searchTerms: ["pull requests", "prs", "pr", "github", "review", "merge", "branch"],
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

  // Target the active thread or draft's project, falling back to the first sidebar group.
  const contextualProjectGroup =
    (contextualProjectRef
      ? projectGroupByTargetKey.get(
          `${contextualProjectRef.environmentId}:${contextualProjectRef.projectId}`,
        )
      : null) ??
    projectGroups[0] ??
    null;
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
  const settingsSearchItems: CommandPaletteActionItem[] = searchSettings(
    deferredQuery,
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
          buildAddProjectRemoteSourceReadiness(sourceControlDiscovery.data),
        )
      : currentView?.groups[0]?.value === "themes"
        ? changeThemeItem.groups
        : currentView?.groups[0]?.value === "appearance"
          ? changeAppearanceItem.groups
          : (currentView?.groups ?? rootGroups);

  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    projectSearchItems: projectSearchItems,
    settingsSearchItems,
    threadSearchItems:
      linkedThreadSearch?.linkedThreads && deferredQuery === linkedThreadSearch.query
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
  });

  const handleAddProjectForEnvironment = useCallback(
    async (input: {
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

  const newProjectGitHubTarget =
    newProjectFlow === null ? null : getNewProjectGitHubTarget(sourceControlDiscovery.data ?? null);
  const newProjectName = newProjectFlow?.folderSelectionName ?? query.trim();
  const newProjectsRoot = newProjectFlow ? newProjectsRootFor(newProjectFlow.environmentId) : null;
  const supportsNewProjectFolder =
    browseEnvironment?.serverConfig?.newProjectParentDirectory === true &&
    browseEnvironment.serverConfig.environment.platform.os !== "unknown";
  const newProjectParentInput =
    newProjectFlow?.parentDirectory ??
    (supportsNewProjectFolder
      ? browseEnvironment?.serverConfig?.settings.addProjectBaseDirectory.trim() || newProjectsRoot
      : newProjectsRoot);
  const resolvedNewProjectParent =
    newProjectParentInput === null
      ? null
      : resolveNewProjectParentDirectory({
          rawPath: newProjectParentInput,
          currentProjectCwd: currentProjectCwdForBrowse,
          platform: browseEnvironmentPlatform,
        });
  const newProjectParentDirectory = resolvedNewProjectParent?.ok
    ? resolvedNewProjectParent.path
    : null;
  const canSubmitNewProject =
    newProjectFlow !== null &&
    !isChoosingNewProjectFolder &&
    newProjectParentDirectory !== null &&
    newProjectFlow.environmentId === browseEnvironmentId &&
    newProjectName.length > 0 &&
    !isCreatingNewProject &&
    !isSavingProjectFolder &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);

  async function submitNewProject(): Promise<void> {
    if (newProjectFlow === null || !canSubmitNewProject || newProjectSubmittingRef.current) {
      return;
    }
    newProjectSubmittingRef.current = true;
    setIsCreatingNewProject(true);
    try {
      const created = await createNewProject({
        environmentId: newProjectFlow.environmentId,
        name: newProjectName,
        ...(supportsNewProjectFolder && newProjectParentDirectory !== null
          ? { parentDirectory: newProjectParentDirectory }
          : {}),
        github: newProjectPublishesToGitHub ? newProjectGitHubTarget : null,
      });
      if (created) setOpen(false);
    } finally {
      newProjectSubmittingRef.current = false;
      setIsCreatingNewProject(false);
    }
  }

  function getDefaultCloneParentPath(environmentId: EnvironmentId): string {
    return getAddProjectInitialQueryForEnvironment(environmentId);
  }

  /** Clone the explicit destination on its selected server, using tracked clones when supported. */
  async function submitAddProjectCloneFlow(destinationPathInput?: string): Promise<void> {
    if (!addProjectCloneFlow || isSavingProjectFolder) {
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

      const provider = remoteProjectSourceProvider(addProjectCloneFlow.source);
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

    // Older servers only offer the blocking clone: the palette has to wait
    // for git so it can add the project afterwards.
    if (browseEnvironment?.serverConfig?.environment.capabilities.projectCloneTracking !== true) {
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
      return;
    }

    // The server creates the project and clones in the background; progress
    // shows in a toast and in the draft's composer banner, so the palette
    // closes as soon as the clone is under way. Only problems found before
    // git runs (bad destination, unknown repository) come back here.
    const projectId = newProjectId();
    setIsRemoteProjectCloning(true);
    const startResult = await startProjectClone({
      environmentId: addProjectCloneFlow.environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(destinationPath),
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
    const projectRef = scopeProjectRef(addProjectCloneFlow.environmentId, projectId);
    // The create event usually lands before this call returns; give the shell
    // stream a moment so the draft opens with its project resolved instead of
    // flashing the project picker.
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

  const browseTo = useCallback(
    async (name: string): Promise<void> => {
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
    },
    [
      browseNavigation,
      browseEnvironmentPlatform,
      browsePath.directoryPath,
      pinnedCloneDirectoryName,
      prefetchBrowsePath,
      query,
    ],
  );

  const browseUp = useCallback(async (): Promise<void> => {
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
  }, [browseNavigation, browsePath.parentPath, pinnedCloneDirectoryName, prefetchBrowsePath]);

  // Resolve the add-project path from browse data when available. When the
  // query has a trailing separator (e.g. "~/projects/foo/"), parentPath is the
  // directory itself. Otherwise the user typed a partial leaf name, so we need
  // the exact browse entry's fullPath or fall back to the raw query.
  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? query.trim());

  const newProjectFolderSelection = isChoosingNewProjectFolder
    ? resolveNewProjectParentDirectory({
        rawPath: resolvedAddProjectPath,
        currentProjectCwd: currentProjectCwdForBrowse,
        platform: browseEnvironmentPlatform,
      })
    : null;
  const canSelectNewProjectFolder =
    newProjectFolderSelection?.ok === true &&
    supportsNewProjectFolder &&
    newProjectFlow?.environmentId === browseEnvironmentId &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);

  const projectParentPlatformOs = browseEnvironment?.serverConfig?.environment.platform.os;
  // A browser-platform fallback is useful for browsing, but cannot define a server preference.
  const projectParentDirectory =
    newProjectFlow !== null && supportsNewProjectFolder && !isChoosingNewProjectFolder
      ? newProjectParentDirectory
      : addProjectCloneFlow?.step === "confirm" &&
          projectParentPlatformOs !== undefined &&
          projectParentPlatformOs !== "unknown"
        ? resolveCloneParentDirectory({
            rawPath: resolvedAddProjectPath,
            currentProjectCwd: currentProjectCwdForBrowse,
            platform: browseEnvironmentPlatform,
          })
        : null;
  const projectHomeDirectoryQuery = useEnvironmentQuery(
    (addProjectCloneFlow?.step === "confirm" || newProjectFlow !== null) &&
      browseEnvironmentId !== null &&
      canCreateProjectInEnvironment(browseEnvironment?.connection.phase)
      ? filesystemEnvironment.browse({
          environmentId: browseEnvironmentId,
          input: { partialPath: "~/" },
        })
      : null,
  );
  const isDefaultProjectFolder = isDefaultCloneParentDirectory({
    parentDirectory: projectParentDirectory,
    baseDirectory:
      browseEnvironment?.serverConfig?.settings.addProjectBaseDirectory.trim() ||
      (newProjectFlow !== null ? newProjectsRoot : ""),
    homeDirectory: projectHomeDirectoryQuery.data?.parentPath,
    currentProjectCwd: currentProjectCwdForBrowse,
  });

  /** Remember the parent on its server without changing the current project destination. */
  async function saveProjectParentDirectory(): Promise<void> {
    const targetEnvironmentId = newProjectFlow?.environmentId ?? addProjectCloneFlow?.environmentId;
    if (
      (newProjectFlow === null && addProjectCloneFlow?.step !== "confirm") ||
      targetEnvironmentId == null ||
      targetEnvironmentId !== browseEnvironmentId ||
      projectParentDirectory === null ||
      isDefaultProjectFolder ||
      projectHomeDirectoryQuery.isPending ||
      isSavingProjectFolder ||
      isRemoteProjectCloning ||
      isCreatingNewProject ||
      !canCreateProjectInEnvironment(browseEnvironment?.connection.phase)
    ) {
      return;
    }
    setIsSavingProjectFolder(true);
    const result = await updateEnvironmentSettings({
      environmentId: targetEnvironmentId,
      input: { patch: { addProjectBaseDirectory: projectParentDirectory } },
    });
    setIsSavingProjectFolder(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to save default folder",
            description: errorMessage(squashAtomCommandFailure(result)),
          }),
        );
      }
      return;
    }
    toastManager.add({
      type: "success",
      title: "Default project folder saved",
      description: projectParentDirectory,
    });
  }

  /** Start the save while the operation owns pending state and result toasts. */
  function handleSaveProjectParentDirectory(): void {
    void saveProjectParentDirectory();
  }

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

  const newProjectPathPreview =
    newProjectParentDirectory === null
      ? null
      : getNewProjectPathPreview(newProjectParentDirectory, newProjectName);

  /** Browse the selected server while retaining the project name and current destination. */
  function chooseNewProjectFolder(): void {
    if (
      !newProjectFlow ||
      !supportsNewProjectFolder ||
      isCreatingNewProject ||
      isSavingProjectFolder
    )
      return;
    browseNavigation.invalidate();
    setNewProjectFlow({ ...newProjectFlow, folderSelectionName: query.trim() });
    setHighlightedItemValue(null);
    setQuery(ensureBrowseDirectoryPath(newProjectParentInput ?? "~/"));
  }

  /** Accept the parent path without creating a project; Back leaves the old parent intact. */
  function confirmNewProjectFolder(): void {
    if (
      newProjectFlow?.folderSelectionName == null ||
      !canSelectNewProjectFolder ||
      !newProjectFolderSelection?.ok
    )
      return;
    browseNavigation.invalidate();
    setQuery(newProjectFlow.folderSelectionName);
    setNewProjectFlow({
      ...newProjectFlow,
      parentDirectory: newProjectFolderSelection.path,
      folderSelectionName: null,
    });
    setHighlightedItemValue(null);
  }
  const newProjectGitHubToggleValue = "new-project:github";
  // The name step's way out to folders and clones, for the selected machine.
  // It replaces the name step (and a sources view for another machine under
  // it), so Back returns to wherever New project was opened from.
  const showExistingProjectSources = (environmentId: EnvironmentId) => {
    const sourcesEnvironmentId = newProjectFlow?.sourcesEnvironmentId ?? null;
    if (sourcesEnvironmentId === environmentId) {
      popView();
      return;
    }
    if (sourcesEnvironmentId !== null) {
      setViewStack((previousViews) => previousViews.slice(0, -1));
    }
    popView();
    startAddProjectSourceSelection(environmentId);
  };
  // Switching machines keeps the typed name; the GitHub option follows the
  // machine because source control discovery reads addProjectEnvironmentId.
  const switchNewProjectEnvironment = (environmentId: EnvironmentId) => {
    setNewProjectFlow((flow) =>
      flow === null ? flow : { ...flow, environmentId, parentDirectory: null },
    );
    setAddProjectEnvironmentId(environmentId);
  };
  const selectedNewProjectEnvironment =
    newProjectFlow === null
      ? undefined
      : newProjectEnvironmentOptions.find(
          (option) => option.environmentId === newProjectFlow.environmentId,
        );
  // Shown when there is a choice, or when the selected machine went away and
  // another one can take over.
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
            // The create in flight keeps the machine it started on.
            ...(isCreatingNewProject || isSavingProjectFolder ? { disabled: true } : {}),
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
    newProjectGitHubTarget === null || newProjectPathPreview === null
      ? []
      : [
          {
            value: "new-project-options",
            label: "Options",
            items: [
              {
                kind: "action",
                value: newProjectGitHubToggleValue,
                searchTerms: [],
                title: "Create private repository on GitHub",
                description:
                  newProjectName.length > 0
                    ? getNewProjectGitHubRepository(newProjectGitHubTarget, newProjectPathPreview)
                    : (newProjectGitHubTarget.account ?? "Your GitHub account"),
                icon: <GitHubIcon className={ITEM_ICON_CLASS} />,
                titleTrailingContent: (
                  <span className="pointer-events-none ms-auto flex">
                    <Checkbox checked={newProjectPublishesToGitHub} tabIndex={-1} aria-hidden />
                  </span>
                ),
                keepOpen: true,
                run: async () => {
                  setNewProjectPublishesToGitHub((publishes) => !publishes);
                },
              },
            ],
          },
        ];

  let displayedGroups: CommandPaletteView["groups"] = filteredGroups;
  if (isChoosingNewProjectFolder) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  } else if (newProjectFlow !== null) {
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

  const inputPlaceholder = isChoosingNewProjectFolder
    ? "Parent folder"
    : newProjectFlow !== null
      ? "Project name"
      : (remoteProjectInputPlaceholder(addProjectCloneFlow) ??
        getCommandPaletteInputPlaceholder(paletteMode));
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canSubmitBrowsePath =
    isBrowsing &&
    !relativePathNeedsActiveProject &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);
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
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase) &&
    !isRemoteProjectPending;
  const fileManagerName = getLocalFileManagerName(navigator.platform);
  const canOpenProjectFromFileManager =
    isBrowsing &&
    newProjectFlow === null &&
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
      event.preventDefault();
      event.stopPropagation();
      const matchingItem = displayedGroups
        .flatMap((group) => group.items)
        .find((item) => item.shortcutCommand === command);
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

    if (addProjectCloneFlow?.step === "repository" && event.key === "Enter") {
      event.preventDefault();
      void submitAddProjectCloneFlow();
      return;
    }

    // Enter creates the project unless an item below the name is
    // highlighted, in which case it runs that item.
    if (
      newProjectFlow !== null &&
      !isChoosingNewProjectFolder &&
      event.key === "Enter" &&
      highlightedItemValue === null &&
      // Enter that confirms an IME composition is part of typing the name.
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      void submitNewProject();
      return;
    }

    const shouldSubmitBrowsePath =
      (isChoosingNewProjectFolder ? canSelectNewProjectFolder : canSubmitBrowsePath) &&
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

    if (shouldSubmitBrowsePath) {
      event.preventDefault();
      if (isChoosingNewProjectFolder) {
        confirmNewProjectFolder();
      } else if (isCloneDestinationStep) {
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

    // Base UI ignores navigation keys with modifiers, so these fallbacks do too.
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    // Base UI only keeps a hidden highlight on the first row when it auto-highlights.
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

    // Base UI clicks the highlighted row on Enter, which does nothing once the
    // virtualized list has unmounted it, so run the tracked highlight directly.
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

  const inputAccessory = isChoosingNewProjectFolder ? (
    <Button
      variant="outline"
      size="xs"
      className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
      disabled={!canSelectNewProjectFolder}
      onMouseDown={(event) => event.preventDefault()}
      onClick={confirmNewProjectFolder}
    >
      Use folder
    </Button>
  ) : newProjectFlow !== null ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            tabIndex={-1}
            className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
            aria-label="Create (Enter)"
            disabled={!canSubmitNewProject}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              void submitNewProject();
            }}
          />
        }
      >
        <span>{isCreatingNewProject ? "Creating" : "Create"}</span>
        <KbdGroup className="pointer-events-none -me-0.5">
          <Kbd>Enter</Kbd>
        </KbdGroup>
      </TooltipTrigger>
      <TooltipPopup side="top">Create (Enter)</TooltipPopup>
    </Tooltip>
  ) : addProjectCloneFlow?.step === "repository" ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            tabIndex={-1}
            className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
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
        <KbdGroup className="pointer-events-none -me-0.5">
          <Kbd>Enter</Kbd>
        </KbdGroup>
      </TooltipTrigger>
      <TooltipPopup side="top">{remoteProjectButtonLabel ?? "Continue"} (Enter)</TooltipPopup>
    </Tooltip>
  ) : isBrowsing ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            tabIndex={-1}
            className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
            aria-label={`${submitActionLabel} (${addShortcutLabel})`}
            disabled={
              !canCreateProjectInEnvironment(browseEnvironment?.connection.phase) ||
              relativePathNeedsActiveProject ||
              (isCloneDestinationStep && (isRemoteProjectPending || isSavingProjectFolder))
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
        <KbdGroup className="pointer-events-none -me-0.5">
          <Kbd>{hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter"}</Kbd>
        </KbdGroup>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {submitActionLabel} ({addShortcutLabel})
      </TooltipPopup>
    </Tooltip>
  ) : null;

  const footerActionLabel = isChoosingNewProjectFolder
    ? hasHighlightedBrowseItem
      ? "Select"
      : "Use folder"
    : newProjectFlow !== null
      ? highlightedItemValue === null
        ? "Create"
        : highlightedItemValue === newProjectGitHubToggleValue
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
        // The submit button is absolutely positioned over the field, so the
        // inner input must reserve enough room for the full action label.
        className:
          addProjectCloneFlow?.step === "repository" || newProjectFlow !== null
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
      {newProjectFolderSelection && !newProjectFolderSelection.ok ? (
        <div className="px-4 py-2 text-sm text-destructive">{newProjectFolderSelection.error}</div>
      ) : null}
      {newProjectFlow !== null && newProjectParentInput !== null && !isChoosingNewProjectFolder ? (
        <div className="p-2 pb-0">
          <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
            <FolderGit2Icon className={ITEM_ICON_CLASS} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-foreground text-sm">
                {newProjectName.length > 0 ? newProjectName : "New project"}
              </span>
              <span className="truncate text-muted-foreground/85 text-xs">
                {newProjectName.length > 0 && newProjectPathPreview !== null
                  ? `Creates ${newProjectPathPreview}`
                  : `Goes in ${newProjectParentInput}`}
                {newProjectEnvironmentLabel === null ? null : ` on ${newProjectEnvironmentLabel}`}
              </span>
            </span>
            {supportsNewProjectFolder ? (
              <Button
                variant="outline"
                size="xs"
                disabled={isCreatingNewProject || isSavingProjectFolder}
                onClick={chooseNewProjectFolder}
              >
                Change folder
              </Button>
            ) : null}
          </div>
          {resolvedNewProjectParent && !resolvedNewProjectParent.ok ? (
            <div className="px-2 py-1.5 text-sm text-destructive">
              {resolvedNewProjectParent.error}
            </div>
          ) : null}
          {supportsNewProjectFolder ? (
            <div className="flex justify-end px-2 py-1.5">
              <Button
                variant="outline"
                size="xs"
                disabled={
                  isDefaultProjectFolder ||
                  projectHomeDirectoryQuery.isPending ||
                  isSavingProjectFolder ||
                  isCreatingNewProject
                }
                onClick={handleSaveProjectParentDirectory}
              >
                {isSavingProjectFolder
                  ? "Saving…"
                  : isDefaultProjectFolder
                    ? "Default folder"
                    : "Use this folder by default"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {remoteProjectContext ? (
        <div className="p-2 pb-0">
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Repository</div>
          <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
            {remoteProjectContext.icon}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-foreground text-sm">{remoteProjectContext.title}</span>
              <span className="truncate text-muted-foreground/85 text-xs">
                {remoteProjectContext.description}
              </span>
            </span>
          </div>
          {projectParentDirectory !== null ? (
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-muted-foreground text-xs">Parent folder</span>
                <span className="truncate text-sm">{projectParentDirectory}</span>
              </span>
              <Button
                variant="outline"
                size="xs"
                disabled={
                  addProjectCloneFlow?.environmentId !== browseEnvironmentId ||
                  isDefaultProjectFolder ||
                  projectHomeDirectoryQuery.isPending ||
                  isSavingProjectFolder ||
                  isRemoteProjectPending ||
                  !canCreateProjectInEnvironment(browseEnvironment?.connection.phase)
                }
                onClick={handleSaveProjectParentDirectory}
              >
                {isSavingProjectFolder
                  ? "Saving…"
                  : isDefaultProjectFolder
                    ? "Default folder"
                    : "Use this folder by default"}
              </Button>
            </div>
          ) : null}
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
                : threadSearch.isPending
                  ? { emptyStateMessage: "Searching thread messages…" }
                  : {})}
      />
    </CommandPaletteContent>
  );
}

function ProjectSearchDescription(props: {
  readonly environmentLabels: ReadonlyArray<string>;
  readonly grouped: boolean;
  readonly location: {
    readonly kind: "local" | "remote";
    readonly label: string;
    readonly machine: EnvironmentMachineKind;
  };
  readonly workspaceRoot: string;
}) {
  if (!props.grouped) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="inline-flex min-w-0 items-center gap-1">
          {props.location.kind === "remote" ? (
            <EnvironmentMachineIcon
              aria-hidden
              kind={props.location.machine}
              className={COMMAND_PALETTE_META_ICON_CLASS}
            />
          ) : null}
          <span className="truncate">{props.location.label}</span>
        </span>
        <CommandPaletteMetaDot />
        <span className="truncate">{props.workspaceRoot}</span>
      </span>
    );
  }

  return <span className="truncate">{props.environmentLabels.join(" · ")}</span>;
}
