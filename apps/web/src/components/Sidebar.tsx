import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CircleDotIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  PlusIcon,
  RocketIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  ProjectId,
  ThreadId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { APP_STAGE_LABEL } from "../branding";
import { newCommandId, newProjectId, newThreadId } from "../lib/utils";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut } from "../keybindings";
import { type Thread } from "../types";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { getSidebarThreadSortTimestamp, sortSidebarThreadEntries } from "../sidebarThreadOrder";
import { buildSidebarGroupContextMenuItems } from "../sidebarGroupContextMenu";
import {
  orderProjects,
  orderProjectsByIds,
  shouldClearOptimisticProjectOrder,
  reorderProjectOrder,
} from "../projectOrder";
import {
  animateSidebarReorder,
  buildSidebarReorderDeltas,
  collectElementTopPositions,
  hasSidebarReorderChanged,
} from "../sidebarReorderAnimation";
import { preferredTerminalEditor } from "../terminal-links";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import {
  buildProjectChildrenClassName,
  buildProjectGroupCollapseKey,
  buildThreadGroupChildrenClassName,
  buildThreadGroupDragCursorClassName,
  buildSidebarInteractionClassName,
  buildThreadGroupChevronClassName,
  buildThreadGroupComposeButtonClassName,
  buildThreadGroupDropIndicatorClassName,
  buildThreadGroupHeaderClassName,
  buildThreadRowClassName,
  hasCrossedThreadGroupDragThreshold,
  isProjectGroupOpen,
  resolveThreadGroupDropEffect,
  shouldIgnoreSidebarDragPointerDown,
  shouldSnapThreadGroupDropToEnd,
  setProjectGroupCollapsed,
  shouldRenderProjectComposeButton,
} from "./sidebarGroupInteractions";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldHighlightDesktopUpdateError,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarTrigger,
} from "./ui/sidebar";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import {
  MAIN_THREAD_GROUP_ID,
  buildThreadGroupId,
  orderProjectThreadGroups,
  resolveProjectThreadGroupPrById,
  reorderProjectThreadGroupOrder,
} from "../threadGroups";
import { resolveThreadStatusPill } from "./Sidebar.logic";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard?.writeText === undefined) {
    throw new Error("Clipboard API unavailable.");
  }
  await navigator.clipboard.writeText(text);
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];
type SidebarGroupEntry = {
  id: ThreadId;
  title: string;
  createdAt: string;
  branch: string | null;
  worktreePath: string | null;
  thread: Thread | null;
  isDraft: boolean;
};

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-2.5 w-auto shrink-0 text-foreground"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Derives the server's HTTP origin (scheme + host + port) from the same
 * sources WsTransport uses, converting ws(s) to http(s).
 */
function getServerHttpOrigin(): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  // Parse to extract just the origin, dropping path/query (e.g. ?token=…)
  const httpUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  try {
    return new URL(httpUrl).origin;
  } catch {
    return httpUrl;
  }
}

const serverHttpOrigin = getServerHttpOrigin();

function ProjectFavicon({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  const src = `${serverHttpOrigin}/api/project-favicon?cwd=${encodeURIComponent(cwd)}`;

  if (status === "error") {
    return <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/50" />;
  }

  return (
    <img
      src={src}
      alt=""
      className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loading" ? "hidden" : ""}`}
      onLoad={() => setStatus("loaded")}
      onError={() => setStatus("error")}
    />
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearThreadDraft);
  const draftsByThreadId = useComposerDraftStore((store) => store.draftsByThreadId);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const projectGroupDraftThreadIdById = useComposerDraftStore(
    (store) => store.projectGroupDraftThreadIdById,
  );
  const getDraftThreadByProjectGroupId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectGroupId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const setProjectGroupDraftThreadId = useComposerDraftStore(
    (store) => store.setProjectGroupDraftThreadId,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const clearProjectGroupDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectGroupDraftThreadId,
  );
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const navigate = useNavigate();
  const isOnSettings = useLocation({ select: (loc) => loc.pathname === "/settings" });
  const { settings: appSettings } = useAppSettings();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [optimisticProjectOrder, setOptimisticProjectOrder] = useState<ProjectId[] | null>(null);
  const [isProjectReorderPending, setIsProjectReorderPending] = useState(false);
  const [draggedProjectId, setDraggedProjectId] = useState<ProjectId | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{ beforeProjectId: ProjectId | null } | null>(
    null,
  );
  const [draggedGroup, setDraggedGroup] = useState<{ projectId: ProjectId; groupId: string } | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<{ projectId: ProjectId; beforeGroupId: string | null } | null>(
    null,
  );
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const pendingProjectDragRef = useRef<{
    projectId: ProjectId;
    startX: number;
    startY: number;
    pointerId: number;
    element: HTMLElement;
  } | null>(null);
  const projectRowRefs = useRef(new Map<ProjectId, HTMLDivElement>());
  const threadGroupRowRefs = useRef(new Map<string, HTMLDivElement>());
  const previousProjectOrderRef = useRef<Array<ProjectId>>([]);
  const previousProjectTopsRef = useRef<Map<ProjectId, number>>(new Map());
  const pendingProjectAnimationStartTopsRef = useRef<Map<ProjectId, number> | null>(null);
  const pendingPersistedProjectOrderRef = useRef<ProjectId[] | null>(null);
  const projectReorderFlushInFlightRef = useRef(false);
  const previousGroupOrderByProjectRef = useRef(new Map<ProjectId, Array<string>>());
  const previousGroupTopsRef = useRef<Map<string, number>>(new Map());
  const pendingGroupAnimationStartTopsRef = useRef<Map<string, number> | null>(null);
  const activeDraggedProjectRef = useRef<ProjectId | null>(null);
  const pendingGroupDragRef = useRef<{
    projectId: ProjectId;
    groupId: string;
    startX: number;
    startY: number;
    pointerId: number;
    element: HTMLDivElement;
  } | null>(null);
  const activeDraggedGroupRef = useRef<{ projectId: ProjectId; groupId: string } | null>(null);
  const suppressProjectClickRef = useRef<ProjectId | null>(null);
  const suppressGroupClickRef = useRef<string | null>(null);
  const releasePendingGroupPointerCapture = useCallback(() => {
    const pendingDrag = pendingGroupDragRef.current;
    if (!pendingDrag) return;
    if (pendingDrag.element.hasPointerCapture(pendingDrag.pointerId)) {
      pendingDrag.element.releasePointerCapture(pendingDrag.pointerId);
    }
  }, []);
  const setGroupOpen = useCallback((projectId: ProjectId, groupId: string, open: boolean) => {
    setCollapsedGroupIds((prev) =>
      setProjectGroupCollapsed(prev, buildProjectGroupCollapseKey(projectId, groupId), open),
    );
  }, []);
  const pendingApprovalByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingApprovals(thread.activities).length > 0);
    }
    return map;
  }, [threads]);
  const pendingUserInputByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingUserInputs(thread.activities).length > 0);
    }
    return map;
  }, [threads]);
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const orderedProjects = useMemo(
    () => orderProjectsByIds(projects, optimisticProjectOrder),
    [optimisticProjectOrder, projects],
  );
  const orderedGroupIdsByProjectId = useMemo(() => {
    const draftThreadsByProjectId = new Map<ProjectId, Array<{
      id: ThreadId;
      createdAt: string;
      branch: string | null;
      worktreePath: string | null;
    }>>();
    for (const [threadId, draftThread] of Object.entries(draftThreadsByThreadId)) {
      const existingDraftThreads = draftThreadsByProjectId.get(draftThread.projectId) ?? [];
      existingDraftThreads.push({
        id: threadId as ThreadId,
        createdAt: draftThread.createdAt,
        branch: draftThread.branch,
        worktreePath: draftThread.worktreePath,
      });
      draftThreadsByProjectId.set(draftThread.projectId, existingDraftThreads);
    }

    const groupIdsByProjectId = new Map<ProjectId, Array<string>>();
    for (const project of orderedProjects) {
      const threadEntries = threads
        .filter((thread) => thread.projectId === project.id)
        .map((thread) => ({
          id: thread.id,
          createdAt: thread.createdAt,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        }));
      const draftEntries = draftThreadsByProjectId.get(project.id) ?? [];

      groupIdsByProjectId.set(
        project.id,
        orderProjectThreadGroups({
          project,
          threads: [...threadEntries, ...draftEntries],
        }).map((group) => group.id),
      );
    }

    return groupIdsByProjectId;
  }, [draftThreadsByThreadId, orderedProjects, threads]);
  const gitStatusTargets = useMemo(
    () =>
      [
        ...threads.map((thread) => ({
          branch: thread.branch,
          cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
        })),
        ...Object.values(draftThreadsByThreadId).map((draftThread) => ({
          branch: draftThread.branch,
          cwd: draftThread.worktreePath ?? projectCwdById.get(draftThread.projectId) ?? null,
        })),
      ],
    [draftThreadsByThreadId, projectCwdById, threads],
  );
  const gitStatusCwds = useMemo(
    () => [
      ...new Set(
        gitStatusTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [gitStatusTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: gitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const gitStatusByCwd = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < gitStatusCwds.length; index += 1) {
      const cwd = gitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }
    return statusByCwd;
  }, [gitStatusCwds, threadGitStatusQueries]);

  const openPrUrl = useCallback((prUrl: string) => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  useEffect(() => {
    if (
      !shouldClearOptimisticProjectOrder({
        optimisticOrder: optimisticProjectOrder,
        persistedOrder: orderProjects(projects).map((project) => project.id),
        hasPendingReorder: isProjectReorderPending,
      })
    ) {
      return;
    }
    setOptimisticProjectOrder(null);
  }, [isProjectReorderPending, optimisticProjectOrder, projects]);

  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nextProjectOrder = orderedProjects.map((project) => project.id);
    const nextProjectTops = collectElementTopPositions(projectRowRefs.current);
    const projectAnimationStartTops =
      pendingProjectAnimationStartTopsRef.current ?? previousProjectTopsRef.current;

    if (
      !prefersReducedMotion &&
      hasSidebarReorderChanged(previousProjectOrderRef.current, nextProjectOrder)
    ) {
      animateSidebarReorder(
        projectRowRefs.current,
        buildSidebarReorderDeltas(projectAnimationStartTops, nextProjectTops),
      );
    }

    previousProjectOrderRef.current = nextProjectOrder;
    previousProjectTopsRef.current = nextProjectTops;
    pendingProjectAnimationStartTopsRef.current = null;

    const nextGroupTops = collectElementTopPositions(threadGroupRowRefs.current);
    const groupAnimationStartTops =
      pendingGroupAnimationStartTopsRef.current ?? previousGroupTopsRef.current;
    const changedProjectIds = new Set<string>();
    for (const [projectId, nextGroupOrder] of orderedGroupIdsByProjectId.entries()) {
      const previousGroupOrder = previousGroupOrderByProjectRef.current.get(projectId) ?? [];
      if (hasSidebarReorderChanged(previousGroupOrder, nextGroupOrder)) {
        changedProjectIds.add(projectId);
      }
    }

    if (!prefersReducedMotion && changedProjectIds.size > 0) {
      const previousGroupTops = new Map(
        [...groupAnimationStartTops.entries()].filter(([key]) =>
          changedProjectIds.has(key.split("\u0000", 1)[0] ?? ""),
        ),
      );
      const reorderedGroupTops = new Map(
        [...nextGroupTops.entries()].filter(([key]) =>
          changedProjectIds.has(key.split("\u0000", 1)[0] ?? ""),
        ),
      );

      animateSidebarReorder(
        threadGroupRowRefs.current,
        buildSidebarReorderDeltas(previousGroupTops, reorderedGroupTops),
      );
    }

    previousGroupOrderByProjectRef.current = new Map(
      [...orderedGroupIdsByProjectId.entries()].map(([projectId, groupIds]) => [projectId, [...groupIds]]),
    );
    previousGroupTopsRef.current = nextGroupTops;
    pendingGroupAnimationStartTopsRef.current = null;
  }, [orderedGroupIdsByProjectId, orderedProjects]);

  const openPrLink = useCallback(
    (event: React.MouseEvent<HTMLElement>, prUrl: string) => {
      event.preventDefault();
      event.stopPropagation();
      openPrUrl(prUrl);
    },
    [openPrUrl],
  );

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      const groupId = buildThreadGroupId({
        branch: options?.branch ?? null,
        worktreePath: options?.worktreePath ?? null,
      });
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectGroupId(projectId, groupId);
      if (storedDraftThread) {
        return (async () => {
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(storedDraftThread.threadId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setProjectGroupDraftThreadId(projectId, groupId, storedDraftThread.threadId);
          if (routeThreadId === storedDraftThread.threadId) {
            return;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        })();
      }
      clearProjectGroupDraftThreadId(projectId, groupId);

      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
      if (
        activeDraftThread &&
        routeThreadId &&
        activeDraftThread.projectId === projectId &&
        buildThreadGroupId({
          branch: activeDraftThread.branch,
          worktreePath: activeDraftThread.worktreePath,
        }) === groupId
      ) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(routeThreadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectGroupDraftThreadId(projectId, groupId, routeThreadId);
        return Promise.resolve();
      }
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setProjectGroupDraftThreadId(projectId, groupId, threadId, {
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? (groupId === MAIN_THREAD_GROUP_ID ? "local" : "worktree"),
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      })();
    },
    [
      clearProjectGroupDraftThreadId,
      getDraftThreadByProjectGroupId,
      navigate,
      getDraftThread,
      routeThreadId,
      setDraftThreadContext,
      setProjectGroupDraftThreadId,
    ],
  );

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = threads
        .filter((thread) => thread.projectId === projectId)
        .toSorted((a, b) => {
          const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          if (byDate !== 0) return byDate;
          return b.id.localeCompare(a.id);
        })[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [navigate, threads],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt,
        });
        await handleNewThread(projectId).catch(() => undefined);
      } catch (error) {
        setIsAddingProject(false);
        setAddProjectError(
          error instanceof Error ? error.message : "An error occurred while adding the project.",
        );
        return;
      }
      finishAddingProject();
    },
    [focusMostRecentThreadForProject, handleNewThread, isAddingProject, projects],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const handlePickFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;

      if (clicked === "rename") {
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId);
        return;
      }
      if (clicked === "copy-thread-id") {
        try {
          await copyTextToClipboard(threadId);
          toastManager.add({
            type: "success",
            title: "Thread ID copied",
            description: threadId,
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy thread ID",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked !== "delete") return;
      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      const threadProject = projects.find((project) => project.id === thread.projectId);
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(threads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({
          threadId,
          deleteHistory: true,
        });
      } catch {
        // Terminal may already be closed
      }

      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = threads.find((entry) => entry.id !== threadId)?.id ?? null;
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      await api.orchestration
        .getSnapshot()
        .then((snapshot) => {
          syncServerReadModel(snapshot);
        })
        .catch(() => undefined);
      clearComposerDraftForThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(threadId);
      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      appSettings.confirmThreadDelete,
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      markThreadUnread,
      navigate,
      projects,
      removeWorktreeMutation,
      routeThreadId,
      syncServerReadModel,
      threads,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [{ id: "delete", label: "Delete", destructive: true }],
        position,
      );
      if (clicked !== "delete") return;

      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const projectThreads = threads.filter((thread) => thread.projectId === projectId);
      if (projectThreads.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete all threads in this project before deleting it.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(
        [`Delete project "${project.name}"?`, "This action cannot be undone."].join("\n"),
      );
      if (!confirmed) return;

      try {
        const projectPrefix = `${projectId}\u0000`;
        for (const [mappingId, threadId] of Object.entries(projectGroupDraftThreadIdById)) {
          if (!mappingId.startsWith(projectPrefix)) {
            continue;
          }
          clearComposerDraftForThread(threadId as ThreadId);
        }
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
        await api.orchestration
          .getSnapshot()
          .then((snapshot) => {
            syncServerReadModel(snapshot);
          })
          .catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error deleting project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to delete "${project.name}"`,
          description: message,
        });
      }
    },
    [
      clearComposerDraftForThread,
      projectGroupDraftThreadIdById,
      projects,
      syncServerReadModel,
      threads,
    ],
  );

  const handleGroupContextMenu = useCallback(
    async (
      input: {
        projectId: ProjectId;
        projectCwd: string;
        groupId: string;
        groupLabel: string;
        branch: string | null;
        worktreePath: string | null;
        prUrl: string | null;
        entries: SidebarGroupEntry[];
      },
      position: { x: number; y: number },
    ) => {
      const api = readNativeApi();
      if (!api) return;

      const workspacePath = input.worktreePath ?? input.projectCwd;
      const clicked = await api.contextMenu.show(
        buildSidebarGroupContextMenuItems({
          isMainGroup: input.groupId === MAIN_THREAD_GROUP_ID,
          hasBranch: input.branch !== null,
          hasWorktreePath: input.worktreePath !== null,
          hasPr: input.prUrl !== null,
        }),
        position,
      );
      if (!clicked) return;

      if (clicked === "open-workspace") {
        void api.shell.openInEditor(workspacePath, preferredTerminalEditor()).catch((error) => {
          toastManager.add({
            type: "error",
            title: "Failed to open workspace",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        });
        return;
      }

      if (clicked === "copy-workspace-path" || clicked === "copy-project-path") {
        try {
          await copyTextToClipboard(clicked === "copy-workspace-path" ? workspacePath : input.projectCwd);
          toastManager.add({
            type: "success",
            title: "Path copied",
            description: clicked === "copy-workspace-path" ? workspacePath : input.projectCwd,
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }

      if (clicked === "copy-branch-name") {
        if (!input.branch) return;
        try {
          await copyTextToClipboard(input.branch);
          toastManager.add({
            type: "success",
            title: "Branch copied",
            description: input.branch,
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy branch",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }

      if (clicked === "open-pr") {
        if (!input.prUrl) return;
        openPrUrl(input.prUrl);
        return;
      }

      if (clicked === "new-chat") {
        void handleNewThread(input.projectId, {
          branch: input.branch,
          worktreePath: input.worktreePath,
          envMode: input.groupId === MAIN_THREAD_GROUP_ID ? "local" : "worktree",
        });
        return;
      }

      if (clicked !== "delete-group-worktree-and-chats" || !input.worktreePath) {
        return;
      }

      const confirmed = await api.dialogs.confirm(
        [
          `Delete all chats in "${input.groupLabel}" and remove its worktree?`,
          input.worktreePath,
          "",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) return;

      const deletedEntryIds = new Set(input.entries.map((entry) => entry.id));
      const serverEntries = input.entries.filter((entry) => entry.thread !== null);
      const remainingDraftThreadId =
        Object.values(projectGroupDraftThreadIdById).find(
          (threadId) => !deletedEntryIds.has(threadId as ThreadId) && draftThreadsByThreadId[threadId as ThreadId],
        ) ?? null;
      const remainingServerThreadId =
        threads.find((thread) => !deletedEntryIds.has(thread.id))?.id ?? null;

      try {
        for (const entry of serverEntries) {
          const thread = entry.thread;
          if (!thread) continue;
          if (thread.session && thread.session.status !== "closed") {
            await api.orchestration
              .dispatchCommand({
                type: "thread.session.stop",
                commandId: newCommandId(),
                threadId: thread.id,
                createdAt: new Date().toISOString(),
              })
              .catch(() => undefined);
          }

          await api.terminal
            .close({
              threadId: thread.id,
              deleteHistory: true,
            })
            .catch(() => undefined);

          await api.orchestration.dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: thread.id,
          });
          clearComposerDraftForThread(thread.id);
          clearProjectDraftThreadById(input.projectId, thread.id);
          clearTerminalState(thread.id);
        }

        clearProjectGroupDraftThreadId(input.projectId, input.groupId);
        await api.orchestration
          .getSnapshot()
          .then((snapshot) => {
            syncServerReadModel(snapshot);
          })
          .catch(() => undefined);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to delete "${input.groupLabel}"`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return;
      }

      if (routeThreadId && deletedEntryIds.has(routeThreadId)) {
        const fallbackThreadId = remainingServerThreadId ?? remainingDraftThreadId;
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId as ThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: input.projectCwd,
          path: input.worktreePath,
          force: true,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Chats deleted, but worktree removal failed",
          description: `Could not remove ${input.worktreePath}. ${
            error instanceof Error ? error.message : "Unknown error removing worktree."
          }`,
        });
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearProjectGroupDraftThreadId,
      clearTerminalState,
      draftThreadsByThreadId,
      handleNewThread,
      navigate,
      openPrUrl,
      projectGroupDraftThreadIdById,
      removeWorktreeMutation,
      routeThreadId,
      syncServerReadModel,
      threads,
    ],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      const activeThread = routeThreadId
        ? threads.find((thread) => thread.id === routeThreadId)
        : undefined;
      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
      if (isChatNewLocalShortcut(event, keybindings)) {
        const projectId =
          activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id;
        if (!projectId) return;
        event.preventDefault();
        void handleNewThread(projectId);
        return;
      }

      if (!isChatNewShortcut(event, keybindings)) return;
      const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id;
      if (!projectId) return;
      event.preventDefault();
      void handleNewThread(projectId, {
        branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
        envMode: activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
      });
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [getDraftThread, handleNewThread, keybindings, projects, routeThreadId, threads]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!draggedGroup && !draggedProjectId) return;

    const previousBodyCursor = document.body.style.cursor;
    const previousDocumentCursor = document.documentElement.style.cursor;
    document.body.style.cursor = "grabbing";
    document.documentElement.style.cursor = "grabbing";

    return () => {
      document.body.style.cursor = previousBodyCursor;
      document.documentElement.style.cursor = previousDocumentCursor;
    };
  }, [draggedGroup, draggedProjectId]);

  const showDesktopUpdateButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);

  const desktopUpdateTooltip = desktopUpdateState
    ? getDesktopUpdateButtonTooltip(desktopUpdateState)
    : "Update available";

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const desktopUpdateButtonInteractivityClasses = desktopUpdateButtonDisabled
    ? "cursor-not-allowed opacity-60"
    : "hover:bg-accent hover:text-foreground";
  const desktopUpdateButtonClasses =
    desktopUpdateState?.status === "downloaded"
      ? "text-emerald-500"
      : desktopUpdateState?.status === "downloading"
        ? "text-sky-400"
        : shouldHighlightDesktopUpdateError(desktopUpdateState)
          ? "text-rose-500 animate-pulse"
          : "text-amber-500 animate-pulse";
  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const handleProjectGroupReorder = useCallback(
    async (projectId: ProjectId, movedGroupId: string, beforeGroupId: string | null) => {
      const api = readNativeApi();
      const project = projects.find((entry) => entry.id === projectId);
      if (!api || !project || movedGroupId === MAIN_THREAD_GROUP_ID) {
        return;
      }
      const visibleGroupIds = orderProjectThreadGroups({
        project,
        threads: [
          ...threads.filter((thread) => thread.projectId === projectId),
          ...Object.entries(projectGroupDraftThreadIdById)
            .flatMap(([mappingId, threadId]) => {
              const separatorIndex = mappingId.indexOf("\u0000");
              if (separatorIndex <= 0) {
                return [];
              }
              const mappingProjectId = mappingId.slice(0, separatorIndex);
              if (mappingProjectId !== projectId) {
                return [];
              }
              const draftThread = draftThreadsByThreadId[threadId as ThreadId];
              if (!draftThread) {
                return [];
              }
              return [
                {
                  branch: draftThread.branch,
                  worktreePath: draftThread.worktreePath,
                  createdAt: draftThread.createdAt,
                },
              ];
            }),
        ],
      }).map((group) => group.id);
      const nextOrder = reorderProjectThreadGroupOrder({
        currentOrder: visibleGroupIds.filter((groupId) => groupId !== MAIN_THREAD_GROUP_ID),
        movedGroupId,
        beforeGroupId,
      });
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId,
        threadGroupOrder: nextOrder,
      });
      await api.orchestration
        .getSnapshot()
        .then((snapshot) => {
          syncServerReadModel(snapshot);
        })
        .catch(() => undefined);
    },
    [draftThreadsByThreadId, projectGroupDraftThreadIdById, projects, syncServerReadModel, threads],
  );

  const handleProjectReorder = useCallback(
    async (nextOrder: ProjectId[]) => {
      const api = readNativeApi();
      if (!api) {
        setOptimisticProjectOrder(null);
        setIsProjectReorderPending(false);
        pendingPersistedProjectOrderRef.current = null;
        projectReorderFlushInFlightRef.current = false;
        return;
      }

      pendingPersistedProjectOrderRef.current = nextOrder;
      if (projectReorderFlushInFlightRef.current) {
        return;
      }

      projectReorderFlushInFlightRef.current = true;
      setIsProjectReorderPending(true);
      try {
        while (pendingPersistedProjectOrderRef.current) {
          const targetOrder = pendingPersistedProjectOrderRef.current;
          pendingPersistedProjectOrderRef.current = null;

          for (const [sortOrder, projectId] of targetOrder.entries()) {
            const project = projects.find((entry) => entry.id === projectId);
            if (!project || project.sortOrder === sortOrder) {
              continue;
            }
            await api.orchestration.dispatchCommand({
              type: "project.meta.update",
              commandId: newCommandId(),
              projectId,
              sortOrder,
            });
          }

          await api.orchestration
            .getSnapshot()
            .then((snapshot) => {
              syncServerReadModel(snapshot);
            })
            .catch(() => undefined);
        }
      } finally {
        projectReorderFlushInFlightRef.current = false;
        setIsProjectReorderPending(false);
      }
    },
    [projects, syncServerReadModel],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;

    const onPointerMove = (event: PointerEvent) => {
      const pendingDrag = pendingProjectDragRef.current;
      if (!pendingDrag) {
        return;
      }

      if (event.pointerId !== pendingDrag.pointerId) {
        return;
      }

      if (
        !hasCrossedThreadGroupDragThreshold({
          startX: pendingDrag.startX,
          startY: pendingDrag.startY,
          currentX: event.clientX,
          currentY: event.clientY,
          thresholdPx: 4,
        })
      ) {
        return;
      }

      if (activeDraggedProjectRef.current === null) {
        activeDraggedProjectRef.current = pendingDrag.projectId;
        suppressProjectClickRef.current = pendingDrag.projectId;
        setDraggedProjectId(pendingDrag.projectId);
      }

      window.getSelection?.()?.removeAllRanges();

      const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
      const projectSurface = hoveredElement?.closest<HTMLElement>("[data-project-drop-surface]");
      if (projectSurface) {
        const targetProjectId = projectSurface.dataset.projectId as ProjectId | undefined;
        if (!targetProjectId || targetProjectId === pendingDrag.projectId) {
          setProjectDropTarget(null);
          return;
        }
        setProjectDropTarget({ beforeProjectId: targetProjectId });
        return;
      }

      const endSurface = hoveredElement?.closest<HTMLElement>("[data-project-drop-end]");
      if (endSurface) {
        const lastProjectId = endSurface.dataset.lastProjectId as ProjectId | undefined;
        setProjectDropTarget(
          lastProjectId && lastProjectId === pendingDrag.projectId ? null : { beforeProjectId: null },
        );
        return;
      }

      const dropContainer = document.querySelector<HTMLElement>("[data-project-drop-container]");
      if (dropContainer) {
        const containerRect = dropContainer.getBoundingClientRect();
        const containerEndSurface =
          dropContainer.querySelector<HTMLElement>("[data-project-drop-end]");
        const endSurfaceRect = containerEndSurface?.getBoundingClientRect();
        const shouldSnapToEnd = shouldSnapThreadGroupDropToEnd({
          pointerX: event.clientX,
          pointerY: event.clientY,
          left: containerRect.left,
          right: containerRect.right,
          bottom: containerRect.bottom,
          snapStartY: endSurfaceRect?.top ?? containerRect.bottom - 24,
          thresholdPx: 80,
        });
        if (shouldSnapToEnd) {
          const lastProjectId = dropContainer.dataset.lastProjectId as ProjectId | undefined;
          setProjectDropTarget(
            lastProjectId && lastProjectId === pendingDrag.projectId ? null : { beforeProjectId: null },
          );
          return;
        }
      }

      setProjectDropTarget(null);
    };

    const finishProjectPointerDrag = (pointerId: number | null, canceled: boolean) => {
      const pendingDrag = pendingProjectDragRef.current;
      if (pendingDrag && pointerId !== null && pendingDrag.pointerId !== pointerId) {
        return;
      }

      if (pendingDrag?.element.hasPointerCapture(pendingDrag.pointerId)) {
        pendingDrag.element.releasePointerCapture(pendingDrag.pointerId);
      }

      const draggedProjectId = activeDraggedProjectRef.current;
      pendingProjectDragRef.current = null;
      activeDraggedProjectRef.current = null;

      if (!draggedProjectId) {
        return;
      }

      const nextDropTarget = projectDropTarget;
      setDraggedProjectId(null);
      setProjectDropTarget(null);

      if (canceled || !nextDropTarget) {
        return;
      }

      const nextProjectOrder = reorderProjectOrder({
        currentOrder: orderedProjects.map((project) => project.id),
        movedProjectId: draggedProjectId,
        beforeProjectId: nextDropTarget.beforeProjectId,
      });
      setOptimisticProjectOrder(nextProjectOrder);
      pendingProjectAnimationStartTopsRef.current = collectElementTopPositions(projectRowRefs.current);
      void handleProjectReorder(nextProjectOrder);
    };

    const onPointerUp = (event: PointerEvent) => {
      finishProjectPointerDrag(event.pointerId, false);
    };

    const onPointerCancel = (event: PointerEvent) => {
      finishProjectPointerDrag(event.pointerId, true);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      const pendingDrag = pendingProjectDragRef.current;
      if (pendingDrag?.element.hasPointerCapture(pendingDrag.pointerId)) {
        pendingDrag.element.releasePointerCapture(pendingDrag.pointerId);
      }
    };
  }, [handleProjectReorder, orderedProjects, projectDropTarget]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const onPointerMove = (event: PointerEvent) => {
      const pendingDrag = pendingGroupDragRef.current;
      if (!pendingDrag) {
        return;
      }

      if (event.pointerId !== pendingDrag.pointerId) {
        return;
      }

      if (
        !hasCrossedThreadGroupDragThreshold({
          startX: pendingDrag.startX,
          startY: pendingDrag.startY,
          currentX: event.clientX,
          currentY: event.clientY,
          thresholdPx: 4,
        })
      ) {
        return;
      }

      if (activeDraggedGroupRef.current === null) {
        activeDraggedGroupRef.current = {
          projectId: pendingDrag.projectId,
          groupId: pendingDrag.groupId,
        };
        suppressGroupClickRef.current = buildProjectGroupCollapseKey(
          pendingDrag.projectId,
          pendingDrag.groupId,
        );
        setDraggedGroup(activeDraggedGroupRef.current);
      }

      window.getSelection?.()?.removeAllRanges();

      const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
      const groupSurface = hoveredElement?.closest<HTMLElement>("[data-thread-group-drop-surface]");
      if (groupSurface) {
        const targetProjectId = groupSurface.dataset.projectId;
        const targetGroupId = groupSurface.dataset.groupId;
        if (!targetProjectId || !targetGroupId) {
          setDropTarget(null);
          return;
        }
        const dropEffect = resolveThreadGroupDropEffect({
          draggedProjectId: pendingDrag.projectId,
          targetProjectId,
          draggedGroupId: pendingDrag.groupId,
          targetGroupId,
          lastGroupId: groupSurface.dataset.lastGroupId || null,
        });
        setDropTarget(
          dropEffect === "move"
            ? { projectId: targetProjectId as ProjectId, beforeGroupId: targetGroupId }
            : null,
        );
        return;
      }

      const endSurface = hoveredElement?.closest<HTMLElement>("[data-thread-group-drop-end]");
      if (endSurface) {
        const targetProjectId = endSurface.dataset.projectId;
        if (!targetProjectId) {
          setDropTarget(null);
          return;
        }
        const dropEffect = resolveThreadGroupDropEffect({
          draggedProjectId: pendingDrag.projectId,
          targetProjectId,
          draggedGroupId: pendingDrag.groupId,
          targetGroupId: null,
          lastGroupId: endSurface.dataset.lastGroupId || null,
        });
        setDropTarget(
          dropEffect === "move"
            ? { projectId: targetProjectId as ProjectId, beforeGroupId: null }
            : null,
        );
        return;
      }

      const dropContainer = document.querySelector<HTMLElement>(
        `[data-thread-group-drop-container][data-project-id="${pendingDrag.projectId}"]`,
      );
      if (dropContainer) {
        const containerRect = dropContainer.getBoundingClientRect();
        const endSurface = dropContainer.querySelector<HTMLElement>("[data-thread-group-drop-end]");
        const endSurfaceRect = endSurface?.getBoundingClientRect();
        const shouldSnapToEnd = shouldSnapThreadGroupDropToEnd({
          pointerX: event.clientX,
          pointerY: event.clientY,
          left: containerRect.left,
          right: containerRect.right,
          bottom: containerRect.bottom,
          snapStartY: endSurfaceRect?.top ?? containerRect.bottom - 24,
          thresholdPx: 80,
        });
        if (shouldSnapToEnd) {
          const dropEffect = resolveThreadGroupDropEffect({
            draggedProjectId: pendingDrag.projectId,
            targetProjectId: pendingDrag.projectId,
            draggedGroupId: pendingDrag.groupId,
            targetGroupId: null,
            lastGroupId: dropContainer.dataset.lastGroupId || null,
          });
          setDropTarget(
            dropEffect === "move"
              ? { projectId: pendingDrag.projectId, beforeGroupId: null }
              : null,
          );
          return;
        }
      }

      setDropTarget(null);
    };

    const finishGroupPointerDrag = (pointerId: number | null, canceled: boolean) => {
      const pendingDrag = pendingGroupDragRef.current;
      if (pendingDrag && pointerId !== null && pendingDrag.pointerId !== pointerId) {
        return;
      }

      releasePendingGroupPointerCapture();

      const dragged = activeDraggedGroupRef.current;
      pendingGroupDragRef.current = null;
      activeDraggedGroupRef.current = null;

      if (!dragged) {
        return;
      }

      const nextDropTarget = dropTarget;
      setDraggedGroup(null);
      setDropTarget(null);

      if (canceled) {
        return;
      }

      if (!nextDropTarget || nextDropTarget.projectId !== dragged.projectId) {
        return;
      }

      pendingGroupAnimationStartTopsRef.current = collectElementTopPositions(threadGroupRowRefs.current);
      void handleProjectGroupReorder(dragged.projectId, dragged.groupId, nextDropTarget.beforeGroupId);
    };

    const onPointerUp = (event: PointerEvent) => {
      finishGroupPointerDrag(event.pointerId, false);
    };

    const onPointerCancel = (event: PointerEvent) => {
      finishGroupPointerDrag(event.pointerId, true);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      releasePendingGroupPointerCapture();
    };
  }, [dropTarget, handleProjectGroupReorder, releasePendingGroupPointerCapture]);

  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <div className="flex min-w-0 flex-1 items-center gap-1 mt-1.5 ml-1">
        <T3Wordmark />
        <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
          Code
        </span>
        <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
          {APP_STAGE_LABEL}
        </span>
      </div>
    </div>
  );

  return (
    <>
      {isElectron ? (
        <>
          <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
            {wordmark}
            {showDesktopUpdateButton && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={desktopUpdateTooltip}
                      aria-disabled={desktopUpdateButtonDisabled || undefined}
                      disabled={desktopUpdateButtonDisabled}
                      className={`inline-flex size-7 ml-auto mt-1.5 items-center justify-center rounded-md text-muted-foreground transition-colors ${desktopUpdateButtonInteractivityClasses} ${desktopUpdateButtonClasses}`}
                      onClick={handleDesktopUpdateButtonClick}
                    >
                      <RocketIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="bottom">{desktopUpdateTooltip}</TooltipPopup>
              </Tooltip>
            )}
          </SidebarHeader>
        </>
      ) : (
        <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
          {wordmark}
        </SidebarHeader>
      )}

      <SidebarContent
        className={`gap-0 ${buildSidebarInteractionClassName({
          isAnyGroupDragged: draggedGroup !== null || draggedProjectId !== null,
        })}`}
      >
        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Download ARM build"
                      : "Install ARM build"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="px-2 py-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Projects
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Add project"
                    className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      setAddingProject((prev) => !prev);
                      setAddProjectError(null);
                    }}
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">Add project</TooltipPopup>
            </Tooltip>
          </div>

          {addingProject && (
            <div className="mb-2 px-1">
              {isElectron && (
                <button
                  type="button"
                  className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void handlePickFolder()}
                  disabled={isPickingFolder || isAddingProject}
                >
                  <FolderIcon className="size-3.5" />
                  {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                </button>
              )}
              <div className="flex gap-1.5">
                <input
                  ref={addProjectInputRef}
                  className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                    addProjectError
                      ? "border-red-500/70 focus:border-red-500"
                      : "border-border focus:border-ring"
                  }`}
                  placeholder="/path/to/project"
                  value={newCwd}
                  onChange={(event) => {
                    setNewCwd(event.target.value);
                    setAddProjectError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleAddProject();
                    if (event.key === "Escape") {
                      setAddingProject(false);
                      setAddProjectError(null);
                    }
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                  onClick={handleAddProject}
                  disabled={isAddingProject}
                >
                  {isAddingProject ? "Adding..." : "Add"}
                </button>
              </div>
              {addProjectError && (
                <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                  {addProjectError}
                </p>
              )}
              <div className="mt-1.5 px-0.5">
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                  onClick={() => {
                    setAddingProject(false);
                    setAddProjectError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <SidebarMenu
            className="relative"
            data-project-drop-container="true"
            data-last-project-id={orderedProjects.at(-1)?.id ?? ""}
          >
            {orderedProjects.map((project) => {
              const projectThreads = threads
                .filter((thread) => thread.projectId === project.id)
                .toSorted((a, b) => {
                  const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                  if (byDate !== 0) return byDate;
                  return b.id.localeCompare(a.id);
                });
              const draftThreadIdsForProject = Object.entries(projectGroupDraftThreadIdById)
                .filter(([mappingId]) => mappingId.startsWith(`${project.id}\u0000`))
                .map(([, threadId]) => threadId as ThreadId);
              const draftEntries = draftThreadIdsForProject.flatMap((threadId) => {
                if (projectThreads.some((thread) => thread.id === threadId)) {
                  return [];
                }
                const draftThread = draftThreadsByThreadId[threadId];
                if (!draftThread || draftThread.projectId !== project.id) {
                  return [];
                }
                return [
                  {
                    id: threadId,
                    title:
                      draftsByThreadId[threadId]?.prompt.trim().split("\n")[0]?.slice(0, 60) ||
                      "New thread",
                    createdAt: draftThread.createdAt,
                    branch: draftThread.branch,
                    worktreePath: draftThread.worktreePath,
                    thread: null,
                    isDraft: true,
                  },
                ];
              });
              const projectEntries: SidebarGroupEntry[] = [
                ...projectThreads.map((thread) => ({
                  id: thread.id,
                  title: thread.title,
                  createdAt: thread.createdAt,
                  branch: thread.branch,
                  worktreePath: thread.worktreePath,
                  thread,
                  isDraft: false,
                })),
                ...draftEntries,
              ];
              const orderedGroups = orderProjectThreadGroups({
                project,
                threads: projectEntries,
              });
              const groupPrById = resolveProjectThreadGroupPrById({
                groups: orderedGroups,
                projectCwd: project.cwd,
                statusByCwd: gitStatusByCwd,
              });
              const isAnySidebarDragged = draggedGroup !== null || draggedProjectId !== null;
              const isDraggedProject = draggedProjectId === project.id;
              const isProjectDropTarget = projectDropTarget?.beforeProjectId === project.id;

              return (
                <div
                  key={project.id}
                  ref={(element) => {
                    if (element) {
                      projectRowRefs.current.set(project.id, element);
                    } else {
                      projectRowRefs.current.delete(project.id);
                    }
                  }}
                  className="group/project relative mb-1 rounded-lg"
                  data-project-drop-surface="true"
                  data-project-id={project.id}
                >
                  <div
                    className={`pointer-events-none absolute inset-x-2 -top-1 h-0.5 rounded-full transition-opacity ${
                      isProjectDropTarget ? "bg-primary opacity-100" : "bg-transparent opacity-0"
                    }`}
                  />
                  <SidebarMenuItem>
                    <div className="group/project-header relative">
                      <SidebarMenuButton
                        size="sm"
                        className={`gap-2 px-2 py-1.5 text-left ${
                          isDraggedProject ? "bg-accent/50" : ""
                        } ${
                          !isDraggedProject && !isAnySidebarDragged
                            ? "hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
                            : ""
                        } ${
                          isAnySidebarDragged ? "cursor-grabbing select-none" : "cursor-pointer select-none"
                        }`}
                        onClick={() => {
                          if (suppressProjectClickRef.current === project.id) {
                            suppressProjectClickRef.current = null;
                            return;
                          }
                          if (isAnySidebarDragged) return;
                          toggleProject(project.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          if (isAnySidebarDragged) return;
                          toggleProject(project.id);
                        }}
                        onPointerDown={(event) => {
                          if (draggedGroup !== null || event.button !== 0) return;
                          if (
                            shouldIgnoreSidebarDragPointerDown({
                              currentTarget: event.currentTarget,
                              target: event.target,
                            })
                          ) {
                            return;
                          }
                          event.currentTarget.setPointerCapture(event.pointerId);
                          pendingProjectDragRef.current = {
                            projectId: project.id,
                            startX: event.clientX,
                            startY: event.clientY,
                            pointerId: event.pointerId,
                            element: event.currentTarget,
                          };
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          void handleProjectContextMenu(project.id, {
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                      >
                        <ChevronRightIcon
                          className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                            project.expanded ? "rotate-90" : ""
                          }`}
                        />
                        <ProjectFavicon cwd={project.cwd} />
                        <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                          {project.name}
                        </span>
                      </SidebarMenuButton>
                      {shouldRenderProjectComposeButton() ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <SidebarMenuAction
                                render={
                                  <button
                                    type="button"
                                    aria-label={`Create new thread in ${project.name}`}
                                  />
                                }
                                showOnHover
                                className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void handleNewThread(project.id);
                                }}
                              >
                                <SquarePenIcon className="size-3.5" />
                              </SidebarMenuAction>
                            }
                          />
                          <TooltipPopup side="top">New thread</TooltipPopup>
                        </Tooltip>
                      ) : null}
                    </div>

                    <div
                      className={buildProjectChildrenClassName({
                        isOpen: project.expanded,
                        isAnyProjectDragged: draggedProjectId !== null,
                      })}
                      aria-hidden={!project.expanded}
                    >
                      <div className="min-h-0 overflow-hidden">
                      <SidebarMenuSub
                        className={`relative mx-1 my-0 w-full translate-x-0 gap-0 px-1.5 py-0 ${
                          draggedProjectId !== null ? "pointer-events-none" : ""
                        }`}
                        data-thread-group-drop-container="true"
                        data-project-id={project.id}
                        data-last-group-id={orderedGroups.at(-1)?.id ?? ""}
                      >
                        {orderedGroups.map((group) => {
                          const groupEntries = sortSidebarThreadEntries(
                            projectEntries.filter(
                              (entry) =>
                                buildThreadGroupId({
                                  branch: entry.branch,
                                  worktreePath: entry.worktreePath,
                                }) === group.id,
                            ),
                            appSettings.sidebarThreadOrder,
                          );
                          const canDragGroup = group.id !== MAIN_THREAD_GROUP_ID;
                          const isAnyGroupDragged = isAnySidebarDragged;
                          const isDraggedGroup =
                            draggedGroup?.projectId === project.id && draggedGroup.groupId === group.id;
                          const lastGroupId = orderedGroups.at(-1)?.id ?? null;
                          const isGroupOpen = isProjectGroupOpen(
                            collapsedGroupIds,
                            project.id,
                            group.id,
                          );
                          const groupPrStatus = prStatusIndicator(groupPrById.get(group.id) ?? null);
                          const isValidDropTarget =
                            dropTarget?.projectId === project.id && dropTarget.beforeGroupId === group.id;
                          const groupInteractionKey = buildProjectGroupCollapseKey(project.id, group.id);

                          return (
                              <div
                                key={buildProjectGroupCollapseKey(project.id, group.id)}
                                ref={(element) => {
                                  if (element) {
                                    threadGroupRowRefs.current.set(
                                      buildProjectGroupCollapseKey(project.id, group.id),
                                      element,
                                    );
                                  } else {
                                    threadGroupRowRefs.current.delete(
                                      buildProjectGroupCollapseKey(project.id, group.id),
                                    );
                                  }
                                }}
                                className="group/thread-group relative mb-1 rounded-lg"
                                data-thread-group-drop-surface="true"
                                data-project-id={project.id}
                                data-group-id={group.id}
                                data-last-group-id={lastGroupId ?? ""}
                              >
                                <div
                                  className={buildThreadGroupDropIndicatorClassName({
                                    isActiveDropTarget: isValidDropTarget,
                                  })}
                                />
                                <div
                                  role="button"
                                  tabIndex={0}
                                  aria-expanded={isGroupOpen}
                                  className={buildThreadGroupHeaderClassName({
                                    canDragGroup,
                                    isDraggedGroup,
                                    isAnyGroupDragged,
                                  }) + ` ${buildThreadGroupDragCursorClassName({ isDragging: isAnyGroupDragged })}`}
                                  onClick={() => {
                                    if (suppressGroupClickRef.current === groupInteractionKey) {
                                      suppressGroupClickRef.current = null;
                                      return;
                                    }
                                    if (isAnySidebarDragged) return;
                                    setGroupOpen(project.id, group.id, !isGroupOpen);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter" && event.key !== " ") return;
                                    event.preventDefault();
                                    if (isAnySidebarDragged) return;
                                    setGroupOpen(project.id, group.id, !isGroupOpen);
                                  }}
                                  onPointerDown={(event) => {
                                    if (!canDragGroup || event.button !== 0 || draggedProjectId !== null) return;
                                    if (
                                      shouldIgnoreSidebarDragPointerDown({
                                        currentTarget: event.currentTarget,
                                        target: event.target,
                                      })
                                    ) {
                                      return;
                                    }
                                    event.currentTarget.setPointerCapture(event.pointerId);
                                    pendingGroupDragRef.current = {
                                      projectId: project.id,
                                      groupId: group.id,
                                      startX: event.clientX,
                                      startY: event.clientY,
                                      pointerId: event.pointerId,
                                      element: event.currentTarget,
                                    };
                                  }}
                                  onContextMenu={(event) => {
                                    event.preventDefault();
                                    void handleGroupContextMenu(
                                      {
                                        projectId: project.id,
                                        projectCwd: project.cwd,
                                        groupId: group.id,
                                        groupLabel: group.label,
                                        branch: group.branch,
                                        worktreePath: group.worktreePath,
                                        prUrl: groupPrStatus?.url ?? null,
                                        entries: groupEntries,
                                      },
                                      {
                                        x: event.clientX,
                                        y: event.clientY,
                                      },
                                    );
                                  }}
                                >
                                  <ChevronRightIcon
                                    className={buildThreadGroupChevronClassName({
                                      isOpen: isGroupOpen,
                                    })}
                                  />
                                  {groupPrStatus ? (
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <button
                                            type="button"
                                            aria-label={groupPrStatus.tooltip}
                                            className={`inline-flex size-3 shrink-0 items-center justify-center ${groupPrStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                                            onClick={(event) => {
                                              openPrLink(event, groupPrStatus.url);
                                            }}
                                          >
                                            <GitPullRequestIcon className="size-3" />
                                          </button>
                                        }
                                      />
                                      <TooltipPopup side="top">{groupPrStatus.tooltip}</TooltipPopup>
                                    </Tooltip>
                                  ) : group.id === MAIN_THREAD_GROUP_ID ? (
                                    <CircleDotIcon className="size-3 shrink-0 text-muted-foreground/50" />
                                  ) : (
                                    <GitBranchIcon className="size-3 shrink-0 text-muted-foreground/50" />
                                  )}
                                  <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                                    {group.label}
                                  </span>
                                  <span className="text-[10px] tabular-nums text-muted-foreground/40">
                                    {groupEntries.length}
                                  </span>
                                </div>
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <button
                                        type="button"
                                        aria-label={`Create new thread in ${group.label}`}
                                        className={`absolute top-0.5 right-1 ${buildThreadGroupComposeButtonClassName(
                                          {
                                            isAnyGroupDragged,
                                          },
                                        )}`}
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          setProjectExpanded(project.id, true);
                                          setCollapsedGroupIds((prev) => {
                                            const collapseKey = buildProjectGroupCollapseKey(
                                              project.id,
                                              group.id,
                                            );
                                            const uncollapsed = new Set(prev);
                                            uncollapsed.delete(collapseKey);
                                            return uncollapsed;
                                          });
                                          void handleNewThread(project.id, {
                                            branch: group.branch,
                                            worktreePath: group.worktreePath,
                                            envMode:
                                              group.id === MAIN_THREAD_GROUP_ID ? "local" : "worktree",
                                          });
                                        }}
                                      />
                                    }
                                  >
                                    <SquarePenIcon className="size-3.5" />
                                  </TooltipTrigger>
                                  <TooltipPopup side="top">Compose in {group.label}</TooltipPopup>
                                </Tooltip>

                                <div
                                  className={buildThreadGroupChildrenClassName({
                                    isOpen: isGroupOpen,
                                    isAnyGroupDragged,
                                  })}
                                  aria-hidden={!isGroupOpen}
                                >
                                  <div className="min-h-0 overflow-hidden">
                                    <div className="ml-[15px] border-l border-sidebar-border/50">
                                    {groupEntries.map((entry) => {
                                const thread = entry.thread;
                                const isActive = routeThreadId === entry.id;
                                const threadStatus =
                                  thread !== null
                                    ? resolveThreadStatusPill({
                                        thread,
                                        hasPendingApprovals:
                                          pendingApprovalByThreadId.get(thread.id) === true,
                                        hasPendingUserInput:
                                          pendingUserInputByThreadId.get(thread.id) === true,
                                      })
                                    : null;
                                const terminalStatus =
                                  thread !== null
                                    ? terminalStatusFromRunningIds(
                                        selectThreadTerminalState(terminalStateByThreadId, thread.id)
                                          .runningTerminalIds,
                                      )
                                    : null;

                                return (
                                    <SidebarMenuSubItem key={entry.id} className="w-full">
                                      <SidebarMenuSubButton
                                        render={<div role="button" tabIndex={0} />}
                                        size="sm"
                                        isActive={isActive}
                                        className={buildThreadRowClassName({
                                          isActive,
                                          isAnyGroupDragged,
                                        })}
                                      onClick={() => {
                                        void navigate({
                                          to: "/$threadId",
                                          params: { threadId: entry.id },
                                        });
                                      }}
                                      onKeyDown={(event) => {
                                        if (event.key !== "Enter" && event.key !== " ") return;
                                        event.preventDefault();
                                        void navigate({
                                          to: "/$threadId",
                                          params: { threadId: entry.id },
                                        });
                                      }}
                                      onContextMenu={(event) => {
                                        if (thread === null) return;
                                        event.preventDefault();
                                        void handleThreadContextMenu(thread.id, {
                                          x: event.clientX,
                                          y: event.clientY,
                                        });
                                      }}
                                    >
                                      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                        {threadStatus && (
                                          <span
                                            className={`inline-flex items-center gap-1 text-[10px] ${threadStatus.colorClass}`}
                                          >
                                            <span
                                              className={`h-1.5 w-1.5 rounded-full ${threadStatus.dotClass} ${
                                                threadStatus.pulse ? "animate-pulse" : ""
                                              }`}
                                            />
                                            <span className="hidden md:inline">{threadStatus.label}</span>
                                          </span>
                                        )}
                                        {thread !== null && renamingThreadId === thread.id ? (
                                          <input
                                            ref={(el) => {
                                              if (el && renamingInputRef.current !== el) {
                                                renamingInputRef.current = el;
                                                el.focus();
                                                el.select();
                                              }
                                            }}
                                            className="min-w-0 flex-1 truncate text-xs bg-transparent outline-none border border-ring rounded px-0.5"
                                            value={renamingTitle}
                                            onChange={(e) => setRenamingTitle(e.target.value)}
                                            onKeyDown={(e) => {
                                              e.stopPropagation();
                                              if (e.key === "Enter") {
                                                e.preventDefault();
                                                renamingCommittedRef.current = true;
                                                void commitRename(thread.id, renamingTitle, thread.title);
                                              } else if (e.key === "Escape") {
                                                e.preventDefault();
                                                renamingCommittedRef.current = true;
                                                cancelRename();
                                              }
                                            }}
                                            onBlur={() => {
                                              if (!renamingCommittedRef.current) {
                                                void commitRename(thread.id, renamingTitle, thread.title);
                                              }
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                          />
                                        ) : (
                                          <span
                                            className={`min-w-0 flex-1 truncate text-xs ${
                                              entry.isDraft ? "italic text-muted-foreground/80" : ""
                                            }`}
                                          >
                                            {entry.title}
                                          </span>
                                        )}
                                      </div>
                                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                        {terminalStatus && (
                                          <span
                                            role="img"
                                            aria-label={terminalStatus.label}
                                            title={terminalStatus.label}
                                            className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
                                          >
                                            <TerminalIcon
                                              className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`}
                                            />
                                          </span>
                                        )}
                                        <span
                                          className={`text-[10px] ${
                                            isActive ? "text-foreground/65" : "text-muted-foreground/40"
                                          }`}
                                        >
                                          {formatRelativeTime(
                                            getSidebarThreadSortTimestamp(
                                              {
                                                id: entry.id,
                                                createdAt: entry.createdAt,
                                                thread: entry.thread,
                                              },
                                              appSettings.sidebarThreadOrder,
                                            ),
                                          )}
                                        </span>
                                      </div>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                );
                              })}
                                    </div>
                                  </div>
                                </div>
                              </div>
                          );
                        })}
                        {draggedGroup?.projectId === project.id ? (
                          <div
                            aria-hidden="true"
                            data-thread-group-drop-end="true"
                            data-project-id={project.id}
                            data-last-group-id={orderedGroups.at(-1)?.id ?? ""}
                            className="absolute inset-x-0 bottom-0 h-4"
                          >
                            <span
                              className={`pointer-events-none absolute inset-x-5 bottom-0 block h-0.5 rounded-full ${
                                dropTarget?.projectId === project.id &&
                                dropTarget.beforeGroupId === null
                                  ? "bg-primary"
                                  : "bg-transparent"
                              }`}
                            />
                          </div>
                        ) : null}
                      </SidebarMenuSub>
                      </div>
                    </div>
                  </SidebarMenuItem>
                </div>
              );
            })}
            {draggedProjectId !== null ? (
              <div
                aria-hidden="true"
                data-project-drop-end="true"
                data-last-project-id={orderedProjects.at(-1)?.id ?? ""}
                className="absolute inset-x-0 bottom-0 h-4"
              >
                <span
                  className={`pointer-events-none absolute inset-x-5 bottom-0 block h-0.5 rounded-full ${
                    projectDropTarget?.beforeProjectId === null ? "bg-primary" : "bg-transparent"
                  }`}
                />
              </div>
            ) : null}
          </SidebarMenu>

          {projects.length === 0 && !addingProject && (
            <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
              No projects yet
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            {isOnSettings ? (
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() => window.history.back()}
              >
                <ArrowLeftIcon className="size-3.5" />
                <span className="text-xs">Back</span>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() => void navigate({ to: "/settings" })}
              >
                <SettingsIcon className="size-3.5" />
                <span className="text-xs">Settings</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
