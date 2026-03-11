import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  GitPullRequestIcon,
  PlusIcon,
  RocketIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  ProjectId,
  ThreadId,
  WorktreeId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@repo/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { isMacPlatform, newCommandId, newProjectId, newWorktreeId } from "../lib/utils";
import { getNewThreadShortcutHint, isNewThreadShortcut } from "../newThreadShortcut";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut } from "../keybindings";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import {
  gitCreateWorktreeMutationOptions,
  gitRemoveWorktreeMutationOptions,
  gitStatusQueryOptions,
} from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { formatRelativeTime } from "../lib/relativeTime";
import { ensureWorktreeDraftThread } from "../lib/worktreeDraftThread";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
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
import { Collapsible, CollapsibleContent } from "./ui/collapsible";
import { KbdTooltip } from "./ui/kbd-tooltip";
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
import { useThreadSelectionStore } from "../threadSelectionStore";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import { resolveThreadStatusPill, shouldClearThreadSelectionOnMouseDown } from "./Sidebar.logic";
import {
  createManagedWorktreeSeed,
  findRootWorktree,
  getRootWorktreeId,
  worktreeDisplaySubtitle,
  worktreeDisplayTitle,
} from "~/lib/worktrees";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 6;

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard?.writeText === undefined) {
    throw new Error("Clipboard API unavailable.");
  }
  await navigator.clipboard.writeText(text);
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

type SortableProjectHandleProps = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;

function SortableProjectItem({
  projectId,
  children,
}: {
  projectId: ProjectId;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: projectId });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners })}
    </li>
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const worktrees = useStore((store) => store.worktrees);
  const threads = useStore((store) => store.threads);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const reorderProjects = useStore((store) => store.reorderProjects);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearThreadDraft);
  const getDraftThreadByWorktreeId = useComposerDraftStore(
    (store) => store.getDraftThreadByWorktreeId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const worktreeDraftThreadIdByWorktreeId = useComposerDraftStore(
    (store) => store.worktreeDraftThreadIdByWorktreeId,
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const setWorktreeDraftThreadId = useComposerDraftStore((store) => store.setWorktreeDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const clearWorktreeDraftThreadId = useComposerDraftStore(
    (store) => store.clearWorktreeDraftThreadId,
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
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [collapsedWorktreeIds, setCollapsedWorktreeIds] = useState<ReadonlySet<WorktreeId>>(
    () => new Set(worktrees.map((worktree) => worktree.id)),
  );
  const knownWorktreeIdsRef = useRef<ReadonlySet<WorktreeId>>(
    new Set(worktrees.map((worktree) => worktree.id)),
  );
  const [expandedThreadListsByWorktree, setExpandedThreadListsByWorktree] = useState<
    ReadonlySet<WorktreeId>
  >(() => new Set());
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const shouldBrowseForProjectImmediately = isElectron;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
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
  const threadGitTargets = useMemo(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, threads],
  );
  const worktreeGitTargets = useMemo(
    () =>
      worktrees.map((worktree) => ({
        worktreeId: worktree.id,
        branch: worktree.branch,
        cwd: worktree.isRoot
          ? (projectCwdById.get(worktree.projectId) ?? null)
          : worktree.workspacePath,
      })),
    [projectCwdById, worktrees],
  );
  const gitStatusCwds = useMemo(
    () => [
      ...new Set(
        [...threadGitTargets, ...worktreeGitTargets]
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets, worktreeGitTargets],
  );
  const gitStatusQueries = useQueries({
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
      const status = gitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }
    return statusByCwd;
  }, [gitStatusCwds, gitStatusQueries]);

  const prByThreadId = useMemo(() => {
    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? gitStatusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [gitStatusByCwd, threadGitTargets]);
  const worktreeDisplayBranchById = useMemo(() => {
    const map = new Map<WorktreeId, string | null>();
    for (const target of worktreeGitTargets) {
      const status = target.cwd ? gitStatusByCwd.get(target.cwd) : undefined;
      map.set(target.worktreeId, status?.branch ?? target.branch);
    }
    return map;
  }, [gitStatusByCwd, worktreeGitTargets]);
  const expandWorktree = useCallback((worktreeId: WorktreeId) => {
    setCollapsedWorktreeIds((previous) => {
      if (!previous.has(worktreeId)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(worktreeId);
      return next;
    });
  }, []);

  const toggleWorktreeCollapsed = useCallback((worktreeId: WorktreeId) => {
    setCollapsedWorktreeIds((previous) => {
      const next = new Set(previous);
      if (next.has(worktreeId)) {
        next.delete(worktreeId);
      } else {
        next.add(worktreeId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setCollapsedWorktreeIds((previous) => {
      const knownWorktreeIds = knownWorktreeIdsRef.current;
      const currentWorktreeIds = new Set(worktrees.map((worktree) => worktree.id));
      const next = new Set(previous);
      let changed = false;

      for (const worktree of worktrees) {
        if (knownWorktreeIds.has(worktree.id)) continue;
        changed = true;
        next.add(worktree.id);
      }

      for (const worktreeId of previous) {
        if (currentWorktreeIds.has(worktreeId)) continue;
        changed = true;
        next.delete(worktreeId);
      }

      knownWorktreeIdsRef.current = currentWorktreeIds;

      if (!changed) return previous;

      return next;
    });
  }, [worktrees]);

  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

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

  const handleNewThread = useCallback(
    async (input: {
      projectId: ProjectId;
      worktreeId: WorktreeId;
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
    }): Promise<void> => {
      setProjectExpanded(input.projectId, true);
      expandWorktree(input.worktreeId);
      const nextThreadId = ensureWorktreeDraftThread({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        routeThreadId,
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.envMode,
        getDraftThreadByWorktreeId,
        getDraftThread,
        setDraftThreadContext,
        setWorktreeDraftThreadId,
      });
      if (routeThreadId !== nextThreadId) {
        await navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      }
    },
    [
      getDraftThread,
      getDraftThreadByWorktreeId,
      navigate,
      routeThreadId,
      setDraftThreadContext,
      setProjectExpanded,
      setWorktreeDraftThreadId,
      expandWorktree,
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

  const focusMostRecentThreadForWorktree = useCallback(
    async (input: {
      projectId: ProjectId;
      worktreeId: WorktreeId;
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
    }) => {
      const latestServerThread = threads
        .filter((thread) => thread.worktreeId === input.worktreeId)
        .toSorted((a, b) => {
          const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          if (byDate !== 0) return byDate;
          return b.id.localeCompare(a.id);
        })[0];
      const latestDraftThread = getDraftThreadByWorktreeId(input.worktreeId);

      const latestThreadId =
        latestServerThread &&
        latestDraftThread &&
        new Date(latestDraftThread.createdAt).getTime() >
          new Date(latestServerThread.createdAt).getTime()
          ? latestDraftThread.threadId
          : latestDraftThread &&
              (!latestServerThread ||
                new Date(latestDraftThread.createdAt).getTime() ===
                  new Date(latestServerThread.createdAt).getTime())
            ? latestDraftThread.threadId
            : latestServerThread?.id;

      if (!latestThreadId) {
        await handleNewThread(input);
        return;
      }

      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(latestThreadId);

      if (routeThreadId === latestThreadId) {
        return;
      }

      await navigate({
        to: "/$threadId",
        params: { threadId: latestThreadId },
      });
    },
    [
      clearSelection,
      getDraftThreadByWorktreeId,
      handleNewThread,
      navigate,
      routeThreadId,
      selectedThreadIds.size,
      setSelectionAnchor,
      threads,
    ],
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
        await handleNewThread({
          projectId,
          worktreeId: getRootWorktreeId(projectId),
          branch: null,
          worktreePath: null,
          envMode: "local",
        }).catch(() => undefined);
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      shouldBrowseForProjectImmediately,
    ],
  );

  const handleCreateWorktree = useCallback(
    async (projectId: ProjectId) => {
      const api = readNativeApi();
      if (!api) {
        return;
      }
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) {
        return;
      }

      const baseStatus = await queryClient.fetchQuery(gitStatusQueryOptions(project.cwd));
      const baseBranch = baseStatus.branch;
      if (!baseBranch) {
        toastManager.add({
          type: "error",
          title: "Cannot create worktree from detached HEAD",
          description: "Check out a branch in the main repo first.",
        });
        return;
      }

      const projectWorktrees = worktrees.filter((worktree) => worktree.projectId === projectId);
      const { slug, branch: newBranch } = createManagedWorktreeSeed({
        existingWorktrees: projectWorktrees,
        branchPrefix: appSettings.gitBranchPrefix,
      });

      try {
        const result = await createWorktreeMutation.mutateAsync({
          cwd: project.cwd,
          branch: baseBranch,
          newBranch,
          managedPathName: slug,
        });
        const worktreeId = newWorktreeId();
        await api.orchestration.dispatchCommand({
          type: "worktree.create",
          commandId: newCommandId(),
          worktreeId,
          projectId,
          workspacePath: result.worktree.path,
          branch: result.worktree.branch,
          isRoot: false,
          branchRenamePending: true,
          createdAt: new Date().toISOString(),
        });
        await handleNewThread({
          projectId,
          worktreeId,
          branch: result.worktree.branch,
          worktreePath: result.worktree.path,
          envMode: "worktree",
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to create worktree",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [
      appSettings.gitBranchPrefix,
      createWorktreeMutation,
      handleNewThread,
      projects,
      queryClient,
      worktrees,
    ],
  );

  const handleDeleteWorktree = useCallback(
    async (worktreeId: WorktreeId) => {
      const api = readNativeApi();
      if (!api) {
        return;
      }
      const worktree = worktrees.find((entry) => entry.id === worktreeId);
      if (!worktree || worktree.isRoot) {
        return;
      }
      const project = projects.find((entry) => entry.id === worktree.projectId);
      if (!project) {
        return;
      }
      const worktreeThreads = threads.filter((thread) => thread.worktreeId === worktreeId);
      const draftThread = getDraftThreadByWorktreeId(worktreeId);
      if (worktreeThreads.length > 0 || draftThread) {
        toastManager.add({
          type: "warning",
          title: "Worktree is not empty",
          description: "Delete or move its threads before deleting the worktree.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(
        [
          `Delete worktree "${worktreeDisplayTitle(worktree)}"?`,
          worktree.workspacePath,
          "",
          "This removes the git worktree checkout.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: project.cwd,
          path: worktree.workspacePath,
          force: true,
        });
        await api.orchestration.dispatchCommand({
          type: "worktree.delete",
          commandId: newCommandId(),
          worktreeId,
        });
        clearWorktreeDraftThreadId(worktreeId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to delete worktree",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [
      clearWorktreeDraftThreadId,
      getDraftThreadByWorktreeId,
      projects,
      removeWorktreeMutation,
      threads,
      worktrees,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

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
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
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

  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      opts: { deletedThreadIds?: ReadonlySet<ThreadId> } = {},
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;

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
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed
      }

      const deletedIds = opts.deletedThreadIds;
      const allDeletedIds = deletedIds ?? new Set<ThreadId>();
      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId =
        threads.find((entry) => entry.id !== threadId && !allDeletedIds.has(entry.id))?.id ?? null;
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      clearComposerDraftForThread(threadId);
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
    },
    [clearComposerDraftForThread, clearTerminalState, navigate, routeThreadId, threads],
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
      await deleteThread(threadId);
    },
    [appSettings.confirmThreadDelete, deleteThread, markThreadUnread, threads],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          markThreadUnread(id);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
    ],
  );

  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearSelection,
      navigate,
      rangeSelectTo,
      selectedThreadIds.size,
      setSelectionAnchor,
      toggleThreadSelection,
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
      const projectWorktrees = worktrees.filter((worktree) => worktree.projectId === projectId);
      const secondaryWorktrees = projectWorktrees.filter((worktree) => !worktree.isRoot);
      if (projectThreads.length > 0 || secondaryWorktrees.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete all threads and secondary worktrees in this project first.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(
        [`Delete project "${project.name}"?`, "This action cannot be undone."].join("\n"),
      );
      if (!confirmed) return;

      try {
        const rootWorktreeId = getRootWorktreeId(projectId);
        const rootDraftThread = getDraftThreadByWorktreeId(rootWorktreeId);
        if (rootDraftThread) {
          clearComposerDraftForThread(rootDraftThread.threadId);
        }
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
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
    [clearComposerDraftForThread, getDraftThreadByWorktreeId, projects, threads, worktrees],
  );

  const handleWorktreeContextMenu = useCallback(
    async (worktreeId: WorktreeId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const worktree = worktrees.find((entry) => entry.id === worktreeId);
      if (!worktree || worktree.isRoot) {
        return;
      }
      const clicked = await api.contextMenu.show(
        [{ id: "delete", label: "Delete worktree", destructive: true }],
        position,
      );
      if (clicked !== "delete") {
        return;
      }
      await handleDeleteWorktree(worktreeId);
    },
    [handleDeleteWorktree, worktrees],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = projects.find((project) => project.id === active.id);
      const overProject = projects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [projects, reorderProjects],
  );

  const handleProjectDragStart = useCallback((_event: DragStartEvent) => {
    dragInProgressRef.current = true;
    suppressProjectClickAfterDragRef.current = true;
  }, []);

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const handleProjectTitlePointerDownCapture = useCallback(() => {
    suppressProjectClickAfterDragRef.current = false;
  }, []);

  const handleProjectTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedThreadIds.size > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const activeThread = routeThreadId
        ? threads.find((thread) => thread.id === routeThreadId)
        : undefined;
      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
      const activeProjectId =
        activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id ?? null;
      const activeWorktreeId =
        activeThread?.worktreeId ??
        activeDraftThread?.worktreeId ??
        (activeProjectId ? findRootWorktree(activeProjectId, worktrees)?.id : null) ??
        (activeProjectId ? getRootWorktreeId(activeProjectId) : null);
      const activeWorktree = activeWorktreeId
        ? worktrees.find((worktree) => worktree.id === activeWorktreeId)
        : undefined;
      const nextBranch =
        activeThread?.branch ?? activeDraftThread?.branch ?? activeWorktree?.branch ?? null;
      const nextWorktreePath =
        activeWorktree?.isRoot === true
          ? null
          : (activeThread?.worktreePath ??
            activeDraftThread?.worktreePath ??
            activeWorktree?.workspacePath ??
            null);
      const nextEnvMode: DraftThreadEnvMode =
        activeDraftThread?.envMode ??
        (activeWorktree?.isRoot === true || nextWorktreePath === null ? "local" : "worktree");
      if (isNewThreadShortcut(event)) {
        if (!activeProjectId || !activeWorktreeId) return;
        event.preventDefault();
        void handleNewThread({
          projectId: activeProjectId,
          worktreeId: activeWorktreeId,
          branch: nextBranch,
          worktreePath: nextWorktreePath,
          envMode: nextEnvMode,
        });
        return;
      }
      if (isChatNewLocalShortcut(event, keybindings)) {
        if (!activeProjectId || !activeWorktreeId) return;
        event.preventDefault();
        void handleNewThread({
          projectId: activeProjectId,
          worktreeId: activeWorktreeId,
          branch: nextBranch,
          worktreePath: nextWorktreePath,
          envMode: nextEnvMode,
        });
        return;
      }

      if (!isChatNewShortcut(event, keybindings)) return;
      if (!activeProjectId || !activeWorktreeId) return;
      event.preventDefault();
      void handleNewThread({
        projectId: activeProjectId,
        worktreeId: activeWorktreeId,
        branch: nextBranch,
        worktreePath: nextWorktreePath,
        envMode: nextEnvMode,
      });
    };

    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [
    clearSelection,
    getDraftThread,
    handleNewThread,
    keybindings,
    projects,
    routeThreadId,
    selectedThreadIds.size,
    threads,
    worktrees,
  ]);

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
  const newThreadShortcut = useMemo<ReadonlyArray<string> | undefined>(
    () => getNewThreadShortcutHint(),
    [],
  );

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

  const expandThreadListForWorktree = useCallback((worktreeId: WorktreeId) => {
    setExpandedThreadListsByWorktree((current) => {
      if (current.has(worktreeId)) return current;
      const next = new Set(current);
      next.add(worktreeId);
      return next;
    });
  }, []);

  const collapseThreadListForWorktree = useCallback((worktreeId: WorktreeId) => {
    setExpandedThreadListsByWorktree((current) => {
      if (!current.has(worktreeId)) return current;
      const next = new Set(current);
      next.delete(worktreeId);
      return next;
    });
  }, []);

  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex min-w-0 flex-1 items-center gap-1 mt-1.5 ml-1 cursor-pointer">
              <T3Wordmark />
              <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
                Code
              </span>
              <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                {APP_STAGE_LABEL}
              </span>
            </div>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
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

      <SidebarContent className="gap-0">
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
          <div className="relative mb-1 flex min-h-7 items-center px-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Projects
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Add project"
                    aria-pressed={shouldShowProjectPathEntry}
                    className="absolute top-1/2 right-1 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                    onClick={handleStartAddProject}
                  />
                }
              >
                <PlusIcon
                  className={`size-3.5 transition-transform duration-150 ${
                    shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                  }`}
                />
              </TooltipTrigger>
              <TooltipPopup side="right">Add project</TooltipPopup>
            </Tooltip>
          </div>

          {shouldShowProjectPathEntry && (
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
                  disabled={!canAddProject}
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

          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SidebarMenu className="gap-2">
              <SortableContext
                items={projects.map((project) => project.id)}
                strategy={verticalListSortingStrategy}
              >
                {projects.map((project) => {
                  const projectThreads = threads
                    .filter((thread) => thread.projectId === project.id)
                    .toSorted((a, b) => {
                      const byDate =
                        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                      if (byDate !== 0) return byDate;
                      return b.id.localeCompare(a.id);
                    });
                  const orderedProjectThreadIds = projectThreads.map((t) => t.id);
                  const projectWorktrees = worktrees.filter(
                    (worktree) => worktree.projectId === project.id,
                  );

                  return (
                    <SortableProjectItem key={project.id} projectId={project.id}>
                      {(dragHandleProps) => (
                        <Collapsible className="group/collapsible" open={project.expanded}>
                          <div className="group/project-header relative">
                            <SidebarMenuButton
                              size="sm"
                              className="gap-2 px-2 py-1.5 text-left cursor-grab active:cursor-grabbing hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
                              {...dragHandleProps.attributes}
                              {...dragHandleProps.listeners}
                              onPointerDownCapture={handleProjectTitlePointerDownCapture}
                              onClick={(event) => handleProjectTitleClick(event, project.id)}
                              onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                void handleProjectContextMenu(project.id, {
                                  x: event.clientX,
                                  y: event.clientY,
                                });
                              }}
                            >
                              <span className="relative -ml-0.5 size-3.5 shrink-0 text-muted-foreground/70">
                                <FolderIcon className="size-3.5 transition-opacity duration-150 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0" />
                                <ChevronRightIcon
                                  className={`absolute inset-0 size-3.5 opacity-0 transition-all duration-150 group-hover/project-header:opacity-100 group-focus-within/project-header:opacity-100 ${
                                    project.expanded ? "rotate-90" : ""
                                  }`}
                                />
                              </span>
                              <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                                {project.name}
                              </span>
                            </SidebarMenuButton>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <SidebarMenuAction
                                    render={
                                      <button
                                        type="button"
                                        aria-label={`Create new worktree in ${project.name}`}
                                        data-testid="new-worktree-button"
                                      />
                                    }
                                    showOnHover
                                    className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void handleCreateWorktree(project.id);
                                    }}
                                  >
                                    <PlusIcon className="size-3.5" />
                                  </SidebarMenuAction>
                                }
                              />
                              <TooltipPopup side="top">New worktree</TooltipPopup>
                            </Tooltip>
                          </div>

                          <CollapsibleContent keepMounted>
                            <SidebarMenuSub className="my-0 mr-0 ml-0 w-full translate-x-0 gap-0.5 border-l-0 pr-0 pl-1.5 py-0">
                              {projectWorktrees.map((worktree) => {
                                const persistedWorktreeThreads = projectThreads.filter(
                                  (thread) => thread.worktreeId === worktree.id,
                                );
                                const draftThreadId =
                                  worktreeDraftThreadIdByWorktreeId[worktree.id];
                                const draftThread =
                                  draftThreadId !== undefined
                                    ? draftThreadsByThreadId[draftThreadId]
                                    : undefined;
                                const worktreeThreadEntries = [
                                  ...persistedWorktreeThreads.map((thread) => ({
                                    kind: "server" as const,
                                    sortKey: thread.createdAt,
                                    thread,
                                  })),
                                  ...(draftThread &&
                                  !persistedWorktreeThreads.some(
                                    (thread) => thread.id === draftThreadId,
                                  )
                                    ? [
                                        {
                                          kind: "draft" as const,
                                          sortKey: draftThread.createdAt,
                                          threadId: draftThreadId as ThreadId,
                                          draftThread,
                                        },
                                      ]
                                    : []),
                                ].toSorted((left, right) => {
                                  const byDate =
                                    new Date(right.sortKey).getTime() -
                                    new Date(left.sortKey).getTime();
                                  if (byDate !== 0) return byDate;
                                  const leftId =
                                    left.kind === "server" ? left.thread.id : left.threadId;
                                  const rightId =
                                    right.kind === "server" ? right.thread.id : right.threadId;
                                  return rightId.localeCompare(leftId);
                                });
                                const isThreadListExpanded = expandedThreadListsByWorktree.has(
                                  worktree.id,
                                );
                                const hasHiddenThreads =
                                  worktreeThreadEntries.length > THREAD_PREVIEW_LIMIT;
                                const visibleThreadEntries =
                                  hasHiddenThreads && !isThreadListExpanded
                                    ? worktreeThreadEntries.slice(0, THREAD_PREVIEW_LIMIT)
                                    : worktreeThreadEntries;
                                const isWorktreeCollapsed = collapsedWorktreeIds.has(worktree.id);
                                const isWorktreeActive =
                                  routeThreadId !== null &&
                                  worktreeThreadEntries.some((entry) =>
                                    entry.kind === "server"
                                      ? entry.thread.id === routeThreadId
                                      : entry.threadId === routeThreadId,
                                  );
                                const worktreeTitle = worktreeDisplayTitle(
                                  worktree,
                                  worktreeDisplayBranchById.get(worktree.id),
                                );
                                const worktreeSubtitle = worktreeDisplaySubtitle(worktree, project);
                                const worktreePath = worktree.isRoot
                                  ? null
                                  : worktree.workspacePath;
                                const worktreeEnvMode: DraftThreadEnvMode = worktree.isRoot
                                  ? "local"
                                  : "worktree";

                                return (
                                  <SidebarMenuSubItem key={worktree.id} className="w-full">
                                    <Collapsible className="w-full" open={!isWorktreeCollapsed}>
                                      <div className="group/worktree relative">
                                        <SidebarMenuSubButton
                                          render={<button type="button" />}
                                          size="sm"
                                          isActive={isWorktreeActive}
                                          className={`h-7 w-full translate-x-0 cursor-pointer justify-start pr-8 pl-2 text-left hover:bg-accent hover:text-foreground ${
                                            isWorktreeActive
                                              ? "bg-accent/70 text-foreground"
                                              : "text-muted-foreground"
                                          }`}
                                          onClick={() => {
                                            void focusMostRecentThreadForWorktree({
                                              projectId: project.id,
                                              worktreeId: worktree.id,
                                              branch: worktree.branch,
                                              worktreePath,
                                              envMode: worktreeEnvMode,
                                            });
                                          }}
                                          onContextMenu={(event) => {
                                            if (worktree.isRoot) {
                                              return;
                                            }
                                            event.preventDefault();
                                            void handleWorktreeContextMenu(worktree.id, {
                                              x: event.clientX,
                                              y: event.clientY,
                                            });
                                          }}
                                        >
                                          <button
                                            type="button"
                                            aria-label={`${
                                              isWorktreeCollapsed ? "Expand" : "Collapse"
                                            } threads in ${worktreeTitle}`}
                                            className="relative -ml-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                                            onClick={(event) => {
                                              event.preventDefault();
                                              event.stopPropagation();
                                              toggleWorktreeCollapsed(worktree.id);
                                            }}
                                          >
                                            <ChevronRightIcon
                                              className={`size-3.5 transition-transform duration-150 ${
                                                isWorktreeCollapsed ? "" : "rotate-90"
                                              }`}
                                            />
                                          </button>
                                          <div className="min-w-0 flex-1">
                                            <div
                                              className={`truncate text-[11px] font-medium ${
                                                isWorktreeActive
                                                  ? "text-foreground/90"
                                                  : "text-muted-foreground"
                                              }`}
                                            >
                                              {worktreeTitle}
                                            </div>
                                            {worktreeSubtitle ? (
                                              <div className="truncate text-[10px] text-muted-foreground/60">
                                                {worktreeSubtitle}
                                              </div>
                                            ) : null}
                                          </div>
                                        </SidebarMenuSubButton>
                                        <KbdTooltip label="New thread" shortcut={newThreadShortcut}>
                                          <SidebarMenuAction
                                            render={
                                              <button
                                                type="button"
                                                aria-label={`Create new thread in ${worktreeTitle}`}
                                              />
                                            }
                                            showOnHover
                                            className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                                            onClick={(event) => {
                                              event.preventDefault();
                                              event.stopPropagation();
                                              void handleNewThread({
                                                projectId: project.id,
                                                worktreeId: worktree.id,
                                                branch: worktree.branch,
                                                worktreePath,
                                                envMode: worktreeEnvMode,
                                              });
                                            }}
                                          >
                                            <SquarePenIcon className="size-3.5" />
                                          </SidebarMenuAction>
                                        </KbdTooltip>
                                      </div>

                                      <CollapsibleContent keepMounted>
                                        <SidebarMenuSub className="my-0 mr-0 ml-[13px] w-[calc(100%-13px)] translate-x-0 gap-0.5 pr-0 pl-1.5 py-0">
                                          {visibleThreadEntries.map((entry) => {
                                            if (entry.kind === "draft") {
                                              const isActive = routeThreadId === entry.threadId;
                                              return (
                                                <SidebarMenuSubItem
                                                  key={entry.threadId}
                                                  className="w-full"
                                                >
                                                  <SidebarMenuSubButton
                                                    render={<button type="button" />}
                                                    size="sm"
                                                    isActive={isActive}
                                                    className={`h-7 w-full translate-x-0 justify-start px-2 text-left hover:bg-accent hover:text-foreground ${
                                                      isActive
                                                        ? "bg-accent/85 text-foreground font-medium"
                                                        : "text-muted-foreground"
                                                    }`}
                                                    onClick={() => {
                                                      if (selectedThreadIds.size > 0) {
                                                        clearSelection();
                                                      }
                                                      void navigate({
                                                        to: "/$threadId",
                                                        params: { threadId: entry.threadId },
                                                      });
                                                    }}
                                                  >
                                                    <div className="flex min-w-0 flex-1 items-center">
                                                      <span className="min-w-0 flex-1 truncate text-[10px] italic">
                                                        New thread
                                                      </span>
                                                    </div>
                                                    <span className="text-[10px] text-muted-foreground/50">
                                                      {formatRelativeTime(
                                                        entry.draftThread.createdAt,
                                                      )}
                                                    </span>
                                                  </SidebarMenuSubButton>
                                                </SidebarMenuSubItem>
                                              );
                                            }

                                            const thread = entry.thread;
                                            const isActive = routeThreadId === thread.id;
                                            const isSelected = selectedThreadIds.has(thread.id);
                                            const isHighlighted = isActive || isSelected;
                                            const threadStatus = resolveThreadStatusPill({
                                              thread,
                                              hasPendingApprovals:
                                                pendingApprovalByThreadId.get(thread.id) === true,
                                              hasPendingUserInput:
                                                pendingUserInputByThreadId.get(thread.id) === true,
                                            });
                                            const prStatus = prStatusIndicator(
                                              prByThreadId.get(thread.id) ?? null,
                                            );
                                            const terminalStatus = terminalStatusFromRunningIds(
                                              selectThreadTerminalState(
                                                terminalStateByThreadId,
                                                thread.id,
                                              ).runningTerminalIds,
                                            );

                                            return (
                                              <SidebarMenuSubItem
                                                key={thread.id}
                                                className="w-full"
                                                data-thread-item
                                              >
                                                <SidebarMenuSubButton
                                                  render={<div role="button" tabIndex={0} />}
                                                  size="sm"
                                                  isActive={isActive}
                                                  className={`h-7 w-full translate-x-0 cursor-default justify-start px-2 text-left select-none hover:bg-accent hover:text-foreground focus-visible:ring-0 ${
                                                    isSelected
                                                      ? "bg-primary/15 text-foreground dark:bg-primary/10"
                                                      : isActive
                                                        ? "bg-accent/85 text-foreground font-medium dark:bg-accent/55"
                                                        : "text-muted-foreground"
                                                  }`}
                                                  onClick={(event) => {
                                                    handleThreadClick(
                                                      event,
                                                      thread.id,
                                                      orderedProjectThreadIds,
                                                    );
                                                  }}
                                                  onKeyDown={(event) => {
                                                    if (
                                                      event.key !== "Enter" &&
                                                      event.key !== " "
                                                    ) {
                                                      return;
                                                    }
                                                    event.preventDefault();
                                                    if (selectedThreadIds.size > 0) {
                                                      clearSelection();
                                                    }
                                                    setSelectionAnchor(thread.id);
                                                    void navigate({
                                                      to: "/$threadId",
                                                      params: { threadId: thread.id },
                                                    });
                                                  }}
                                                  onContextMenu={(event) => {
                                                    event.preventDefault();
                                                    if (
                                                      selectedThreadIds.size > 0 &&
                                                      selectedThreadIds.has(thread.id)
                                                    ) {
                                                      void handleMultiSelectContextMenu({
                                                        x: event.clientX,
                                                        y: event.clientY,
                                                      });
                                                    } else {
                                                      if (selectedThreadIds.size > 0) {
                                                        clearSelection();
                                                      }
                                                      void handleThreadContextMenu(thread.id, {
                                                        x: event.clientX,
                                                        y: event.clientY,
                                                      });
                                                    }
                                                  }}
                                                >
                                                  <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                                    {prStatus && (
                                                      <Tooltip>
                                                        <TooltipTrigger
                                                          render={
                                                            <button
                                                              type="button"
                                                              aria-label={prStatus.tooltip}
                                                              className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                                                              onClick={(event) => {
                                                                openPrLink(event, prStatus.url);
                                                              }}
                                                            >
                                                              <GitPullRequestIcon className="size-3" />
                                                            </button>
                                                          }
                                                        />
                                                        <TooltipPopup side="top">
                                                          {prStatus.tooltip}
                                                        </TooltipPopup>
                                                      </Tooltip>
                                                    )}
                                                    {threadStatus && (
                                                      <span
                                                        className={`inline-flex items-center gap-1 text-[10px] ${threadStatus.colorClass}`}
                                                      >
                                                        <span
                                                          className={`h-1.5 w-1.5 rounded-full ${threadStatus.dotClass} ${
                                                            threadStatus.pulse
                                                              ? "animate-pulse"
                                                              : ""
                                                          }`}
                                                        />
                                                        <span className="hidden md:inline">
                                                          {threadStatus.label}
                                                        </span>
                                                      </span>
                                                    )}
                                                    {renamingThreadId === thread.id ? (
                                                      <input
                                                        ref={(el) => {
                                                          if (
                                                            el &&
                                                            renamingInputRef.current !== el
                                                          ) {
                                                            renamingInputRef.current = el;
                                                            el.focus();
                                                            el.select();
                                                          }
                                                        }}
                                                        className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-xs outline-none"
                                                        value={renamingTitle}
                                                        onChange={(e) =>
                                                          setRenamingTitle(e.target.value)
                                                        }
                                                        onKeyDown={(e) => {
                                                          e.stopPropagation();
                                                          if (e.key === "Enter") {
                                                            e.preventDefault();
                                                            renamingCommittedRef.current = true;
                                                            void commitRename(
                                                              thread.id,
                                                              renamingTitle,
                                                              thread.title,
                                                            );
                                                          } else if (e.key === "Escape") {
                                                            e.preventDefault();
                                                            renamingCommittedRef.current = true;
                                                            cancelRename();
                                                          }
                                                        }}
                                                        onBlur={() => {
                                                          if (!renamingCommittedRef.current) {
                                                            void commitRename(
                                                              thread.id,
                                                              renamingTitle,
                                                              thread.title,
                                                            );
                                                          }
                                                        }}
                                                        onClick={(e) => e.stopPropagation()}
                                                      />
                                                    ) : (
                                                      <span className="min-w-0 flex-1 truncate text-[10px]">
                                                        {thread.title}
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
                                                        isHighlighted
                                                          ? "text-foreground/65"
                                                          : "text-muted-foreground/40"
                                                      }`}
                                                    >
                                                      {formatRelativeTime(thread.createdAt)}
                                                    </span>
                                                  </div>
                                                </SidebarMenuSubButton>
                                              </SidebarMenuSubItem>
                                            );
                                          })}

                                          {visibleThreadEntries.length === 0 ? (
                                            <SidebarMenuSubItem className="w-full">
                                              <SidebarMenuSubButton
                                                render={<button type="button" />}
                                                size="sm"
                                                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground/80"
                                                onClick={() => {
                                                  void handleNewThread({
                                                    projectId: project.id,
                                                    worktreeId: worktree.id,
                                                    branch: worktree.branch,
                                                    worktreePath,
                                                    envMode: worktreeEnvMode,
                                                  });
                                                }}
                                              >
                                                <span>No threads yet</span>
                                              </SidebarMenuSubButton>
                                            </SidebarMenuSubItem>
                                          ) : null}

                                          {hasHiddenThreads && !isThreadListExpanded ? (
                                            <SidebarMenuSubItem className="w-full">
                                              <SidebarMenuSubButton
                                                render={<button type="button" />}
                                                data-thread-selection-safe
                                                size="sm"
                                                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                                onClick={() => {
                                                  expandThreadListForWorktree(worktree.id);
                                                }}
                                              >
                                                <span>Show more</span>
                                              </SidebarMenuSubButton>
                                            </SidebarMenuSubItem>
                                          ) : null}
                                          {hasHiddenThreads && isThreadListExpanded ? (
                                            <SidebarMenuSubItem className="w-full">
                                              <SidebarMenuSubButton
                                                render={<button type="button" />}
                                                data-thread-selection-safe
                                                size="sm"
                                                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                                onClick={() => {
                                                  collapseThreadListForWorktree(worktree.id);
                                                }}
                                              >
                                                <span>Show less</span>
                                              </SidebarMenuSubButton>
                                            </SidebarMenuSubItem>
                                          ) : null}
                                        </SidebarMenuSub>
                                      </CollapsibleContent>
                                    </Collapsible>
                                  </SidebarMenuSubItem>
                                );
                              })}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                        </Collapsible>
                      )}
                    </SortableProjectItem>
                  );
                })}
              </SortableContext>
            </SidebarMenu>
          </DndContext>

          {projects.length === 0 && !shouldShowProjectPathEntry && (
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
