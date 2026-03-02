import {
  type ApprovalRequestId,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  EDITORS,
  type EditorId,
  type KeybindingCommand,
  type MessageId,
  type ProjectId,
  type ProjectEntry,
  type ProjectScript,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  REASONING_OPTIONS,
  type ReasoningEffort,
  type ResolvedKeybindingsConfig,
  type ProviderApprovalDecision,
  type ThreadId,
  type TurnId,
  normalizeModelSlug,
  resolveModelSlug,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  measureElement as measureVirtualElement,
  type VirtualItem,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { gitBranchesQueryOptions, gitCreateWorktreeMutationOptions } from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";

import { isElectron } from "../env";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import {
  type ComposerTriggerKind,
  detectComposerTrigger,
  replaceTextRange,
} from "../composer-logic";
import {
  derivePendingApprovals,
  derivePhase,
  deriveTimelineEntries,
  type PendingApproval,
  deriveWorkLogEntries,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  formatElapsed,
  formatTimestamp,
} from "../session-logic";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX, isScrollContainerNearBottom } from "../chat-scroll";
import { useStore } from "../store";
import { truncateTitle } from "../truncateTitle";
import {
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_THREAD_TERMINAL_COUNT,
  type ChatMessage,
  type Thread,
  type TurnDiffSummary,
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
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
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
  CopyIcon,
  CheckIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Separator } from "./ui/separator";
import { Group, GroupSeparator } from "./ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { CursorIcon, Icon } from "./Icons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import ProjectScriptsControl, { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "~/projectScripts";
import { Toggle } from "./ui/toggle";
import { SidebarTrigger } from "./ui/sidebar";
import { newCommandId, newMessageId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { getAppModelOptions, useAppSettings } from "../appSettings";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  type DraftThreadState,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../composerDraftStore";
import { clamp } from "effect/Number";

function formatMessageMeta(createdAt: string, duration: string | null): string {
  if (!duration) return formatTimestamp(createdAt);
  return `${formatTimestamp(createdAt)} • ${duration}`;
}

const LAST_EDITOR_KEY = "t3code:last-editor";
const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;
const WORKTREE_BRANCH_PREFIX = "t3code";

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

interface ExpandedImageItem {
  src: string;
  name: string;
}

interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

function buildExpandedImagePreview(
  images: ReadonlyArray<{ id: string; name: string; previewUrl?: string }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    image.previewUrl ? [{ id: image.id, src: image.previewUrl, name: image.name }] : [],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({ src: image.src, name: image.name })),
    index: selectedIndex,
  };
}

function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModel: string,
  error: string | null,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    model: fallbackModel,
    terminalOpen: false,
    terminalHeight: 280,
    terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    runningTerminalIds: [],
    activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
    terminalGroups: [
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ],
    activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    latestTurn: null,
    lastVisitedAt: draftThread.createdAt,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
  };
}

function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
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
      model: string;
      label: string;
      description: string;
    };

type SendPhase = "idle" | "preparing-worktree" | "sending-turn";

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

function buildTemporaryWorktreeBranchName(): string {
  // Keep the 8-hex suffix shape for backend temporary-branch detection.
  const token = crypto.randomUUID().slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

function cloneComposerImageForRetry(image: ComposerImageAttachment): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
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
  commandInputRef: React.RefObject<HTMLInputElement | null>;
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
  threadId: ThreadId;
}

export default function ChatView({ threadId }: ChatViewProps) {
  const { state, dispatch } = useStore();
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerCursor = composerDraft.cursor;
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftCursor = useComposerDraftStore((store) => store.setCursor);
  const setComposerDraftModel = useComposerDraftStore((store) => store.setModel);
  const setComposerDraftEffort = useComposerDraftStore((store) => store.setEffort);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const draftThread = useComposerDraftStore((store) => store.draftThreadsByThreadId[threadId] ?? null);
  const promptRef = useRef(prompt);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [sendPhase, setSendPhase] = useState<SendPhase>("idle");
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [envMode, setEnvMode] = useState<DraftThreadEnvMode>("local");
  const [isSwitchingRuntimeMode, setIsSwitchingRuntimeMode] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useState<
    Record<string, string>
  >(() => readLastInvokedScriptByProjectFromStorage());
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFormHeightRef = useRef(0);
  const composerCommandInputRef = useRef<HTMLInputElement>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const setComposerCursor = useCallback(
    (nextCursor: number) => {
      setComposerDraftCursor(threadId, nextCursor);
    },
    [setComposerDraftCursor, threadId],
  );
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );

  const serverThread = state.threads.find((t) => t.id === threadId);
  const fallbackDraftProject = state.projects.find((project) => project.id === draftThread?.projectId);
  const localDraftError = localDraftErrorsByThreadId[threadId] ?? null;
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.model ?? DEFAULT_MODEL,
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.model, localDraftError, threadId],
  );
  const activeThread = serverThread ?? localDraftThread;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const diffSearch = useMemo(
    () => parseDiffRouteSearch(rawSearch as Record<string, unknown>),
    [rawSearch],
  );
  const diffOpen = diffSearch.diff === "1";
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProject = state.projects.find((p) => p.id === activeThread?.projectId);

  useEffect(() => {
    if (!serverThread) {
      return;
    }
    setLocalDraftErrorsByThreadId((existing) => {
      if (!(threadId in existing)) {
        return existing;
      }
      const { [threadId]: _removed, ...rest } = existing;
      return rest as Record<ThreadId, string | null>;
    });
  }, [serverThread, threadId]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThread.lastVisitedAt ? Date.parse(activeThread.lastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    dispatch({
      type: "MARK_THREAD_VISITED",
      threadId: activeThread.id,
    });
  }, [
    activeThread?.id,
    activeThread?.lastVisitedAt,
    activeLatestTurn?.completedAt,
    latestTurnSettled,
    dispatch,
  ]);

  const baseThreadModel = resolveModelSlug(activeThread?.model ?? activeProject?.model ?? DEFAULT_MODEL);
  const selectedModel = resolveModelSlug(composerDraft.model ?? baseThreadModel);
  const selectedEffort = composerDraft.effort ?? DEFAULT_REASONING;
  const modelOptions = useMemo(
    () => getAppModelOptions(settings.customCodexModels, selectedModel),
    [selectedModel, settings.customCodexModels],
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const isSendBusy = sendPhase !== "idle";
  const isPreparingWorktree = sendPhase === "preparing-worktree";
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  const nowIso = new Date(nowTick).toISOString();
  const threadActivities = activeThread?.activities ?? [];
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const latestTurnHasToolActivity = useMemo(() => {
    return hasToolActivityForTurn(threadActivities, activeLatestTurn?.turnId);
  }, [activeLatestTurn?.turnId, threadActivities]);
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      if (currentPreviewUrls) {
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const { [messageId]: _removed, ...rest } = existing;
        attachmentPreviewHandoffByMessageIdRef.current = rest;
        return rest;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const timelineMessages = useMemo(() => {
    const serverMessages = activeThread?.messages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? serverMessages
        : serverMessages.map((message) => {
            if (message.role !== "user" || !message.attachments || message.attachments.length === 0) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [activeThread?.messages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(timelineMessages, workLogEntries),
    [timelineMessages, workLogEntries],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
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

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!completionSummary) return null;

    const turnStartedAt = Date.parse(activeLatestTurn.startedAt);
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
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
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    completionSummary,
    latestTurnSettled,
    timelineEntries,
  ]);
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
  const branchesQuery = useQuery(gitBranchesQueryOptions(gitCwd));
  const keybindingsQuery = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
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

    return modelOptions
      .map(({ slug, name }) => ({
        slug,
        name,
        searchSlug: slug.toLowerCase(),
        searchName: name.toLowerCase(),
      }))
      .filter(({ searchSlug, searchName }) => {
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) return true;
        return searchSlug.includes(query) || searchName.includes(query);
      })
      .map(({ slug, name }) => ({
        id: `model:${slug}`,
        type: "model" as const,
        model: slug,
        label: name,
        description: slug,
      }));
  }, [composerTrigger, modelOptions, workspaceEntries]);
  const composerMenuOpen = Boolean(composerTrigger);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
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
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle"),
    [keybindings],
  );
  const onToggleDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? rest : { ...rest, diff: "1" };
      },
    });
  }, [diffOpen, navigate, threadId]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const hasReachedTerminalLimit =
    (activeThread?.terminalIds.length ?? 0) >= MAX_THREAD_TERMINAL_COUNT;

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
      const api = readNativeApi();
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
    [activeThread?.terminalIds.length, activeThreadId, dispatch],
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
        allowLocalDraftThread?: boolean;
      },
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (!isServerThread && !options?.allowLocalDraftThread) return;
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
    [activeProject, activeThread, activeThreadId, dispatch, gitCwd, isServerThread],
  );
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
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
    const api = readNativeApi();
    if (!api) return;

    const runningThreadIds = state.threads
      .filter((thread) => thread.session !== null && thread.session.status !== "closed")
      .map((thread) => thread.id);

    if (runningThreadIds.length === 0) return;

    setIsSwitchingRuntimeMode(true);
    try {
      await Promise.all(
        runningThreadIds.map((threadId) =>
          api.orchestration
            .dispatchCommand({
              type: "thread.session.stop",
              commandId: newCommandId(),
              threadId,
              createdAt: new Date().toISOString(),
            })
            .catch(() => undefined),
        ),
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
  const messageCount = timelineMessages.length;
  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
    shouldAutoScrollRef.current = true;
  }, []);
  const scheduleStickToBottom = useCallback(() => {
    if (pendingAutoScrollFrameRef.current !== null) return;
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      scrollMessagesToBottom();
    });
  }, [scrollMessagesToBottom]);
  const onMessagesScroll = useCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    shouldAutoScrollRef.current = isScrollContainerNearBottom(scrollContainer);
  }, []);
  useEffect(() => {
    return () => {
      const frame = pendingAutoScrollFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);
  useLayoutEffect(() => {
    if (!activeThread?.id) return;
    shouldAutoScrollRef.current = true;
    scheduleStickToBottom();
    const timeout = window.setTimeout(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      if (isScrollContainerNearBottom(scrollContainer)) return;
      scheduleStickToBottom();
    }, 96);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [activeThread?.id, scheduleStickToBottom]);
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;

      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThread?.id, scheduleStickToBottom]);
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [messageCount, scheduleStickToBottom]);
  useEffect(() => {
    if (phase !== "running") return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [phase, scheduleStickToBottom, timelineEntries]);

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
    if (!activeThread?.id) {
      clearAttachmentPreviewHandoffs();
      setOptimisticUserMessages((existing) => {
        for (const message of existing) {
          revokeUserMessagePreviewUrls(message);
        }
        return [];
      });
      return;
    }
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    setOptimisticUserMessages((existing) => existing.filter((message) => !serverIds.has(message.id)));
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
  }, [
    activeThread?.id,
    activeThread?.messages,
    clearAttachmentPreviewHandoffs,
    handoffAttachmentPreviews,
    optimisticUserMessages,
  ]);

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    clearAttachmentPreviewHandoffs();
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    setSendPhase("idle");
    setComposerHighlightedItemId(null);
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [clearAttachmentPreviewHandoffs, threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      try {
        const currentPersistedAttachments =
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) {
          return;
        }
        // Stage attachments in persisted draft state first so persist middleware can write them.
        syncComposerDraftPersistedAttachments(threadId, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments =
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) {
          return;
        }
        syncComposerDraftPersistedAttachments(threadId, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  const activeWorktreePath = activeThread?.worktreePath;

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeWorktreePath) {
      setEnvMode("worktree");
      return;
    }
    if (isLocalDraftThread) {
      setEnvMode(draftThread?.envMode ?? "local");
      return;
    }
    setEnvMode("local");
  }, [activeThread?.id, activeWorktreePath, draftThread?.envMode, isLocalDraftThread]);

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

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
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
    onToggleDiff,
    toggleTerminalVisibility,
  ]);

  const setThreadError = useCallback(
    (threadId: ThreadId | null, error: string | null) => {
      if (!threadId) return;
      if (state.threads.some((thread) => thread.id === threadId)) {
        dispatch({
          type: "SET_ERROR",
          threadId,
          error,
        });
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[threadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [threadId]: error,
        };
      });
    },
    [dispatch, state.threads],
  );

  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;

    const nextImages: ComposerImageAttachment[] = [];
    let nextImageCount = composerImagesRef.current.length;
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
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
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
      nextImageCount += 1;
    }

    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
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

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
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

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
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

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (phase === "running" || isSendBusy || isConnecting) {
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
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          createdAt: new Date().toISOString(),
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
    [activeThread, isConnecting, isRevertingCheckpoint, isSendBusy, phase, setThreadError],
  );

  const onSend = async (e: React.SubmitEvent | React.KeyboardEvent) => {
    e.preventDefault();
    const api = readNativeApi();
    if (!api || !activeThread || isSendBusy || isConnecting || sendInFlightRef.current) return;
    const trimmed = prompt.trim();
    if (!trimmed && composerImages.length === 0) return;
    if (!activeProject) return;
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && envMode === "worktree" && !activeThread.worktreePath
        ? activeThread.branch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && envMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThread.branch) {
      dispatch({
        type: "SET_ERROR",
        threadId: threadIdForSend,
        error: "Select a base branch before sending in New worktree mode.",
      });
      return;
    }

    sendInFlightRef.current = true;
    setSendPhase(baseBranchForWorktree ? "preparing-worktree" : "sending-turn");

    const composerImagesSnapshot = [...composerImages];
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: trimmed,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    // Sending a message should always bring the latest user turn into view.
    shouldAutoScrollRef.current = true;
    scheduleStickToBottom();

    setThreadError(threadIdForSend, null);
    promptRef.current = "";
    clearComposerDraftContent(threadIdForSend);
    setComposerHighlightedItemId(null);

    let createdServerThreadForLocalDraft = false;
    let turnStartSucceeded = false;
    let nextThreadBranch = activeThread.branch;
    let nextThreadWorktreePath = activeThread.worktreePath;
    try {
      // On first message: lock in branch + create worktree if needed.
      if (baseBranchForWorktree) {
        setSendPhase("preparing-worktree");
        const newBranch = buildTemporaryWorktreeBranchName();
        const result = await createWorktreeMutation.mutateAsync({
          cwd: activeProject.cwd,
          branch: baseBranchForWorktree,
          newBranch,
        });
        nextThreadBranch = result.worktree.branch;
        nextThreadWorktreePath = result.worktree.path;
        if (isServerThread) {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
          });
          // Keep local thread state in sync immediately so terminal drawer opens
          // with the worktree cwd/env instead of briefly using the project root.
          dispatch({
            type: "SET_THREAD_BRANCH",
            threadId: threadIdForSend,
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
          });
        }
      }

      const titleSeed =
        trimmed ||
        (composerImagesSnapshot.length > 0
          ? `Image: ${composerImagesSnapshot[0]?.name ?? "attachment"}`
          : "New thread");
      const title = truncateTitle(titleSeed);

      if (isLocalDraftThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          projectId: activeProject.id,
          title,
          model: selectedModel ?? activeProject.model ?? DEFAULT_MODEL,
          branch: nextThreadBranch,
          worktreePath: nextThreadWorktreePath,
          createdAt: activeThread.createdAt,
        });
        createdServerThreadForLocalDraft = true;
      }

      const setupScript = baseBranchForWorktree
        ? setupProjectScript(activeProject.scripts)
        : null;
      if (setupScript && (isServerThread || createdServerThreadForLocalDraft)) {
        await runProjectScript(setupScript, {
          worktreePath: nextThreadWorktreePath,
          rememberAsLastInvoked: false,
          allowLocalDraftThread: createdServerThreadForLocalDraft,
          ...(nextThreadWorktreePath ? { cwd: nextThreadWorktreePath } : {}),
        });
      }

      // Auto-title from first message
      if (isFirstMessage && isServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          title,
        });
      }

      setSendPhase("sending-turn");
      const turnAttachments = await turnAttachmentsPromise;
      const approvalPolicy = state.runtimeMode === "full-access" ? "never" : "on-request";
      const sandboxMode =
        state.runtimeMode === "full-access" ? "danger-full-access" : "workspace-write";
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: trimmed || IMAGE_ONLY_BOOTSTRAP_PROMPT,
          attachments: turnAttachments,
        },
        model: selectedModel || undefined,
        effort: selectedEffort || undefined,
        assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
        approvalPolicy,
        sandboxMode,
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
      if (isFirstMessage) {
        clearDraftThread(threadIdForSend);
      }
    } catch (err) {
      if (createdServerThreadForLocalDraft && !turnStartSucceeded) {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: threadIdForSend,
          })
          .catch(() => undefined);
      }
      if (
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = trimmed;
        setPrompt(trimmed);
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageForRetry));
        setComposerCursor(trimmed.length);
      }
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    } finally {
      sendInFlightRef.current = false;
      setSendPhase("idle");
    }
  };

  const onInterrupt = async () => {
    const api = readNativeApi();
    if (!api || !activeThread) return;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
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
    [activeThreadId, dispatch],
  );

  const onModelSelect = useCallback(
    (model: string) => {
      const normalizedModel = normalizeModelSlug(model);
      const resolvedModel = normalizedModel ?? baseThreadModel;
      setComposerDraftModel(threadId, resolvedModel === baseThreadModel ? null : resolvedModel);
      const api = readNativeApi();
      if (api && isServerThread && activeThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThread.id,
          model: resolvedModel,
        });
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      baseThreadModel,
      isServerThread,
      scheduleComposerFocus,
      setComposerDraftModel,
      threadId,
    ],
  );
  const onEffortSelect = useCallback(
    (effort: ReasoningEffort) => {
      setComposerDraftEffort(threadId, effort);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setComposerDraftEffort, threadId],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      setEnvMode(mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { envMode: mode });
      }
      scheduleComposerFocus();
    },
    [isLocalDraftThread, scheduleComposerFocus, setDraftThreadContext, threadId],
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
    [setComposerCursor, setPrompt],
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
  }, [setComposerCursor, setPrompt]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      void onSend(e);
    }
  };
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return filePath
            ? { ...rest, diff: "1", diffTurnId: turnId, diffFilePath: filePath }
            : { ...rest, diff: "1", diffTurnId: turnId };
        },
      });
    },
    [navigate, threadId],
  );
  const onRevertUserMessage = useCallback(
    (messageId: MessageId) => {
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
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">Threads</span>
            </div>
          </header>
        )}
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      {/* Top bar */}
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
        )}
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
          diffToggleShortcutLabel={diffPanelShortcutLabel}
          gitCwd={gitCwd}
          diffOpen={diffOpen}
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
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
        onScroll={onMessagesScroll}
      >
        <MessagesTimeline
          key={activeThread.id}
          hasMessages={timelineMessages.length > 0}
          isWorking={isWorking}
          activeTurnInProgress={!latestTurnSettled}
          activeTurnStartedAt={activeLatestTurn?.startedAt ?? null}
          scrollContainerRef={messagesScrollRef}
          timelineEntries={timelineEntries}
          completionDividerBeforeEntryId={completionDividerBeforeEntryId}
          completionSummary={completionSummary}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          nowIso={nowIso}
          expandedWorkGroups={expandedWorkGroups}
          onToggleWorkGroup={onToggleWorkGroup}
          onOpenTurnDiff={onOpenTurnDiff}
          revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
          onRevertUserMessage={onRevertUserMessage}
          isRevertingCheckpoint={isRevertingCheckpoint}
          onImageExpand={onExpandTimelineImage}
          markdownCwd={gitCwd ?? undefined}
        />
      </div>

      {/* Input bar */}
      <div className={cn("px-3 pt-1.5 sm:px-5 sm:pt-2", isGitRepo ? "pb-1" : "pb-3 sm:pb-4")}>
        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className="mx-auto w-full min-w-fit max-w-3xl"
          data-chat-composer-form="true"
        >
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
            <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
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
                          onClick={() => {
                            const preview = buildExpandedImagePreview(composerImages, image.id);
                            if (!preview) return;
                            setExpandedImage(preview);
                          }}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                          {image.name}
                        </div>
                      )}
                      {nonPersistedComposerImageIdSet.has(image.id) && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span
                                role="img"
                                aria-label="Draft attachment may not persist"
                                className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                              >
                                <CircleAlertIcon className="size-3" />
                              </span>
                            }
                          />
                          <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
                            Draft attachment could not be saved locally and may be lost on navigation.
                          </TooltipPopup>
                        </Tooltip>
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
                disabled={isConnecting}
              />
            </div>

            {/* Bottom toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 pb-2.5 sm:flex-nowrap sm:gap-0 sm:px-3 sm:pb-3">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible">
                {/* Model picker */}
                <ModelPicker
                  model={selectedModel}
                  options={modelOptions}
                  onModelChange={onModelSelect}
                />

                {/* Divider */}
                <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                {/* Reasoning effort */}
                <ReasoningEffortPicker effort={selectedEffort} onEffortChange={onEffortSelect} />

                {/* Divider */}
                <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                {/* Runtime mode toggle */}
                <Button
                  variant="ghost"
                  className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
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
                  <span className="sr-only sm:not-sr-only">
                    {state.runtimeMode === "full-access" ? "Full access" : "Supervised"}
                  </span>
                </Button>
              </div>

              {/* Right side: send / stop button */}
              <div className="flex shrink-0 items-center gap-2">
                {isPreparingWorktree ? (
                  <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
                ) : null}
                {phase === "running" ? (
                  <button
                    type="button"
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:bg-rose-500 hover:scale-105 sm:h-8 sm:w-8"
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
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/90 text-primary-foreground transition-all duration-150 hover:bg-primary hover:scale-105 disabled:opacity-30 disabled:hover:scale-100 sm:h-8 sm:w-8"
                    disabled={
                      isSendBusy || isConnecting || (!prompt.trim() && composerImages.length === 0)
                    }
                    aria-label={
                      isConnecting
                        ? "Connecting"
                        : isPreparingWorktree
                          ? "Preparing worktree"
                          : isSendBusy
                            ? "Sending"
                            : "Send message"
                    }
                  >
                    {isConnecting || isSendBusy ? (
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

      {(() => {
        if (!activeThread.terminalOpen || !activeProject) {
          return null;
        }
        return (
          <ThreadTerminalDrawer
            key={activeThread.id}
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
        );
      })()}

      {expandedImage && expandedImageItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image preview"
          onClick={closeExpandedImage}
        >
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute left-2 top-1/2 z-10 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
              aria-label="Previous image"
              onClick={(event) => {
                event.stopPropagation();
                navigateExpandedImage(-1);
              }}
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
          )}
          <div
            className="relative isolate max-h-[92vh] max-w-[92vw]"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute right-2 top-2"
              onClick={closeExpandedImage}
              aria-label="Close image preview"
            >
              <XIcon />
            </Button>
            <img
              src={expandedImageItem.src}
              alt={expandedImageItem.name}
              className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
              draggable={false}
            />
            <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
              {expandedImageItem.name}
              {expandedImage.images.length > 1
                ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
                : ""}
            </p>
          </div>
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-2 top-1/2 z-10 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
              aria-label="Next image"
              onClick={(event) => {
                event.stopPropagation();
                navigateExpandedImage(1);
              }}
            >
              <ChevronRightIcon className="size-5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  diffToggleShortcutLabel: string | null;
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
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onToggleDiff,
}: ChatHeaderProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="max-w-28 shrink-0 truncate">
            {activeProjectName}
          </Badge>
        )}
      </div>
      <div className="@container/header-actions flex min-w-0 flex-1 items-center justify-end gap-2 @sm/header-actions:gap-3">
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
        {activeProjectName && <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {diffToggleShortcutLabel
              ? `Toggle diff panel (${diffToggleShortcutLabel})`
              : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
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
  respondingRequestIds: ApprovalRequestId[];
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
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

const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <Button type="button" size="xs" variant="outline" onClick={handleCopy} title="Copy message">
      {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
}

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type TimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: TimelineWorkEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      showCompletionDivider: boolean;
    }
  | { kind: "working"; id: string; createdAt: string | null };

function estimateTimelineMessageHeight(message: TimelineMessage): number {
  const textLength = message.text.length;
  if (message.role === "assistant") {
    const estimatedLines = Math.max(1, Math.ceil(textLength / 72));
    return 78 + Math.min(estimatedLines * 22, 820);
  }

  const estimatedLines = Math.max(1, Math.ceil(textLength / 56));
  const attachmentCount = message.attachments?.length ?? 0;
  const attachmentRows = Math.ceil(attachmentCount / 2);
  const attachmentHeight = attachmentRows * 124;
  return 96 + Math.min(estimatedLines * 22, 620) + attachmentHeight;
}

const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  scrollContainerRef,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
}: MessagesTimelineProps) {
  const rows = useMemo<TimelineRow[]>(() => {
    const nextRows: TimelineRow[] = [];

    for (let index = 0; index < timelineEntries.length; index += 1) {
      const timelineEntry = timelineEntries[index];
      if (!timelineEntry) {
        continue;
      }

      if (timelineEntry.kind === "work") {
        const groupedEntries = [timelineEntry.entry];
        let cursor = index + 1;
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (!nextEntry || nextEntry.kind !== "work") break;
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries,
        });
        index = cursor - 1;
        continue;
      }

      nextRows.push({
        kind: "message",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        showCompletionDivider:
          timelineEntry.message.role === "assistant" &&
          completionDividerBeforeEntryId === timelineEntry.id,
      });
    }

    if (isWorking) {
      nextRows.push({
        kind: "working",
        id: "working-indicator-row",
        createdAt: activeTurnStartedAt,
      });
    }

    return nextRows;
  }, [timelineEntries, completionDividerBeforeEntryId, isWorking, activeTurnStartedAt]);

  const firstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
    if (!activeTurnInProgress) return firstTailRowIndex;

    const turnStartedAtMs =
      typeof activeTurnStartedAt === "string" ? Date.parse(activeTurnStartedAt) : Number.NaN;
    let firstCurrentTurnRowIndex = -1;
    if (!Number.isNaN(turnStartedAtMs)) {
      firstCurrentTurnRowIndex = rows.findIndex((row) => {
        if (row.kind === "working") return true;
        if (!row.createdAt) return false;
        const rowCreatedAtMs = Date.parse(row.createdAt);
        return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
      });
    }

    if (firstCurrentTurnRowIndex < 0) {
      firstCurrentTurnRowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.message.streaming,
      );
    }

    if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

    for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
      const previousRow = rows[index];
      if (!previousRow || previousRow.kind !== "message") continue;
      if (previousRow.message.role === "user") {
        return Math.min(index, firstTailRowIndex);
      }
      if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
        break;
      }
    }

    return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
  }, [activeTurnInProgress, activeTurnStartedAt, rows]);

  const virtualizedRowCount = clamp(firstUnvirtualizedRowIndex, {
    minimum: 0,
    maximum: rows.length,
  });

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainerRef.current,
    // Use stable row ids so virtual measurements do not leak across thread switches.
    getItemKey: (index: number) => rows[index]?.id ?? index,
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      if (row.kind === "work") return 112;
      if (row.kind === "working") return 40;
      return estimateTimelineMessageHeight(row.message);
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const onTimelineImageLoad = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);
  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);

  const renderRowContent = (row: TimelineRow) => (
    <div className="pb-4">
      {row.kind === "work" &&
        (() => {
          const groupId = row.id;
          const groupedEntries = row.groupedEntries;
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
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
          return (
            <div className="flex justify-end">
              <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                {userImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {userImages.map(
                      (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                        <div
                          key={image.id}
                          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                        >
                          {image.previewUrl ? (
                            <img
                              src={image.previewUrl}
                              alt={image.name}
                              className="h-full max-h-[220px] w-full cursor-zoom-in object-cover"
                              onLoad={onTimelineImageLoad}
                              onError={onTimelineImageLoad}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(userImages, image.id);
                                if (!preview) return;
                                onImageExpand(preview);
                              }}
                            />
                          ) : (
                            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
                {row.message.text && (
                  <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
                    {row.message.text}
                  </pre>
                )}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {row.message.text && <MessageCopyButton text={row.message.text} />}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={isRevertingCheckpoint || isWorking}
                        onClick={() => onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-[10px] text-muted-foreground/30">
                    {formatTimestamp(row.message.createdAt)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                    {completionSummary ? `Response • ${completionSummary}` : "Response"}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="min-w-0 px-1 py-0.5">
                <ChatMarkdown
                  text={messageText}
                  cwd={markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                />
                {(() => {
                  const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                  if (!turnSummary) return null;
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) return null;
                  const summaryStat = checkpointFiles.reduce(
                    (acc, file) => {
                      if (
                        typeof file.additions !== "number" ||
                        typeof file.deletions !== "number"
                      ) {
                        return acc;
                      }
                      return {
                        additions: acc.additions + file.additions,
                        deletions: acc.deletions + file.deletions,
                      };
                    },
                    { additions: 0, deletions: 0 },
                  );
                  const changedFileCountLabel = String(checkpointFiles.length);
                  return (
                    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
                          <span>Changed files ({changedFileCountLabel})</span>
                          {(summaryStat.additions > 0 || summaryStat.deletions > 0) && (
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
                            onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)
                          }
                        >
                          View diff
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {checkpointFiles.map((file) => (
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
                                  ? {
                                      additions: file.additions,
                                      deletions: file.deletions,
                                    }
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
                    </div>
                  );
                })()}
                <p className="mt-1.5 text-[10px] text-muted-foreground/30">
                  {formatMessageMeta(
                    row.message.createdAt,
                    row.message.streaming
                      ? formatElapsed(row.message.createdAt, nowIso)
                      : formatElapsed(row.message.createdAt, row.message.completedAt),
                  )}
                </p>
              </div>
            </>
          );
        })()}

      {row.kind === "working" && (
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
    </div>
  );

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
    <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden">
      {virtualizedRowCount > 0 && (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow: VirtualItem) => {
            const row = rows[virtualRow.index];
            if (!row) return null;

            return (
              <div
                key={`virtual-row:${row.id}`}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRowContent(row)}
              </div>
            );
          })}
        </div>
      )}

      {nonVirtualizedRows.map((row) => (
        <div key={`non-virtual-row:${row.id}`}>{renderRowContent(row)}</div>
      ))}
    </div>
  );
});

const ModelPicker = memo(function ModelPicker(props: {
  model: string;
  options: ReadonlyArray<{ slug: string; name: string }>;
  onModelChange: (model: string) => void;
}) {
  return (
    <Select
      items={props.options.map((option) => ({ label: option.name, value: option.slug }))}
      value={props.model}
      onValueChange={(value) => (value ? props.onModelChange(value) : undefined)}
    >
      <SelectTrigger size="sm" variant="ghost">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {props.options.map(({ slug, name }) => (
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
  activeThreadId: ThreadId | null;
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

  const { state } = useStore();
  const activeThread = state.threads.find((t) => t.id === activeThreadId);
  const activeProject = state.projects.find((p) => p.id === activeThread?.projectId);

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readNativeApi();
      if (!api || !activeProject) return;
      const editor = editorId ?? lastEditor;
      const cwd = activeThread?.worktreePath ?? activeProject.cwd;
      void api.shell.openInEditor(cwd, editor);
      localStorage.setItem(LAST_EDITOR_KEY, editor);
      setLastEditor(editor);
    },
    [activeProject, activeThread, lastEditor, setLastEditor],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const api = readNativeApi();
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !activeProject) return;

      e.preventDefault();
      const cwd = activeThread?.worktreePath ?? activeProject.cwd;
      void api.shell.openInEditor(cwd, lastEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeProject, activeThread, keybindings, lastEditor]);

  return (
    <Group aria-label="Subscription actions">
      <Button size="xs" variant="outline" onClick={() => openInEditor(lastEditor)}>
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only @sm/header-actions:not-sr-only @sm/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @sm/header-actions:block" />
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
