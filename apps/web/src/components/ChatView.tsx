import {
  EDITORS,
  type EditorId,
  type NativeApi,
  type ProjectEntry,
  type ProjectScript,
  ModelSlug,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ResolvedKeybindingsConfig,
  type ProviderApprovalDecision,
  type ProviderSendTurnAttachmentInput,
} from "@t3tools/contracts";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { gitBranchesQueryOptions, gitCreateWorktreeMutationOptions } from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";

import { isElectron } from "../env";
import { buildBootstrapInput } from "../historyBootstrap";
import {
  type ComposerTriggerKind,
  detectComposerTrigger,
  replaceTextRange,
} from "../composer-logic";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  MODEL_OPTIONS,
  REASONING_OPTIONS,
  ReasoningEffort,
  resolveModelSlug,
} from "../model-logic";
import {
  countDiffStat,
  derivePendingApprovals,
  derivePhase,
  deriveTimelineEntries,
  type TurnDiffSummary,
  type PendingApproval,
  deriveWorkLogEntries,
  formatDuration,
  formatElapsed,
  formatTimestamp,
} from "../session-logic";
import { isScrollContainerNearBottom } from "../chat-scroll";
import { useStore } from "../store";
import { truncateTitle } from "../truncateTitle";
import {
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_THREAD_TERMINAL_COUNT,
  type ChatImageAttachment,
} from "../types";
import { basenameOfPath, getVscodeIconUrlForEntry } from "../vscode-icons";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import BranchToolbar from "./BranchToolbar";
import GitActionsControl from "./GitActionsControl";
import {
  isOpenFavoriteEditorShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import ChatMarkdown from "./ChatMarkdown";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { useNativeApi } from "../hooks/useNativeApi";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import {
  BotIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FileIcon,
  FolderIcon,
  DiffIcon,
  FolderClosedIcon,
  InfoIcon,
  LockIcon,
  LockOpenIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Separator } from "./ui/separator";
import { Group, GroupSeparator } from "./ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { CursorIcon, Icon } from "./Icons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command";
import ProjectScriptsControl, { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "~/projectScripts";
import { Toggle } from "./ui/toggle";

function formatMessageMeta(createdAt: string, duration: string | null): string {
  if (!duration) return formatTimestamp(createdAt);
  return `${formatTimestamp(createdAt)} • ${duration}`;
}

const LAST_EDITOR_KEY = "t3code:last-editor";
const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const SEARCHABLE_MODEL_OPTIONS = MODEL_OPTIONS.map(({ slug, name }) => ({
  slug,
  name,
  searchSlug: slug.toLowerCase(),
  searchName: name.toLowerCase(),
}));
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

function readLastInvokedScriptByProjectFromStorage(): Record<string, string> {
  const stored = localStorage.getItem(LAST_INVOKED_SCRIPT_BY_PROJECT_KEY);
  if (!stored) return {};

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

type SessionContinuityState = "resumed" | "new" | "fallback_new";

interface EnsuredSessionInfo {
  sessionId: string;
  resolvedThreadId: string | null;
  continuityState: SessionContinuityState;
}

interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

interface ExpandedImagePreview {
  src: string;
  name: string;
}

type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model";
      model: ModelSlug;
      label: string;
      description: string;
    };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

const VscodeEntryIcon = memo(function VscodeEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  theme: "light" | "dark";
}) {
  const [failed, setFailed] = useState(false);
  const iconUrl = useMemo(
    () => getVscodeIconUrlForEntry(props.pathValue, props.kind, props.theme),
    [props.kind, props.pathValue, props.theme],
  );

  useEffect(() => {
    setFailed(false);
  }, [iconUrl]);

  if (failed) {
    return props.kind === "directory" ? (
      <FolderIcon className="size-4 text-muted-foreground/80" />
    ) : (
      <FileIcon className="size-4 text-muted-foreground/80" />
    );
  }

  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  onSelect: (item: ComposerCommandItem) => void;
}) {
  return (
    <CommandItem
      value={props.item.id}
      className="cursor-pointer gap-2"
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <VscodeEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "slash-command" ? (
        <BotIcon className="size-4 text-muted-foreground/80" />
      ) : null}
      {props.item.type === "model" ? (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          model
        </Badge>
      ) : null}
      <span className="truncate">{props.item.label}</span>
      <span className="truncate text-muted-foreground/70 text-xs">{props.item.description}</span>
    </CommandItem>
  );
});

const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
  commandInputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <Command
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div className="relative overflow-hidden rounded-xl border border-border/80 bg-popover/96 shadow-lg/8 backdrop-blur-xs">
        <div className="pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0">
          <CommandInput autoFocus={false} ref={props.commandInputRef} />
        </div>
        <CommandList className="max-h-64">
          {props.items.map((item) => (
            <ComposerCommandMenuItem
              key={item.id}
              item={item}
              resolvedTheme={props.resolvedTheme}
              onSelect={props.onSelect}
            />
          ))}
        </CommandList>
        {props.items.length === 0 && (
          <p className="px-3 py-2 text-muted-foreground/70 text-xs">
            {props.isLoading
              ? "Searching workspace files..."
              : props.triggerKind === "path"
                ? "No matching files or folders."
                : "No matching command."}
          </p>
        )}
      </div>
    </Command>
  );
});

interface ChatViewProps {
  threadId: string;
}

export default function ChatView({ threadId }: ChatViewProps) {
  const { state, dispatch } = useStore();
  const api = useNativeApi();
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(
    gitCreateWorktreeMutationOptions({ api, queryClient }),
  );
  const [prompt, setPrompt] = useState("");
  const promptRef = useRef(prompt);
  const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [selectedEffort, setSelectedEffort] = useState(DEFAULT_REASONING);
  const [envMode, setEnvMode] = useState<"local" | "worktree">("local");
  const [isSwitchingRuntimeMode, setIsSwitchingRuntimeMode] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<string[]>([]);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerCursor, setComposerCursor] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useState<
    Record<string, string>
  >(() => readLastInvokedScriptByProjectFromStorage());
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerCommandInputRef = useRef<HTMLInputElement>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const checkpointHydrationSessionRequestRef = useRef(new Set<string>());

  const activeThread = state.threads.find((t) => t.id === threadId);
  const activeThreadId = activeThread?.id ?? null;
  const activeSessionId = activeThread?.session?.sessionId ?? null;
  const activeThreadRuntimeId =
    activeThread?.codexThreadId ?? activeThread?.session?.threadId ?? null;
  const activeProject = state.projects.find((p) => p.id === activeThread?.projectId);
  const selectedModel = resolveModelSlug(
    activeThread?.model ?? activeProject?.model ?? DEFAULT_MODEL,
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const isWorking = phase === "running" || isSending || isConnecting || isRevertingCheckpoint;
  const nowIso = new Date(nowTick).toISOString();
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(activeThread?.events ?? [], undefined),
    [activeThread?.events],
  );
  const latestTurnWorkEntries = useMemo(
    () => deriveWorkLogEntries(activeThread?.events ?? [], activeThread?.latestTurnId),
    [activeThread?.events, activeThread?.latestTurnId],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(activeThread?.events ?? []),
    [activeThread?.events],
  );
  const assistantCompletionByItemId = useMemo(() => {
    const map = new Map<string, string>();
    const ordered = [...(activeThread?.events ?? [])].toReversed();
    for (const event of ordered) {
      if (event.method !== "item/completed") continue;
      if (!event.itemId) continue;
      map.set(event.itemId, event.createdAt);
    }
    return map;
  }, [activeThread?.events]);
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(activeThread?.messages ?? [], workLogEntries),
    [activeThread?.messages, workLogEntries],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<string, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<string, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  useEffect(() => {
    if (!activeThreadId || turnDiffSummaries.length === 0) {
      return;
    }

    const inferredMissingTurnCounts = turnDiffSummaries.reduce<Record<string, number>>(
      (acc, summary) => {
        if (typeof summary.checkpointTurnCount === "number") {
          return acc;
        }
        const inferredTurnCount = inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof inferredTurnCount !== "number") {
          return acc;
        }
        acc[summary.turnId] = inferredTurnCount;
        return acc;
      },
      {},
    );
    if (Object.keys(inferredMissingTurnCounts).length === 0) {
      return;
    }

    dispatch({
      type: "SET_THREAD_TURN_CHECKPOINT_COUNTS",
      threadId: activeThreadId,
      checkpointTurnCountByTurnId: inferredMissingTurnCounts,
    });
  }, [activeThreadId, dispatch, inferredCheckpointTurnCountByTurnId, turnDiffSummaries]);

  const checkpointDiffHydrationTargets = useMemo(() => {
    if (!api || !activeThreadId || !activeSessionId || turnDiffSummaries.length === 0) {
      return [];
    }
    return turnDiffSummaries.flatMap((summary) => {
      const turnCount = inferredCheckpointTurnCountByTurnId[summary.turnId];
      if (summary.checkpointDiffLoaded || typeof turnCount !== "number") {
        return [];
      }
      return [
        {
          turnId: summary.turnId,
          fromTurnCount: Math.max(0, turnCount - 1),
          toTurnCount: turnCount,
        },
      ];
    });
  }, [
    activeSessionId,
    activeThreadId,
    api,
    inferredCheckpointTurnCountByTurnId,
    turnDiffSummaries,
  ]);

  const checkpointDiffHydrationQueries = useQueries({
    queries: checkpointDiffHydrationTargets.map((target) =>
      checkpointDiffQueryOptions(api, {
        sessionId: activeSessionId,
        threadRuntimeId: activeThreadRuntimeId,
        fromTurnCount: target.fromTurnCount,
        toTurnCount: target.toTurnCount,
        cacheScope: `turn:${target.turnId}`,
      }),
    ),
  });

  useEffect(() => {
    if (!activeThreadId || checkpointDiffHydrationTargets.length === 0) {
      return;
    }

    const checkpointDiffByTurnId: Record<string, string> = {};
    for (let index = 0; index < checkpointDiffHydrationTargets.length; index += 1) {
      const target = checkpointDiffHydrationTargets[index];
      const query = checkpointDiffHydrationQueries[index];
      const diff = query?.data?.diff;
      if (!target || !diff) {
        continue;
      }
      checkpointDiffByTurnId[target.turnId] = diff;
    }
    if (Object.keys(checkpointDiffByTurnId).length === 0) {
      return;
    }
    dispatch({
      type: "SET_THREAD_TURN_CHECKPOINT_DIFFS",
      threadId: activeThreadId,
      checkpointDiffByTurnId,
    });
  }, [activeThreadId, checkpointDiffHydrationQueries, checkpointDiffHydrationTargets, dispatch]);

  const completionSummary = useMemo(() => {
    if (!activeThread?.latestTurnStartedAt) return null;
    if (!activeThread.latestTurnCompletedAt) return null;
    if (!latestTurnWorkEntries.some((entry) => entry.tone === "tool")) {
      return null;
    }

    if (
      typeof activeThread.latestTurnDurationMs === "number" &&
      Number.isFinite(activeThread.latestTurnDurationMs) &&
      activeThread.latestTurnDurationMs >= 0
    ) {
      return `Worked for ${formatDuration(activeThread.latestTurnDurationMs)}`;
    }

    const elapsed = formatElapsed(
      activeThread.latestTurnStartedAt,
      activeThread.latestTurnCompletedAt,
    );
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeThread?.latestTurnStartedAt,
    activeThread?.latestTurnCompletedAt,
    activeThread?.latestTurnDurationMs,
    latestTurnWorkEntries,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!activeThread?.latestTurnStartedAt) return null;
    if (!activeThread.latestTurnCompletedAt) return null;
    if (!completionSummary) return null;

    const turnStartedAt = Date.parse(activeThread.latestTurnStartedAt);
    const turnCompletedAt = Date.parse(activeThread.latestTurnCompletedAt);
    if (Number.isNaN(turnStartedAt)) return null;
    if (Number.isNaN(turnCompletedAt)) return null;

    let inRangeMatch: string | null = null;
    let fallbackMatch: string | null = null;
    for (const timelineEntry of timelineEntries) {
      if (timelineEntry.kind !== "message") continue;
      if (timelineEntry.message.role !== "assistant") continue;
      const messageAt = Date.parse(timelineEntry.message.createdAt);
      if (Number.isNaN(messageAt) || messageAt < turnStartedAt) continue;
      fallbackMatch = timelineEntry.id;
      if (messageAt <= turnCompletedAt) {
        inRangeMatch = timelineEntry.id;
      }
    }
    return inRangeMatch ?? fallbackMatch;
  }, [
    activeThread?.latestTurnCompletedAt,
    activeThread?.latestTurnStartedAt,
    completionSummary,
    timelineEntries,
  ]);
  const runtimeApprovalPolicy = state.runtimeMode === "full-access" ? "never" : "on-request";
  const runtimeSandboxMode =
    state.runtimeMode === "full-access" ? "danger-full-access" : "workspace-write";
  const gitCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const composerTrigger = useMemo(
    () => detectComposerTrigger(prompt, composerCursor),
    [prompt, composerCursor],
  );
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const branchesQuery = useQuery(gitBranchesQueryOptions(api, gitCwd));
  const keybindingsQuery = useQuery({
    ...serverConfigQueryOptions(api),
    select: (config) => config.keybindings,
  });
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      api,
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
    }

    if (composerTrigger.kind === "slash-command") {
      if (!"model".includes(composerTrigger.query.toLowerCase())) {
        return [];
      }
      return [
        {
          id: "slash:model",
          type: "slash-command",
          label: "/model",
          description: "Switch response model for this thread",
        },
      ];
    }

    return SEARCHABLE_MODEL_OPTIONS.filter(({ searchSlug, searchName }) => {
      const query = composerTrigger.query.trim().toLowerCase();
      if (!query) return true;
      return searchSlug.includes(query) || searchName.includes(query);
    }).map(({ slug, name }) => ({
      id: `model:${slug}`,
      type: "model",
      model: slug,
      label: name,
      description: slug,
    }));
  }, [composerTrigger, workspaceEntries]);
  const composerMenuOpen = Boolean(composerTrigger);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  const keybindings = keybindingsQuery.data ?? EMPTY_KEYBINDINGS;
  const threadTerminalRuntimeEnv = useMemo(() => {
    if (!activeProject?.cwd) return {};
    return projectScriptRuntimeEnv({
      project: {
        cwd: activeProject.cwd,
      },
      worktreePath: activeThread?.worktreePath ?? null,
    });
  }, [activeProject?.cwd, activeThread?.worktreePath]);
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = branchesQuery.data?.isRepo ?? true;
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split"),
    [keybindings],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new"),
    [keybindings],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close"),
    [keybindings],
  );

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const hasReachedTerminalLimit =
    (activeThread?.terminalIds.length ?? 0) >= MAX_THREAD_TERMINAL_COUNT;

  const revokePreviewUrls = useCallback((images: Array<{ previewUrl?: string }>) => {
    for (const image of images) {
      if (!image.previewUrl) continue;
      URL.revokeObjectURL(image.previewUrl);
    }
  }, []);
  const focusComposer = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    const cursor = textarea.value.length;
    textarea.setSelectionRange(cursor, cursor);
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    dispatch({
      type: "SET_THREAD_TERMINAL_OPEN",
      threadId: activeThreadId,
      open: !activeThread?.terminalOpen,
    });
  }, [activeThread?.terminalOpen, activeThreadId, dispatch]);
  const splitTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedTerminalLimit) return;
    dispatch({
      type: "SPLIT_THREAD_TERMINAL",
      threadId: activeThreadId,
      terminalId: `terminal-${crypto.randomUUID()}`,
    });
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, dispatch, hasReachedTerminalLimit]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedTerminalLimit) return;
    dispatch({
      type: "NEW_THREAD_TERMINAL",
      threadId: activeThreadId,
      terminalId: `terminal-${crypto.randomUUID()}`,
    });
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, dispatch, hasReachedTerminalLimit]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      dispatch({
        type: "SET_THREAD_ACTIVE_TERMINAL",
        threadId: activeThreadId,
        terminalId,
      });
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, dispatch],
  );
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId || !api) return;
      const isFinalTerminal = (activeThread?.terminalIds.length ?? 0) <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({ threadId: activeThreadId, terminalId, deleteHistory: true });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      dispatch({
        type: "CLOSE_THREAD_TERMINAL",
        threadId: activeThreadId,
        terminalId,
      });
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThread?.terminalIds.length, activeThreadId, api, dispatch],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        activeThread.activeTerminalId || activeThread.terminalIds[0] || DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = activeThread.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal =
        wantsNewTerminal && activeThread.terminalIds.length < MAX_THREAD_TERMINAL_COUNT;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${crypto.randomUUID()}`
        : baseTerminalId;

      dispatch({
        type: "SET_THREAD_TERMINAL_OPEN",
        threadId: activeThreadId,
        open: true,
      });
      if (shouldCreateNewTerminal) {
        dispatch({
          type: "NEW_THREAD_TERMINAL",
          threadId: activeThreadId,
          terminalId: targetTerminalId,
        });
      } else {
        dispatch({
          type: "SET_THREAD_ACTIVE_TERMINAL",
          threadId: activeThreadId,
          terminalId: targetTerminalId,
        });
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });

      try {
        await api.terminal.open({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          cwd: targetCwd,
          env: runtimeEnv,
          ...(shouldCreateNewTerminal
            ? {
                cols: SCRIPT_TERMINAL_COLS,
                rows: SCRIPT_TERMINAL_ROWS,
              }
            : {}),
        });
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        dispatch({
          type: "SET_ERROR",
          threadId: activeThreadId,
          error: error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        });
      }
    },
    [activeProject, activeThread, activeThreadId, api, dispatch, gitCwd],
  );
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: string;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: string;
    }) => {
      dispatch({
        type: "SET_PROJECT_SCRIPTS",
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      if (!isElectron || !api) return;

      let scriptsPersisted = false;
      try {
        const updated = await api.projects.updateScripts({
          id: input.projectId,
          scripts: input.nextScripts,
        });
        scriptsPersisted = true;

        if (input.keybinding) {
          const keybindingUpdate = await api.server.upsertKeybinding({
            key: input.keybinding,
            command: input.keybindingCommand,
          });
          queryClient.setQueryData(
            serverQueryKeys.config(),
            (current: { cwd: string; keybindings: ResolvedKeybindingsConfig } | undefined) =>
              current
                ? { ...current, keybindings: keybindingUpdate.keybindings }
                : {
                    cwd: input.projectCwd,
                    keybindings: keybindingUpdate.keybindings,
                  },
          );
        }

        dispatch({
          type: "SET_PROJECT_SCRIPTS",
          projectId: updated.project.id,
          scripts: updated.project.scripts,
        });
      } catch (error) {
        if (scriptsPersisted) {
          await api.projects
            .updateScripts({
              id: input.projectId,
              scripts: input.previousScripts,
            })
            .catch(() => undefined);
        }
        dispatch({
          type: "SET_PROJECT_SCRIPTS",
          projectId: input.projectId,
          scripts: input.previousScripts,
        });
        throw error;
      }
    },
    [api, dispatch, queryClient],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = async (mode: "approval-required" | "full-access") => {
    if (mode === state.runtimeMode) return;
    dispatch({ type: "SET_RUNTIME_MODE", mode });
    scheduleComposerFocus();
    if (!api) return;

    const sessionIds = state.threads
      .map((t) => t.session)
      .filter((s): s is NonNullable<typeof s> => s !== null && s.status !== "closed")
      .map((s) => s.sessionId);

    if (sessionIds.length === 0) return;

    setIsSwitchingRuntimeMode(true);
    try {
      await Promise.all(
        sessionIds.map((id) => api.providers.stopSession({ sessionId: id }).catch(() => undefined)),
      );
    } finally {
      setIsSwitchingRuntimeMode(false);
    }
  };

  useEffect(() => {
    try {
      if (Object.keys(lastInvokedScriptByProjectId).length === 0) {
        localStorage.removeItem(LAST_INVOKED_SCRIPT_BY_PROJECT_KEY);
        return;
      }
      localStorage.setItem(
        LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
        JSON.stringify(lastInvokedScriptByProjectId),
      );
    } catch {
      // Ignore storage write failures (private mode, quota exceeded, etc.)
    }
  }, [lastInvokedScriptByProjectId]);

  // Auto-scroll on new messages
  const messageCount = activeThread?.messages.length ?? 0;
  const workLogCount = workLogEntries.length;
  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
    shouldAutoScrollRef.current = true;
  }, []);
  const onMessagesScroll = useCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    shouldAutoScrollRef.current = isScrollContainerNearBottom(scrollContainer);
  }, []);
  useLayoutEffect(() => {
    if (!activeThread?.id) return;
    scrollMessagesToBottom();
  }, [activeThread?.id, scrollMessagesToBottom]);
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scrollMessagesToBottom("smooth");
  }, [messageCount, scrollMessagesToBottom]);
  useEffect(() => {
    if (phase !== "running") return;
    if (!shouldAutoScrollRef.current) return;
    scrollMessagesToBottom("smooth");
  }, [phase, workLogCount, scrollMessagesToBottom]);

  useEffect(() => {
    setExpandedWorkGroups({});
  }, [activeThread?.id]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing) ? existing : null,
    );
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || activeThread.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, activeThread?.terminalOpen, focusComposer]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    setComposerImages((existing) => {
      revokePreviewUrls(existing);
      return [];
    });
    setPrompt("");
    promptRef.current = "";
    setIsSending(false);
    setComposerCursor(0);
    setComposerHighlightedItemId(null);
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [activeThread?.id, revokePreviewUrls]);

  useEffect(() => {
    return () => {
      revokePreviewUrls(composerImagesRef.current);
    };
  }, [revokePreviewUrls]);

  /**
   * Close expanded image on Escape key
   */
  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setExpandedImage(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expandedImage]);

  const activeWorktreePath = activeThread?.worktreePath;

  useEffect(() => {
    if (!activeThread?.id) return;
    setEnvMode(activeWorktreePath ? "worktree" : "local");
  }, [activeThread?.id, activeWorktreePath]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [prompt]);

  useEffect(() => {
    if (phase !== "running") return;
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase]);

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(activeThread?.terminalOpen);

    if (!previous && current) {
      setTerminalFocusRequestId((value) => value + 1);
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [activeThread?.terminalOpen, activeThreadId, focusComposer]);

  useEffect(() => {
    const isTerminalFocused = (): boolean => {
      const activeElement = document.activeElement;
      if (!(activeElement instanceof HTMLElement)) return false;
      if (activeElement.classList.contains("xterm-helper-textarea")) return true;
      return activeElement.closest(".thread-terminal-drawer .xterm") !== null;
    };

    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(activeThread?.terminalOpen),
      };

      const command = resolveShortcutCommand(event, keybindings, { context: shortcutContext });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!activeThread?.terminalOpen) {
          dispatch({
            type: "SET_THREAD_TERMINAL_OPEN",
            threadId: activeThreadId,
            open: true,
          });
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!activeThread?.terminalOpen) return;
        closeTerminal(activeThread.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!activeThread?.terminalOpen) {
          dispatch({
            type: "SET_THREAD_TERMINAL_OPEN",
            threadId: activeThreadId,
            open: true,
          });
        }
        createNewTerminal();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeProject,
    activeThread?.terminalOpen,
    activeThread?.activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    dispatch,
    runProjectScript,
    splitTerminal,
    keybindings,
    toggleTerminalVisibility,
  ]);

  const setThreadError = useCallback(
    (threadId: string | null, error: string | null) => {
      if (!threadId) return;
      dispatch({
        type: "SET_ERROR",
        threadId,
        error,
      });
    },
    [dispatch],
  );

  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;

    const nextImages = [...composerImagesRef.current];
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImages.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }

      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: crypto.randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
    }

    setComposerImages(nextImages);
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    setComposerImages((existing) => {
      const match = existing.find((image) => image.id === imageId);
      if (match?.previewUrl) {
        URL.revokeObjectURL(match.previewUrl);
      }
      return existing.filter((image) => image.id !== imageId);
    });
  };

  const onComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addComposerImages(imageFiles);
  };

  const onComposerDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerImages(files);
    focusComposer();
  };

  const ensureSession = useCallback(
    async (cwdOverride?: string): Promise<EnsuredSessionInfo | null> => {
      if (!api || !activeThread || !activeProject) return null;
      if (activeThread.session && activeThread.session.status !== "closed") {
        const sessionThreadId = activeThread.session.threadId ?? null;
        const continuityState: SessionContinuityState =
          activeThread.codexThreadId === null
            ? "new"
            : sessionThreadId === activeThread.codexThreadId
              ? "resumed"
              : "fallback_new";
        return {
          sessionId: activeThread.session.sessionId,
          resolvedThreadId: sessionThreadId,
          continuityState,
        } satisfies EnsuredSessionInfo;
      }

      const priorCodexThreadId = activeThread.codexThreadId;
      setIsConnecting(true);
      try {
        const session = await api.providers.startSession({
          provider: "codex",
          cwd: cwdOverride ?? activeThread.worktreePath ?? activeProject.cwd,
          model: selectedModel || undefined,
          resumeThreadId: priorCodexThreadId ?? undefined,
          approvalPolicy: runtimeApprovalPolicy,
          sandboxMode: runtimeSandboxMode,
        });
        dispatch({
          type: "UPDATE_SESSION",
          threadId: activeThread.id,
          session,
        });
        const resolvedThreadId = session.threadId ?? null;
        const continuityState: SessionContinuityState =
          priorCodexThreadId === null
            ? "new"
            : resolvedThreadId === priorCodexThreadId
              ? "resumed"
              : "fallback_new";
        return {
          sessionId: session.sessionId,
          resolvedThreadId,
          continuityState,
        };
      } catch (err) {
        dispatch({
          type: "SET_ERROR",
          threadId: activeThread.id,
          error: err instanceof Error ? err.message : "Failed to connect.",
        });
        return null;
      } finally {
        setIsConnecting(false);
      }
    },
    [
      activeProject,
      activeThread,
      api,
      dispatch,
      runtimeApprovalPolicy,
      runtimeSandboxMode,
      selectedModel,
    ],
  );

  useEffect(() => {
    if (!api || !activeThreadId || activeSessionId) return;
    if (phase === "running" || isSending || isConnecting || isRevertingCheckpoint) return;
    const hasThreadIdentity = Boolean(activeThreadRuntimeId);
    if (!hasThreadIdentity) return;
    const selectedDiffTurnId =
      state.diffOpen && state.diffThreadId === activeThreadId ? state.diffTurnId : null;
    const selectedDiffTurn =
      selectedDiffTurnId === null
        ? undefined
        : (turnDiffSummaries.find((summary) => summary.turnId === selectedDiffTurnId) ??
          turnDiffSummaries[0]);
    const selectedTurnMissingPatchBody = Boolean(
      selectedDiffTurn &&
      !selectedDiffTurn.unifiedDiff &&
      selectedDiffTurn.files.every((file) => !file.diff),
    );
    const hasPendingDiffHydration =
      turnDiffSummaries.some((summary) => !summary.checkpointDiffLoaded) ||
      selectedTurnMissingPatchBody;
    if (!hasPendingDiffHydration) return;

    const requestKey = `${activeThreadId}:${activeThreadRuntimeId ?? "none"}`;
    if (checkpointHydrationSessionRequestRef.current.has(requestKey)) {
      return;
    }
    checkpointHydrationSessionRequestRef.current.add(requestKey);
    setThreadError(activeThreadId, null);
    void ensureSession().then(
      () => {
        checkpointHydrationSessionRequestRef.current.delete(requestKey);
      },
      () => {
        // Keep the key on failure so this effect does not re-enter in a tight loop.
      },
    );
  }, [
    activeThreadId,
    activeThreadRuntimeId,
    activeSessionId,
    api,
    ensureSession,
    isConnecting,
    isRevertingCheckpoint,
    isSending,
    phase,
    setThreadError,
    state.diffOpen,
    state.diffThreadId,
    state.diffTurnId,
    turnDiffSummaries,
  ]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      if (!api || !activeThread || isRevertingCheckpoint) {
        return;
      }
      if (phase === "running" || isSending || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        const sessionInfo = await ensureSession();
        if (!sessionInfo) {
          return;
        }
        const result = await api.providers.revertToCheckpoint({
          sessionId: sessionInfo.sessionId,
          turnCount,
        });
        dispatch({
          type: "REVERT_TO_CHECKPOINT",
          threadId: activeThread.id,
          sessionId: sessionInfo.sessionId,
          threadRuntimeId: result.threadId,
          turnCount: result.turnCount,
          messageCount: result.messageCount,
        });
        dispatch({
          type: "SET_THREAD_TURN_CHECKPOINT_COUNTS",
          threadId: activeThread.id,
          checkpointTurnCountByTurnId: Object.fromEntries(
            result.checkpoints
              .filter((entry) => entry.turnCount > 0)
              .map((entry) => [entry.id, entry.turnCount] as const),
          ),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      } finally {
        setIsRevertingCheckpoint(false);
      }
    },
    [
      activeThread,
      api,
      dispatch,
      ensureSession,
      isConnecting,
      isRevertingCheckpoint,
      isSending,
      phase,
      setThreadError,
    ],
  );

  const onSend = async (e: FormEvent) => {
    e.preventDefault();
    if (!api || !activeThread || isSending || isConnecting) return;
    const trimmed = prompt.trim();
    if (!trimmed && composerImages.length === 0) return;
    if (!activeProject) return;
    const composerImagesSnapshot = [...composerImages];

    // On first message: lock in branch + create worktree if needed.
    let sessionCwd: string | undefined;
    if (
      activeThread.messages.length === 0 &&
      activeThread.branch &&
      envMode === "worktree" &&
      !activeThread.worktreePath
    ) {
      try {
        const newBranch = `codething/${crypto.randomUUID().slice(0, 8)}`;
        const result = await createWorktreeMutation.mutateAsync({
          cwd: activeProject.cwd,
          branch: activeThread.branch,
          newBranch,
        });
        sessionCwd = result.worktree.path;
        dispatch({
          type: "SET_THREAD_BRANCH",
          threadId: activeThread.id,
          branch: result.worktree.branch,
          worktreePath: result.worktree.path,
        });
        const setupScript = setupProjectScript(activeProject.scripts);
        if (setupScript) {
          void runProjectScript(setupScript, {
            cwd: result.worktree.path,
            worktreePath: result.worktree.path,
            rememberAsLastInvoked: false,
          });
        }
      } catch (err) {
        dispatch({
          type: "SET_ERROR",
          threadId: activeThread.id,
          error: err instanceof Error ? err.message : "Failed to create worktree",
        });
        return;
      }
    }

    // Auto-title from first message
    if (activeThread.messages.length === 0) {
      const titleSeed =
        trimmed ||
        (composerImagesSnapshot.length > 0
          ? `Image: ${composerImagesSnapshot[0]?.name ?? "attachment"}`
          : "New thread");
      const title = truncateTitle(titleSeed);
      dispatch({
        type: "SET_THREAD_TITLE",
        threadId: activeThread.id,
        title,
      });
    }

    setThreadError(activeThread.id, null);
    const messageAttachments: ChatImageAttachment[] = composerImagesSnapshot.map((image) => ({
      type: "image",
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    dispatch({
      type: "PUSH_USER_MESSAGE",
      threadId: activeThread.id,
      id: crypto.randomUUID(),
      text: trimmed,
      ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
    });
    const previousMessages = activeThread.messages;
    promptRef.current = "";
    setPrompt("");
    setComposerImages([]);
    setComposerCursor(0);
    setComposerHighlightedItemId(null);

    const sessionInfo = await ensureSession(sessionCwd);
    if (!sessionInfo) return;

    setIsSending(true);
    try {
      const turnAttachments = await Promise.all(
        composerImagesSnapshot.map(
          async (image): Promise<ProviderSendTurnAttachmentInput> => ({
            type: "image",
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: await readFileAsDataUrl(image.file),
          }),
        ),
      );
      const shouldBootstrap =
        previousMessages.length > 0 &&
        (sessionInfo.continuityState === "new" || sessionInfo.continuityState === "fallback_new");
      const latestPromptForBootstrap = trimmed || IMAGE_ONLY_BOOTSTRAP_PROMPT;
      const input = shouldBootstrap
        ? buildBootstrapInput(
            previousMessages,
            latestPromptForBootstrap,
            PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
          ).text
        : trimmed || undefined;
      await api.providers.sendTurn({
        sessionId: sessionInfo.sessionId,
        ...(input ? { input } : {}),
        ...(turnAttachments.length > 0 ? { attachments: turnAttachments } : {}),
        model: selectedModel || undefined,
        effort: selectedEffort || undefined,
      });
    } catch (err) {
      setThreadError(
        activeThread.id,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    } finally {
      setIsSending(false);
    }
  };

  const onInterrupt = async () => {
    if (!api || !activeThread?.session) return;
    await api.providers.interruptTurn({
      sessionId: activeThread.session.sessionId,
      turnId: activeThread.session.activeTurnId,
    });
  };

  const onRespondToApproval = useCallback(
    async (requestId: string, decision: ProviderApprovalDecision) => {
      if (!api || !activeSessionId || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      try {
        await api.providers.respondToRequest({
          sessionId: activeSessionId,
          requestId,
          decision,
        });
      } catch (err) {
        dispatch({
          type: "SET_ERROR",
          threadId: activeThreadId,
          error: err instanceof Error ? err.message : "Failed to submit approval decision.",
        });
      } finally {
        setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
    },
    [activeSessionId, activeThreadId, api, dispatch],
  );

  const onModelSelect = useCallback(
    (model: ModelSlug) => {
      if (!activeThread) return;
      dispatch({
        type: "SET_THREAD_MODEL",
        threadId: activeThread.id,
        model: resolveModelSlug(model),
      });
      scheduleComposerFocus();
    },
    [activeThread, dispatch, scheduleComposerFocus],
  );
  const onEffortSelect = useCallback(
    (effort: ReasoningEffort) => {
      setSelectedEffort(effort);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus],
  );
  const onEnvModeChange = useCallback(
    (mode: "local" | "worktree") => {
      setEnvMode(mode);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus],
  );

  const applyPromptReplacement = useCallback(
    (rangeStart: number, rangeEnd: number, replacement: string) => {
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      promptRef.current = next.text;
      setPrompt(next.text);
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(next.cursor, next.cursor);
        setComposerCursor(next.cursor);
      });
    },
    [],
  );

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (!composerTrigger) return;
      if (item.type === "path") {
        applyPromptReplacement(
          composerTrigger.rangeStart,
          composerTrigger.rangeEnd,
          `@${item.path} `,
        );
        return;
      }
      if (item.type === "slash-command") {
        applyPromptReplacement(composerTrigger.rangeStart, composerTrigger.rangeEnd, "/model ");
        return;
      }
      onModelSelect(item.model);
      applyPromptReplacement(composerTrigger.rangeStart, composerTrigger.rangeEnd, "");
    },
    [applyPromptReplacement, composerTrigger, onModelSelect],
  );
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback((key: "ArrowDown" | "ArrowUp") => {
    const commandInput = composerCommandInputRef.current;
    if (!commandInput) return;
    commandInput.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  }, []);
  const isComposerMenuLoading =
    composerTriggerKind === "path" &&
    ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
      workspaceEntriesQuery.isLoading ||
      workspaceEntriesQuery.isFetching);

  const onPromptChange = useCallback((nextPrompt: string, nextCursor: number) => {
    promptRef.current = nextPrompt;
    setPrompt(nextPrompt);
    setComposerCursor(nextCursor);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composerMenuOpen && composerMenuItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        nudgeComposerMenuHighlight("ArrowDown");
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        nudgeComposerMenuHighlight("ArrowUp");
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        const selectedItem = activeComposerMenuItem ?? composerMenuItems[0];
        if (selectedItem) {
          e.preventDefault();
          onSelectComposerItem(selectedItem);
          return;
        }
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend(e as unknown as FormEvent);
    }
  };
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const onExpandTimelineImage = useCallback((image: ExpandedImagePreview) => {
    setExpandedImage(image);
  }, []);
  const onToggleDiff = useCallback(() => {
    if (state.diffOpen) {
      dispatch({ type: "CLOSE_DIFF" });
      return;
    }

    if (!activeThread) {
      dispatch({ type: "TOGGLE_DIFF" });
      return;
    }

    dispatch({
      type: "OPEN_DIFF",
      threadId: activeThread.id,
    });
  }, [activeThread, dispatch, state.diffOpen]);
  const onOpenTurnDiff = useCallback(
    (turnId: string, filePath?: string) => {
      if (!activeThread) return;
      dispatch({
        type: "OPEN_DIFF",
        threadId: activeThread.id,
        turnId,
        ...(filePath ? { filePath } : {}),
      });
    },
    [activeThread, dispatch],
  );
  const onRevertUserMessage = useCallback(
    (messageId: string) => {
      const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
      if (typeof targetTurnCount !== "number") {
        return;
      }
      void onRevertToTurnCount(targetTurnCount);
    },
    [onRevertToTurnCount, revertTurnCountByUserMessageId],
  );

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">Select a thread or create a new one to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Top bar */}
      <header
        className={`flex items-center justify-between border-b border-border px-5 ${isElectron ? "drag-region h-[52px]" : "py-3"}`}
      >
        <ChatHeader
          activeThreadId={activeThread.id}
          activeThreadTitle={activeThread.title}
          activeProjectName={activeProject?.name}
          activeProjectScripts={activeProject?.scripts}
          preferredScriptId={
            activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
          }
          keybindings={keybindings}
          api={api}
          gitCwd={gitCwd}
          diffOpen={state.diffOpen}
          onRunProjectScript={(script) => {
            void runProjectScript(script);
          }}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onToggleDiff={onToggleDiff}
        />
      </header>

      {/* Error banner */}
      <ThreadErrorBanner error={activeThread.error} />
      <PendingApprovalsPanel
        pendingApprovals={pendingApprovals}
        respondingRequestIds={respondingRequestIds}
        onRespondToApproval={onRespondToApproval}
      />

      {/* Messages */}
      <div
        ref={messagesScrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        onScroll={onMessagesScroll}
      >
        <MessagesTimeline
          hasMessages={activeThread.messages.length > 0}
          isWorking={isWorking}
          timelineEntries={timelineEntries}
          completionDividerBeforeEntryId={completionDividerBeforeEntryId}
          completionSummary={completionSummary}
          assistantCompletionByItemId={assistantCompletionByItemId}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          nowIso={nowIso}
          expandedWorkGroups={expandedWorkGroups}
          onToggleWorkGroup={onToggleWorkGroup}
          onOpenTurnDiff={onOpenTurnDiff}
          revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
          onRevertUserMessage={onRevertUserMessage}
          isRevertingCheckpoint={isRevertingCheckpoint}
          onImageExpand={onExpandTimelineImage}
          messagesEndRef={messagesEndRef}
        />
      </div>

      {/* Input bar */}
      <div className={cn("px-5 pt-2", isGitRepo ? "pb-1" : "pb-4")}>
        <form onSubmit={onSend} className="mx-auto max-w-3xl">
          <div
            className={`group rounded-[20px] border bg-card transition-colors duration-200 focus-within:border-ring ${
              isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border"
            }`}
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
          >
            {/* Textarea area */}
            <div className="relative px-4 pt-4 pb-2">
              {composerMenuOpen && (
                <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                  <ComposerCommandMenu
                    items={composerMenuItems}
                    resolvedTheme={resolvedTheme}
                    isLoading={isComposerMenuLoading}
                    triggerKind={composerTriggerKind}
                    onHighlightedItemChange={onComposerMenuItemHighlighted}
                    onSelect={onSelectComposerItem}
                    commandInputRef={composerCommandInputRef}
                  />
                </div>
              )}

              {composerImages.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {composerImages.map((image) => (
                    <div
                      key={image.id}
                      className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                    >
                      {image.previewUrl ? (
                        <img
                          src={image.previewUrl}
                          alt={image.name}
                          className="h-full w-full cursor-zoom-in object-cover"
                          onClick={() =>
                            setExpandedImage({ src: image.previewUrl, name: image.name })
                          }
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                          {image.name}
                        </div>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                        onClick={() => removeComposerImage(image.id)}
                        aria-label={`Remove ${image.name}`}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground/35 focus:outline-none"
                rows={2}
                value={prompt}
                onChange={(event) =>
                  onPromptChange(
                    event.target.value,
                    event.target.selectionStart ?? event.target.value.length,
                  )
                }
                onKeyDown={onKeyDown}
                onKeyUp={(event) =>
                  setComposerCursor(
                    event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                  )
                }
                onClick={(event) =>
                  setComposerCursor(
                    event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                  )
                }
                onSelect={(event) =>
                  setComposerCursor(
                    event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                  )
                }
                onPaste={onComposerPaste}
                placeholder={
                  phase === "disconnected"
                    ? "Ask for follow-up changes or attach images"
                    : "Ask anything, @tag files/folders, or use /model"
                }
                disabled={isSending || isConnecting}
              />
            </div>

            {/* Bottom toolbar */}
            <div className="flex items-center justify-between px-3 pb-3">
              <div className="flex items-center gap-1">
                {/* Model picker */}
                <ModelPicker model={selectedModel} onModelChange={onModelSelect} />

                {/* Divider */}
                <Separator orientation="vertical" className="mx-0.5 h-4" />

                {/* Reasoning effort */}
                <ReasoningEffortPicker effort={selectedEffort} onEffortChange={onEffortSelect} />

                {/* Divider */}
                <Separator orientation="vertical" className="mx-0.5 h-4" />

                {/* Runtime mode toggle */}
                <Button
                  variant="ghost"
                  className="text-muted-foreground/70 hover:text-foreground/80"
                  size="sm"
                  type="button"
                  disabled={isSwitchingRuntimeMode}
                  onClick={() =>
                    void handleRuntimeModeChange(
                      state.runtimeMode === "full-access" ? "approval-required" : "full-access",
                    )
                  }
                  title={
                    state.runtimeMode === "full-access"
                      ? "Full access — click to require approvals"
                      : "Approval required — click for full access"
                  }
                >
                  {state.runtimeMode === "full-access" ? <LockOpenIcon /> : <LockIcon />}
                  {state.runtimeMode === "full-access" ? "Full access" : "Supervised"}
                </Button>
              </div>

              {/* Right side: send / stop button */}
              <div className="flex items-center gap-2">
                {phase === "running" ? (
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:bg-rose-500 hover:scale-105"
                    onClick={() => void onInterrupt()}
                    aria-label="Stop generation"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <rect x="2" y="2" width="8" height="8" rx="1.5" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/90 text-primary-foreground transition-all duration-150 hover:bg-primary hover:scale-105 disabled:opacity-30 disabled:hover:scale-100"
                    disabled={
                      isSending || isConnecting || (!prompt.trim() && composerImages.length === 0)
                    }
                    aria-label={
                      isConnecting ? "Connecting" : isSending ? "Sending" : "Send message"
                    }
                  >
                    {isConnecting || isSending ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        className="animate-spin"
                        aria-hidden="true"
                      >
                        <circle
                          cx="7"
                          cy="7"
                          r="5.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeDasharray="20 12"
                        />
                      </svg>
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </form>
      </div>

      {isGitRepo && (
        <BranchToolbar
          threadId={activeThread.id}
          envMode={envMode}
          onEnvModeChange={onEnvModeChange}
          envLocked={envLocked}
          onComposerFocusRequest={scheduleComposerFocus}
        />
      )}

      {activeThread.terminalOpen && api && activeProject && (
        <ThreadTerminalDrawer
          key={activeThread.id}
          api={api}
          threadId={activeThread.id}
          cwd={gitCwd ?? activeProject.cwd}
          runtimeEnv={threadTerminalRuntimeEnv}
          height={activeThread.terminalHeight}
          terminalIds={activeThread.terminalIds}
          activeTerminalId={activeThread.activeTerminalId}
          terminalGroups={activeThread.terminalGroups}
          activeTerminalGroupId={activeThread.activeTerminalGroupId}
          focusRequestId={terminalFocusRequestId}
          onSplitTerminal={splitTerminal}
          onNewTerminal={createNewTerminal}
          splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
          newShortcutLabel={newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
          onActiveTerminalChange={activateTerminal}
          onCloseTerminal={closeTerminal}
          onHeightChange={(height) =>
            dispatch({
              type: "SET_THREAD_TERMINAL_HEIGHT",
              threadId: activeThread.id,
              height,
            })
          }
        />
      )}

      {expandedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image preview"
          onClick={() => setExpandedImage(null)}
        >
          <div
            className="relative isolate max-h-[92vh] max-w-[92vw]"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute right-2 top-2"
              onClick={() => setExpandedImage(null)}
              aria-label="Close image preview"
            >
              <XIcon />
            </Button>
            <img
              src={expandedImage.src}
              alt={expandedImage.name}
              className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
              draggable={false}
            />
            <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
              {expandedImage.name}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

interface ChatHeaderProps {
  activeThreadId: string;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  api: NativeApi | undefined;
  gitCwd: string | null;
  diffOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onToggleDiff: () => void;
}

const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectName,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  api,
  gitCwd,
  diffOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onToggleDiff,
}: ChatHeaderProps) {
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <h2 className="truncate text-sm font-medium text-foreground" title={activeThreadTitle}>
          {activeThreadTitle}
        </h2>
        {activeProjectName && <Badge variant="outline">{activeProjectName}</Badge>}
      </div>
      <div className="shrink-0 flex items-center gap-3">
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
          />
        )}
        {activeProjectName && (
          <OpenInPicker keybindings={keybindings} activeThreadId={activeThreadId} />
        )}
        {activeProjectName && (
          <GitActionsControl api={api} gitCwd={gitCwd} activeThreadId={activeThreadId} />
        )}
        <Toggle
          pressed={diffOpen}
          onPressedChange={onToggleDiff}
          aria-label="Toggle diff panel"
          variant="outline"
          size="xs"
        >
          <DiffIcon className="size-3" />
        </Toggle>
      </div>
    </>
  );
});

const ThreadErrorBanner = memo(function ThreadErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription className="line-clamp-3" title={error}>
          {error}
        </AlertDescription>
      </Alert>
    </div>
  );
});

interface PendingApprovalsPanelProps {
  pendingApprovals: PendingApproval[];
  respondingRequestIds: string[];
  onRespondToApproval: (requestId: string, decision: ProviderApprovalDecision) => Promise<void>;
}

const PendingApprovalsPanel = memo(function PendingApprovalsPanel({
  pendingApprovals,
  respondingRequestIds,
  onRespondToApproval,
}: PendingApprovalsPanelProps) {
  if (pendingApprovals.length === 0) return null;
  return (
    <div className="pt-3 mx-auto max-w-3xl space-y-2">
      {pendingApprovals.map((approval) => {
        const isResponding = respondingRequestIds.includes(approval.requestId);

        return (
          <Alert variant="warning" key={approval.requestId}>
            <InfoIcon />
            <AlertTitle className="text-xs">
              {approval.requestKind === "command"
                ? "Command approval requested"
                : "File-change approval requested"}
            </AlertTitle>
            <AlertDescription
              className="truncate block font-mono text-[11px]"
              title={approval.detail}
            >
              {approval.detail}
            </AlertDescription>
            <AlertAction className="col-start-2! -col-end-1! mt-1.5 sm:row-start-auto sm:row-end-auto">
              <Button
                size="xs"
                variant="default"
                disabled={isResponding}
                onClick={() => void onRespondToApproval(approval.requestId, "accept")}
              >
                Approve once
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={isResponding}
                onClick={() => void onRespondToApproval(approval.requestId, "acceptForSession")}
              >
                Always allow this session
              </Button>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={isResponding}
                onClick={() => void onRespondToApproval(approval.requestId, "decline")}
              >
                Decline
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={isResponding}
                onClick={() => void onRespondToApproval(approval.requestId, "cancel")}
              >
                Cancel turn
              </Button>
            </AlertAction>
          </Alert>
        );
      })}
    </div>
  );
});

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  assistantCompletionByItemId: Map<string, string>;
  turnDiffSummaryByAssistantMessageId: Map<string, TurnDiffSummary>;
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: string, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<string, number>;
  onRevertUserMessage: (messageId: string) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (image: ExpandedImagePreview) => void;
  messagesEndRef: RefObject<HTMLDivElement | null>;
}

const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  assistantCompletionByItemId,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  messagesEndRef,
}: MessagesTimelineProps) {
  if (!hasMessages && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {timelineEntries.map((timelineEntry, index) => {
        if (timelineEntry.kind === "work" && timelineEntries[index - 1]?.kind === "work") {
          return null;
        }

        const showCompletionDivider =
          timelineEntry.kind === "message" &&
          timelineEntry.message.role === "assistant" &&
          completionDividerBeforeEntryId === timelineEntry.id;

        if (timelineEntry.kind === "work") {
          const groupedEntries = [timelineEntry.entry];
          let cursor = index + 1;
          while (cursor < timelineEntries.length) {
            const nextEntry = timelineEntries[cursor];
            if (!nextEntry || nextEntry.kind !== "work") break;
            groupedEntries.push(nextEntry.entry);
            cursor += 1;
          }

          const groupId = timelineEntry.id;
          const isExpanded = expandedWorkGroups[groupId] ?? false;
          const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
          const visibleEntries =
            hasOverflow && !isExpanded
              ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
              : groupedEntries;
          const hiddenCount = groupedEntries.length - visibleEntries.length;
          const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
          const groupLabel = onlyToolEntries
            ? groupedEntries.length === 1
              ? "Tool call"
              : `Tool calls (${groupedEntries.length})`
            : groupedEntries.length === 1
              ? "Work event"
              : `Work log (${groupedEntries.length})`;

          return (
            <Fragment key={timelineEntry.id}>
              <div className="rounded-lg border border-border/80 bg-card/45 px-3 py-2">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
                    {groupLabel}
                  </p>
                  {hasOverflow && (
                    <button
                      type="button"
                      className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-muted-foreground/80"
                      onClick={() => onToggleWorkGroup(groupId)}
                    >
                      {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                    </button>
                  )}
                </div>
                <div className="space-y-1">
                  {visibleEntries.map((workEntry) => (
                    <div key={`work-row:${workEntry.id}`} className="flex items-start gap-2 py-0.5">
                      <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
                      <p
                        className={`py-[2px] text-[11px] leading-relaxed ${workToneClass(workEntry.tone)}`}
                      >
                        {workEntry.detail ? (
                          <>
                            {workEntry.label}
                            <span
                              className="ml-1.5 inline-block max-w-[70ch] truncate align-bottom font-mono text-[11px] opacity-60"
                              title={workEntry.detail}
                            >
                              {workEntry.detail}
                            </span>
                          </>
                        ) : (
                          workEntry.label
                        )}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </Fragment>
          );
        }

        if (timelineEntry.message.role === "user") {
          const userImages = timelineEntry.message.attachments ?? [];
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(timelineEntry.message.id);
          return (
            <Fragment key={timelineEntry.id}>
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                  {userImages.length > 0 && (
                    <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                      {userImages.map((image) => (
                        <div
                          key={image.id}
                          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                        >
                          {image.previewUrl ? (
                            <img
                              src={image.previewUrl}
                              alt={image.name}
                              className="h-full max-h-[220px] w-full cursor-zoom-in object-cover"
                              onClick={() =>
                                onImageExpand({ src: image.previewUrl!, name: image.name })
                              }
                            />
                          ) : (
                            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {timelineEntry.message.text && (
                    <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
                      {timelineEntry.message.text}
                    </pre>
                  )}
                  <div className="mt-1.5 flex items-center justify-end gap-2">
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={isRevertingCheckpoint || isWorking}
                        onClick={() => onRevertUserMessage(timelineEntry.message.id)}
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                    <p className="text-right text-[10px] text-muted-foreground/30">
                      {formatTimestamp(timelineEntry.message.createdAt)}
                    </p>
                  </div>
                </div>
              </div>
            </Fragment>
          );
        }

        return (
          <Fragment key={timelineEntry.id}>
            {showCompletionDivider && (
              <div className="my-3 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                  {completionSummary ? `Response • ${completionSummary}` : "Response"}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <div className="px-1 py-0.5">
              <ChatMarkdown
                text={
                  timelineEntry.message.text ||
                  (timelineEntry.message.streaming ? "" : "(empty response)")
                }
              />
              {(() => {
                const turnSummary = turnDiffSummaryByAssistantMessageId.get(
                  timelineEntry.message.id,
                );
                if (!turnSummary) return null;
                const isCheckpointDiffLoading =
                  !turnSummary.checkpointDiffLoaded && turnSummary.files.length === 0;
                const summaryStat = turnSummary.unifiedDiff
                  ? countDiffStat(turnSummary.unifiedDiff)
                  : turnSummary.files.reduce(
                      (acc, file) => {
                        const next =
                          typeof file.additions === "number" && typeof file.deletions === "number"
                            ? { additions: file.additions, deletions: file.deletions }
                            : file.diff
                              ? countDiffStat(file.diff)
                              : null;
                        if (!next) {
                          return acc;
                        }
                        return {
                          additions: acc.additions + next.additions,
                          deletions: acc.deletions + next.deletions,
                        };
                      },
                      { additions: 0, deletions: 0 },
                    );
                const changedFileCountLabel = isCheckpointDiffLoading
                  ? "..."
                  : String(turnSummary.files.length);
                return (
                  <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
                        <span>Changed files ({changedFileCountLabel})</span>
                        {!isCheckpointDiffLoading &&
                          (summaryStat.additions > 0 || summaryStat.deletions > 0) && (
                            <>
                              <span className="mx-1">•</span>
                              <span className="text-success">+{summaryStat.additions}</span>
                              <span className="mx-0.5 text-muted-foreground/70">/</span>
                              <span className="text-destructive">-{summaryStat.deletions}</span>
                            </>
                          )}
                      </p>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          onOpenTurnDiff(turnSummary.turnId, turnSummary.files[0]?.path)
                        }
                      >
                        View diff
                      </Button>
                    </div>
                    {isCheckpointDiffLoading && (
                      <p className="mb-1.5 text-[11px] text-muted-foreground/70">
                        Loading checkpoint diff...
                      </p>
                    )}
                    {turnSummary.files.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {turnSummary.files.map((file) => (
                          <button
                            key={`${turnSummary.turnId}:${file.path}`}
                            type="button"
                            className="rounded-md border border-border/70 bg-background/70 px-2 py-1 font-mono text-[11px] text-muted-foreground/80 transition-colors hover:border-border hover:text-foreground/90"
                            onClick={() => onOpenTurnDiff(turnSummary.turnId, file.path)}
                          >
                            {(() => {
                              const stat =
                                typeof file.additions === "number" &&
                                typeof file.deletions === "number"
                                  ? { additions: file.additions, deletions: file.deletions }
                                  : file.diff
                                    ? countDiffStat(file.diff)
                                    : null;
                              if (!stat) {
                                return file.path;
                              }
                              return (
                                <>
                                  <span>{file.path}</span>
                                  <span className="ml-1 text-muted-foreground/70">(</span>
                                  <span className="text-success">+{stat.additions}</span>
                                  <span className="mx-0.5 text-muted-foreground/70">/</span>
                                  <span className="text-destructive">-{stat.deletions}</span>
                                  <span className="text-muted-foreground/70">)</span>
                                </>
                              );
                            })()}
                          </button>
                        ))}
                      </div>
                    ) : !isCheckpointDiffLoading ? (
                      <p className="text-[11px] text-muted-foreground/70">No changed files.</p>
                    ) : null}
                  </div>
                );
              })()}
              <p className="mt-1.5 text-[10px] text-muted-foreground/30">
                {formatMessageMeta(
                  timelineEntry.message.createdAt,
                  timelineEntry.message.streaming
                    ? formatElapsed(timelineEntry.message.createdAt, nowIso)
                    : formatElapsed(
                        timelineEntry.message.createdAt,
                        assistantCompletionByItemId.get(timelineEntry.message.id),
                      ),
                )}
              </p>
            </div>
          </Fragment>
        );
      })}
      {isWorking && (
        <div className="flex items-center gap-2 py-0.5 pl-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
          <div className="flex items-center pt-1">
            <span className="inline-flex items-center gap-[3px]">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
            </span>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
});

const ModelPicker = memo(function ModelPicker(props: {
  model: ModelSlug;
  onModelChange: (model: ModelSlug) => void;
}) {
  return (
    <Select
      items={MODEL_OPTIONS.map((option) => ({ label: option.name, value: option.slug }))}
      value={props.model}
      onValueChange={(value) => (value ? props.onModelChange(value) : undefined)}
    >
      <SelectTrigger size="sm" variant="ghost">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {MODEL_OPTIONS.map(({ slug, name }) => (
          <SelectItem key={slug} value={slug}>
            {name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
});

const ReasoningEffortPicker = memo(function ReasoningEffortPicker(props: {
  effort: ReasoningEffort;
  onEffortChange: (effort: ReasoningEffort) => void;
}) {
  return (
    <Select
      value={props.effort}
      onValueChange={(value) => (value ? props.onEffortChange(value) : undefined)}
    >
      <SelectTrigger variant="ghost" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {REASONING_OPTIONS.map((effort) => (
          <SelectItem key={effort} value={effort}>
            {effort}
            {effort === DEFAULT_REASONING ? " (default)" : ""}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
});

const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  activeThreadId,
}: {
  keybindings: ResolvedKeybindingsConfig;
  activeThreadId: string | null;
}) {
  const [lastEditor, setLastEditor] = useState<EditorId>(() => {
    const stored = localStorage.getItem(LAST_EDITOR_KEY);
    return EDITORS.some((e) => e.id === stored) ? (stored as EditorId) : EDITORS[0].id;
  });

  const options = [
    {
      label: "Cursor",
      Icon: CursorIcon,
      value: "cursor",
    },
    {
      label: isMacPlatform(navigator.platform)
        ? "Finder"
        : isWindowsPlatform(navigator.platform)
          ? "Explorer"
          : "Files",
      Icon: FolderClosedIcon,
      value: "file-manager",
    },
  ] satisfies { label: string; Icon: Icon; value: EditorId }[];
  const primaryOption = options.find(({ value }) => value === lastEditor);

  const api = useNativeApi();
  const { state } = useStore();
  const activeThread = state.threads.find((t) => t.id === activeThreadId);
  const activeProject = state.projects.find((p) => p.id === activeThread?.projectId);

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      if (!api || !activeProject) return;
      const editor = editorId ?? lastEditor;
      const cwd = activeThread?.worktreePath ?? activeProject.cwd;
      void api.shell.openInEditor(cwd, editor);
      localStorage.setItem(LAST_EDITOR_KEY, editor);
      setLastEditor(editor);
    },
    [api, activeProject, activeThread, lastEditor, setLastEditor],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !activeProject) return;

      e.preventDefault();
      const cwd = activeThread?.worktreePath ?? activeProject.cwd;
      void api.shell.openInEditor(cwd, lastEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [api, activeProject, activeThread, keybindings, lastEditor]);

  return (
    <Group aria-label="Subscription actions">
      <Button size="xs" variant="outline" onClick={() => openInEditor(lastEditor)}>
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="ml-0.5">Open</span>
      </Button>
      <GroupSeparator />
      <Menu>
        <MenuTrigger render={<Button aria-label="Copy options" size="icon-xs" variant="outline" />}>
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <Icon aria-hidden="true" className="text-muted-foreground" />
              {label}
              {value === lastEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
