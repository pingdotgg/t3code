import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  GitPullRequestIcon,
  PlusIcon,
  RocketIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  type ProviderKind,
  type ProviderSessionUsage,
  type ProviderUsageQuota,
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
import { newCommandId, newProjectId } from "../lib/utils";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut, shortcutLabelForCommand } from "../keybindings";
import { useProjectThreadNavigation } from "../hooks/useProjectThreadNavigation";
import { type Thread } from "../types";
import { derivePendingApprovals } from "../session-logic";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { providerGetUsageQueryOptions } from "../lib/providerReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInput,
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

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 6;

function normalizeThreadTitleSearchQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function threadTitleMatchesSearch(thread: Thread, query: string): boolean {
  if (query.length === 0) return true;
  return thread.title.toLocaleLowerCase().includes(query);
}

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

interface ThreadStatusPill {
  label: "Working" | "Connecting" | "Completed" | "Pending Approval";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
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

function hasUnseenCompletion(thread: Thread): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

function threadStatusPill(thread: Thread, hasPendingApprovals: boolean): ThreadStatusPill | null {
  if (hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

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

// ── Provider Usage Section ────────────────────────────────────────────

function useProviderUsage(provider: ProviderKind) {
  return useQuery({
    ...providerGetUsageQueryOptions(provider),
    refetchInterval: 60_000,
  });
}

function formatSidebarTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function resolveUserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function formatUsageResetLabel(resetDate: string): string {
  const trimmed = resetDate.trim();
  if (trimmed.length === 0) return resetDate;

  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  if (isDateOnly) {
    const [year, month, day] = trimmed.split("-").map(Number);
    const utcDate = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(utcDate);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return resetDate;

  const includeYear = parsed.getFullYear() !== new Date().getFullYear();
  const userTimeZone = resolveUserTimeZone();

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(userTimeZone ? { timeZone: userTimeZone } : {}),
  }).format(parsed);
}

function formatUsagePercentLabel(quota: ProviderUsageQuota, percentUsed: number): string {
  if (quota.percentUsed != null) {
    return `${String(quota.percentUsed)}%`;
  }
  return `${Math.round(percentUsed)}%`;
}

function ProviderUsageBar({
  label,
  quota,
  showCount,
  accentColor,
}: {
  label: string;
  quota: ProviderUsageQuota;
  showCount?: boolean;
  accentColor?: string;
}) {
  const percentUsed =
    quota.percentUsed ??
    (quota.used != null && quota.limit ? Math.round((quota.used / quota.limit) * 100) : null);
  const remaining = quota.used != null && quota.limit != null ? quota.limit - quota.used : null;

  const countSuffix =
    showCount && remaining != null && quota.limit != null ? ` (${remaining}/${quota.limit})` : "";

  const barColor =
    percentUsed != null && percentUsed > 90
      ? undefined
      : percentUsed != null && percentUsed > 70
        ? undefined
        : accentColor;

  const barClassName =
    percentUsed != null && percentUsed > 90
      ? "bg-destructive"
      : percentUsed != null && percentUsed > 70
        ? "bg-amber-500"
        : accentColor
          ? ""
          : "bg-primary";

  return (
    <div className="rounded-md border border-border bg-background px-2.5 py-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-foreground">
          {label}
          {quota.plan ? <span className="ml-1 text-muted-foreground/60">{quota.plan}</span> : null}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {percentUsed != null ? `${formatUsagePercentLabel(quota, percentUsed)}${countSuffix}` : "?"}
        </span>
      </div>
      {percentUsed != null && (
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${barClassName}`}
            style={{
              width: `${Math.min(100, percentUsed)}%`,
              ...(barColor ? { backgroundColor: barColor } : {}),
            }}
          />
        </div>
      )}
      {quota.resetDate && (
        <p className="mt-1 text-[10px] text-muted-foreground/60">
          Resets {formatUsageResetLabel(quota.resetDate)}
        </p>
      )}
    </div>
  );
}

function ProviderSessionUsageBar({
  label,
  usage,
}: {
  label: string;
  usage: ProviderSessionUsage;
}) {
  const parts: string[] = [];
  if (typeof usage.totalCostUsd === "number" && usage.totalCostUsd > 0) {
    parts.push(`$${usage.totalCostUsd.toFixed(2)}`);
  }
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
    parts.push(`${formatSidebarTokenCount(usage.totalTokens)} tokens`);
  }
  if (typeof usage.turnCount === "number" && usage.turnCount > 0) {
    parts.push(`${usage.turnCount} turn${usage.turnCount !== 1 ? "s" : ""}`);
  }
  if (parts.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-background px-2.5 py-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{parts.join(" · ")}</span>
      </div>
    </div>
  );
}

const USAGE_PROVIDERS: ReadonlyArray<{ provider: ProviderKind; label: string }> = [
  { provider: "copilot", label: "Copilot" },
  { provider: "codex", label: "Codex" },
  { provider: "cursor", label: "Cursor" },
  { provider: "claudeCode", label: "Claude Code" },
  { provider: "geminiCli", label: "Gemini" },
  { provider: "amp", label: "Amp" },
];

function ProviderUsageSection() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-usage-collapsed") === "true";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("sidebar-usage-collapsed", String(next));
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  const { settings: usageSettings } = useAppSettings();

  const copilotUsage = useProviderUsage("copilot");
  const codexUsage = useProviderUsage("codex");
  const cursorUsage = useProviderUsage("cursor");
  const claudeUsage = useProviderUsage("claudeCode");
  const geminiUsage = useProviderUsage("geminiCli");
  const ampUsage = useProviderUsage("amp");

  const usageByProvider: Record<string, typeof copilotUsage.data> = {
    copilot: copilotUsage.data,
    codex: codexUsage.data,
    cursor: cursorUsage.data,
    claudeCode: claudeUsage.data,
    geminiCli: geminiUsage.data,
    amp: ampUsage.data,
  };

  const entries: Array<React.ReactNode> = [];
  for (const { provider, label } of USAGE_PROVIDERS) {
    const data = usageByProvider[provider];
    const showCount = provider === "copilot";
    const providerColor = usageSettings.providerAccentColors[provider] || null;
    const colorProp = providerColor ? { accentColor: providerColor } : {};
    // Multiple quotas (e.g. Codex session + weekly)
    if (data?.quotas && data.quotas.length > 0) {
      for (const q of data.quotas) {
        if (q.percentUsed == null && q.used == null) continue;
        const sublabel = q.plan ? `${label}` : label;
        entries.push(
          <ProviderUsageBar
            key={`${provider}:${q.plan ?? "default"}`}
            label={sublabel}
            quota={q}
            showCount={showCount}
            {...colorProp}
          />,
        );
      }
    } else if (
      data?.quota &&
      (data.quota.used != null || data.quota.limit != null || data.quota.percentUsed != null)
    ) {
      entries.push(
        <ProviderUsageBar key={provider} label={label} quota={data.quota} showCount={showCount} {...colorProp} />,
      );
    }
    // Session usage (no quota) — show token/cost summary
    if (
      provider !== "claudeCode" &&
      data?.sessionUsage &&
      (data.sessionUsage.totalTokens || data.sessionUsage.totalCostUsd)
    ) {
      entries.push(
        <ProviderSessionUsageBar key={`${provider}:session`} label={label} usage={data.sessionUsage} />,
      );
    }
  }

  if (entries.length === 0) return null;

  return (
    <div className="px-3 py-2">
      <button
        type="button"
        onClick={toggleCollapsed}
        className="mb-1.5 flex w-full items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-primary/70 hover:text-primary transition-colors"
      >
        <ChevronRightIcon
          className={`h-3 w-3 transition-transform ${collapsed ? "" : "rotate-90"}`}
        />
        Usage
      </button>
      {!collapsed && <div className="space-y-1.5">{entries}</div>}
    </div>
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const moveProject = useStore((store) => store.moveProject);
  const toggleProject = useStore((store) => store.toggleProject);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearThreadDraft);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
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
  const { openOrCreateThread: handleNewThread, openProject: focusMostRecentThreadForProject } =
    useProjectThreadNavigation(routeThreadId);
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
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [draggingProjectId, setDraggingProjectId] = useState<ProjectId | null>(null);
  const draggingProjectIdRef = useRef<ProjectId | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{
    projectId: ProjectId;
    position: "before" | "after";
  } | null>(null);
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const pendingApprovalByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingApprovals(thread.activities).length > 0);
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
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);

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

  const getProjectDropPosition = useCallback(
    (event: DragEvent<HTMLElement>): "before" | "after" => {
      const bounds = event.currentTarget.getBoundingClientRect();
      return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    },
    [],
  );

  const handleProjectDragStart = useCallback((event: DragEvent<HTMLElement>, projectId: ProjectId) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(projectId));
    draggingProjectIdRef.current = projectId;
    setDraggingProjectId(projectId);
    setProjectDropTarget({ projectId, position: "after" });
  }, []);

  const handleProjectDragOver = useCallback(
    (event: DragEvent<HTMLElement>, projectId: ProjectId) => {
      if (!draggingProjectIdRef.current) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setProjectDropTarget({
        projectId,
        position: getProjectDropPosition(event),
      });
    },
    [getProjectDropPosition],
  );

  const handleProjectDrop = useCallback(
    (event: DragEvent<HTMLElement>, targetProjectId: ProjectId) => {
      const currentDraggingId = draggingProjectIdRef.current;
      if (!currentDraggingId) {
        return;
      }
      event.preventDefault();
      const position = getProjectDropPosition(event);
      moveProject(currentDraggingId, targetProjectId, position);
      draggingProjectIdRef.current = null;
      setDraggingProjectId(null);
      setProjectDropTarget(null);
    },
    [getProjectDropPosition, moveProject],
  );

  const clearProjectDragState = useCallback(() => {
    draggingProjectIdRef.current = null;
    setDraggingProjectId(null);
    setProjectDropTarget(null);
  }, []);

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
        await focusMostRecentThreadForProject(existing.id);
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
        const projectDraftThread = getDraftThreadByProjectId(projectId);
        if (projectDraftThread) {
          clearComposerDraftForThread(projectDraftThread.threadId);
        }
        clearProjectDraftThreadId(projectId);
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
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadId,
      getDraftThreadByProjectId,
      projects,
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
  const newThreadShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "chat.newLocal") ??
      shortcutLabelForCommand(keybindings, "chat.new"),
    [keybindings],
  );
  const normalizedThreadSearchQuery = useMemo(
    () => normalizeThreadTitleSearchQuery(threadSearchQuery),
    [threadSearchQuery],
  );
  const hasActiveThreadSearch = normalizedThreadSearchQuery.length > 0;
  const matchingThreadCount = useMemo(() => {
    if (!hasActiveThreadSearch) return 0;
    return threads.filter((thread) => threadTitleMatchesSearch(thread, normalizedThreadSearchQuery)).length;
  }, [hasActiveThreadSearch, normalizedThreadSearchQuery, threads]);

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

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

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
        <button
          type="button"
          aria-label="Settings"
          className="ml-auto inline-flex size-7 items-center justify-center rounded-md text-primary/70 transition-colors hover:text-primary hover:bg-primary/10"
          onClick={() => void navigate({ to: "/settings" })}
        >
          <SettingsIcon className="size-3.5" />
        </button>
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

          <div className="px-2 pb-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <SidebarInput
                type="search"
                aria-label="Search all threads"
                value={threadSearchQuery}
                placeholder="Search all threads"
                className="h-8 border-border/70 bg-background text-xs"
                inputClassName="pl-8 pr-8 text-[11px] placeholder:text-[11px]"
                onChange={(event) => {
                  setThreadSearchQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setThreadSearchQuery("");
                }}
              />
              {threadSearchQuery.length > 0 && (
                <button
                  type="button"
                  aria-label="Clear thread search"
                  className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
                  onClick={() => {
                    setThreadSearchQuery("");
                  }}
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
            {hasActiveThreadSearch && (
              <p className="px-1 pt-1 text-[10px] text-muted-foreground/60">
                {matchingThreadCount === 1 ? "1 matching thread" : `${matchingThreadCount} matching threads`}
              </p>
            )}
          </div>
          <SidebarMenu>
            {projects.map((project) => {
              const projectThreads = threads
                .filter((thread) => thread.projectId === project.id)
                .toSorted((a, b) => {
                  const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                  if (byDate !== 0) return byDate;
                  return b.id.localeCompare(a.id);
                });
              const filteredProjectThreads = hasActiveThreadSearch
                ? projectThreads.filter((thread) =>
                    threadTitleMatchesSearch(thread, normalizedThreadSearchQuery),
                  )
                : projectThreads;
              if (hasActiveThreadSearch && filteredProjectThreads.length === 0) {
                return null;
              }
              const isThreadSearchFiltering = hasActiveThreadSearch;
              const isThreadListExpanded =
                isThreadSearchFiltering || expandedThreadListsByProject.has(project.id);
              const hasHiddenThreads =
                !isThreadSearchFiltering && filteredProjectThreads.length > THREAD_PREVIEW_LIMIT;
              const visibleThreads =
                hasHiddenThreads && !isThreadListExpanded
                  ? filteredProjectThreads.slice(0, THREAD_PREVIEW_LIMIT)
                  : filteredProjectThreads;
              const isProjectOpen = project.expanded || isThreadSearchFiltering;

              return (
                <Collapsible
                  key={project.id}
                  className="group/collapsible"
                  open={isProjectOpen}
                  onOpenChange={(open) => {
                    if (isThreadSearchFiltering || open === project.expanded) return;
                    toggleProject(project.id);
                  }}
                >
                  <SidebarMenuItem>
                    <div
                      className="group/project-header relative"
                      role="listitem"
                      aria-grabbed={draggingProjectId === project.id}
                      aria-label={`Drag to reorder ${project.name}`}
                      draggable
                      onDragStart={(event) => {
                        handleProjectDragStart(event, project.id);
                      }}
                      onDragEnd={clearProjectDragState}
                      onDragOver={(event) => {
                        handleProjectDragOver(event, project.id);
                      }}
                      onDragLeave={(event) => {
                        if (
                          !event.currentTarget.contains(
                            event.relatedTarget as Node | null,
                          )
                        ) {
                          setProjectDropTarget(null);
                        }
                      }}
                      onDrop={(event) => {
                        handleProjectDrop(event, project.id);
                      }}
                    >
                      {projectDropTarget?.projectId === project.id ? (
                        <div
                          className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary ${
                            projectDropTarget.position === "before" ? "top-0" : "bottom-0"
                          }`}
                        />
                      ) : null}
                      <CollapsibleTrigger
                        render={
                          <SidebarMenuButton
                            size="sm"
                            className={`gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
                              draggingProjectId === project.id ? "opacity-55" : ""
                            }`}
                          />
                        }
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
                            isProjectOpen ? "rotate-90" : ""
                          }`}
                        />
                        <ProjectFavicon cwd={project.cwd} />
                        <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                          {project.name}
                        </span>
                      </CollapsibleTrigger>
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
                        <TooltipPopup side="top">
                          {newThreadShortcutLabel
                            ? `New thread (${newThreadShortcutLabel})`
                            : "New thread"}
                        </TooltipPopup>
                      </Tooltip>
                    </div>

                    <CollapsibleContent>
                      <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0 px-1.5 py-0">
                        {visibleThreads.map((thread) => {
                          const isActive = routeThreadId === thread.id;
                          const threadStatus = threadStatusPill(
                            thread,
                            pendingApprovalByThreadId.get(thread.id) === true,
                          );
                          const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
                          const terminalStatus = terminalStatusFromRunningIds(
                            selectThreadTerminalState(terminalStateByThreadId, thread.id)
                              .runningTerminalIds,
                          );

                          return (
                            <SidebarMenuSubItem key={thread.id} className="w-full">
                              <SidebarMenuSubButton
                                render={<div role="button" tabIndex={0} />}
                                size="sm"
                                isActive={isActive}
                                className={`h-7 w-full translate-x-0 cursor-default justify-start px-2 text-left hover:bg-accent hover:text-foreground ${
                                  isActive
                                    ? "bg-accent/85 text-foreground font-medium ring-1 ring-border/70 dark:bg-accent/55 dark:ring-border/50"
                                    : "text-muted-foreground"
                                }`}
                                onClick={() => {
                                  void navigate({
                                    to: "/$threadId",
                                    params: { threadId: thread.id },
                                  });
                                }}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter" && event.key !== " ") return;
                                  event.preventDefault();
                                  void navigate({
                                    to: "/$threadId",
                                    params: { threadId: thread.id },
                                  });
                                }}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  void handleThreadContextMenu(thread.id, {
                                    x: event.clientX,
                                    y: event.clientY,
                                  });
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
                                      <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
                                    </Tooltip>
                                  )}
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
                                  {renamingThreadId === thread.id ? (
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
                                    <span className="min-w-0 flex-1 truncate text-xs">
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
                                      isActive ? "text-foreground/65" : "text-muted-foreground/40"
                                    }`}
                                  >
                                    {formatRelativeTime(thread.createdAt)}
                                  </span>
                                </div>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          );
                        })}
                        {hasHiddenThreads && !isThreadListExpanded && (
                          <SidebarMenuSubItem className="w-full">
                            <SidebarMenuSubButton
                              render={<button type="button" />}
                              size="sm"
                              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                              onClick={() => {
                                expandThreadListForProject(project.id);
                              }}
                            >
                              <span>Show more</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        )}
                        {hasHiddenThreads && isThreadListExpanded && (
                          <SidebarMenuSubItem className="w-full">
                            <SidebarMenuSubButton
                              render={<button type="button" />}
                              size="sm"
                              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                              onClick={() => {
                                collapseThreadListForProject(project.id);
                              }}
                            >
                              <span>Show less</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        )}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              );
            })}
          </SidebarMenu>

          {hasActiveThreadSearch && matchingThreadCount === 0 && (
            <div className="px-2 pt-2 text-center text-xs text-muted-foreground/60">
              No matching threads.
            </div>
          )}
          {projects.length === 0 && !addingProject && (
            <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
              No projects yet
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>

      <ProviderUsageSection />
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
