import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderSendTurnAttachmentInput,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { EDITORS, type EditorId } from "@t3tools/contracts";
import { isElectron } from "../env";
import { buildBootstrapInput } from "../historyBootstrap";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  MODEL_OPTIONS,
  REASONING_OPTIONS,
  resolveModelSlug,
} from "../model-logic";
import {
  derivePendingApprovals,
  derivePhase,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatDuration,
  formatElapsed,
  formatTimestamp,
} from "../session-logic";
import { useStore } from "../store";
import type { ChatImageAttachment } from "../types";
import BranchToolbar from "./BranchToolbar";
import GitActionsControl from "./GitActionsControl";
import { isTerminalToggleShortcut } from "../terminal-shortcuts";
import ChatMarkdown from "./ChatMarkdown";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { useNativeApi } from "../hooks/useNativeApi";

function formatMessageMeta(createdAt: string, duration: string | null): string {
  if (!duration) return formatTimestamp(createdAt);
  return `${formatTimestamp(createdAt)} • ${duration}`;
}

const FILE_MANAGER_LABEL = navigator.platform.includes("Mac")
  ? "Finder"
  : navigator.platform.includes("Win")
    ? "Explorer"
    : "Files";

function editorLabel(editor: (typeof EDITORS)[number]): string {
  return editor.command ? editor.label : FILE_MANAGER_LABEL;
}

const LAST_EDITOR_KEY = "t3code:last-editor";
const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

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

export default function ChatView() {
  const { state, dispatch } = useStore();
  const api = useNativeApi();
  const [prompt, setPrompt] = useState("");
  const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isEditorMenuOpen, setIsEditorMenuOpen] = useState(false);
  const [lastEditor, setLastEditor] = useState<EditorId>(() => {
    const stored = localStorage.getItem(LAST_EDITOR_KEY);
    return EDITORS.some((e) => e.id === stored) ? (stored as EditorId) : EDITORS[0].id;
  });
  const [selectedEffort, setSelectedEffort] = useState<string>(DEFAULT_REASONING);
  const [envMode, setEnvMode] = useState<"local" | "worktree">("local");
  const [isSwitchingRuntimeMode, setIsSwitchingRuntimeMode] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<string[]>([]);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const dragDepthRef = useRef(0);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const editorMenuRef = useRef<HTMLDivElement>(null);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});

  const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
  const activeThreadId = activeThread?.id ?? null;
  const activeProject = state.projects.find((p) => p.id === activeThread?.projectId);
  const selectedModel = resolveModelSlug(
    activeThread?.model ?? activeProject?.model ?? DEFAULT_MODEL,
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const isWorking = phase === "running" || isSending || isConnecting;
  const nowIso = new Date(nowTick).toISOString();
  const modelOptions = MODEL_OPTIONS;
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
  const runtimeSessionConfig =
    state.runtimeMode === "full-access"
      ? ({
          approvalPolicy: "never",
          sandboxMode: "danger-full-access",
        } as const)
      : ({
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
        } as const);
  const gitCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
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
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    const isOpen = Boolean(activeThread?.terminalOpen);
    dispatch({
      type: "SET_THREAD_TERMINAL_OPEN",
      threadId: activeThreadId,
      open: !isOpen,
    });
  }, [activeThread?.terminalOpen, activeThreadId, dispatch]);
  const splitTerminal = useCallback(() => {
    if (!activeThreadId) return;
    dispatch({
      type: "SPLIT_THREAD_TERMINAL",
      threadId: activeThreadId,
      terminalId: `terminal-${crypto.randomUUID()}`,
    });
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, dispatch]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    dispatch({
      type: "NEW_THREAD_TERMINAL",
      threadId: activeThreadId,
      terminalId: `terminal-${crypto.randomUUID()}`,
    });
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, dispatch]);
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
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      const fallbackClearAndExit = () =>
        api.terminal
          .clear({ threadId: activeThreadId, terminalId })
          .catch(() => undefined)
          .then(() => fallbackExitWrite())
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void api.terminal
          .close({ threadId: activeThreadId, terminalId, deleteHistory: true })
          .catch(() => fallbackClearAndExit());
      } else {
        void fallbackClearAndExit();
      }
      dispatch({
        type: "CLOSE_THREAD_TERMINAL",
        threadId: activeThreadId,
        terminalId,
      });
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, api, dispatch],
  );

  const handleRuntimeModeChange = async (mode: "approval-required" | "full-access") => {
    if (mode === state.runtimeMode) return;
    dispatch({ type: "SET_RUNTIME_MODE", mode });
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

  // Auto-scroll on new messages
  const messageCount = activeThread?.messages.length ?? 0;
  const workLogCount = workLogEntries.length;
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);
  useEffect(() => {
    if (phase !== "running") return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [phase, workLogCount]);

  useEffect(() => {
    setExpandedWorkGroups({});
  }, [activeThread?.id]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    setComposerImages((existing) => {
      revokePreviewUrls(existing);
      return [];
    });
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [activeThread?.id, revokePreviewUrls]);

  useEffect(() => {
    return () => {
      revokePreviewUrls(composerImagesRef.current);
    };
  }, [revokePreviewUrls]);

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      setExpandedImage(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
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
    }, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase]);

  useEffect(() => {
    if (!isModelMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!modelMenuRef.current) return;
      if (event.target instanceof Node && !modelMenuRef.current.contains(event.target)) {
        setIsModelMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isModelMenuOpen]);

  useEffect(() => {
    if (!isEditorMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!editorMenuRef.current) return;
      if (event.target instanceof Node && !editorMenuRef.current.contains(event.target)) {
        setIsEditorMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isEditorMenuOpen]);

  // Cmd+O / Ctrl+O to open in last-used editor
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === "o" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        if (api && activeProject) {
          e.preventDefault();
          const cwd = activeThread?.worktreePath ?? activeProject.cwd;
          void api.shell.openInEditor(cwd, lastEditor);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [api, activeProject, activeThread, lastEditor]);

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
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId) return;
      if (!isTerminalToggleShortcut(event)) return;
      event.preventDefault();
      toggleTerminalVisibility();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeThreadId, toggleTerminalVisibility]);

  const openInEditor = (editorId: EditorId) => {
    if (!api || !activeProject) return;
    const cwd = activeThread?.worktreePath ?? activeProject.cwd;
    void api.shell.openInEditor(cwd, editorId);
    setLastEditor(editorId);
    localStorage.setItem(LAST_EDITOR_KEY, editorId);
    setIsEditorMenuOpen(false);
  };

  const setThreadError = (threadId: string | null, error: string | null) => {
    if (!threadId) return;
    dispatch({
      type: "SET_ERROR",
      threadId,
      error,
    });
  };

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

  const openImageDialog = (src: string | undefined, name: string) => {
    if (!src) {
      return;
    }
    setExpandedImage({ src, name });
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

  const ensureSession = async (cwdOverride?: string): Promise<EnsuredSessionInfo | null> => {
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
        approvalPolicy: runtimeSessionConfig.approvalPolicy,
        sandboxMode: runtimeSessionConfig.sandboxMode,
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
  };

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
        const result = await api.git.createWorktree({
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
      const title = titleSeed.length > 50 ? `${titleSeed.slice(0, 50)}...` : titleSeed;
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
    setPrompt("");
    setComposerImages([]);

    const sessionInfo = await ensureSession(sessionCwd);
    if (!sessionInfo) return;

    setIsSending(true);
    try {
      const turnAttachments = await Promise.all(
        composerImagesSnapshot.map(async (image): Promise<ProviderSendTurnAttachmentInput> => ({
          type: "image",
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: await readFileAsDataUrl(image.file),
        })),
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
        : (trimmed || undefined);
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

  const onRespondToApproval = async (requestId: string, decision: ProviderApprovalDecision) => {
    if (!api || !activeThread?.session) return;

    setRespondingRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    try {
      await api.providers.respondToRequest({
        sessionId: activeThread.session.sessionId,
        requestId,
        decision,
      });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        threadId: activeThread.id,
        error: err instanceof Error ? err.message : "Failed to submit approval decision.",
      });
    } finally {
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    }
  };

  const onModelSelect = (model: string) => {
    if (!activeThread) return;
    dispatch({
      type: "SET_THREAD_MODEL",
      threadId: activeThread.id,
      model: resolveModelSlug(model),
    });
    setIsModelMenuOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend(e as unknown as FormEvent);
    }
  };

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-background text-muted-foreground/40">
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
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* Top bar */}
      <header
        className={`flex items-center justify-between border-b border-border px-5 ${isElectron ? "drag-region h-[52px]" : "py-3"}`}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-foreground">{activeThread.title}</h2>
          {activeProject && (
            <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] text-muted-foreground/50">
              {activeProject.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Open in editor */}
          {activeProject && (
            <div className="relative" ref={editorMenuRef}>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[10px] text-muted-foreground/40 transition-colors duration-150 hover:text-muted-foreground/60"
                onClick={() => setIsEditorMenuOpen((v) => !v)}
              >
                Open in&hellip;
              </button>
              {isEditorMenuOpen && (
                <div className="absolute right-0 top-full z-50 mt-1 min-w-[120px] rounded-md border border-border bg-popover py-1 shadow-xl">
                  {EDITORS.map((editor) => (
                    <button
                      key={editor.id}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
                      onClick={() => openInEditor(editor.id)}
                    >
                      {editorLabel(editor)}
                      {editor.id === lastEditor && (
                        <kbd className="ml-auto text-[9px] text-muted-foreground/40">
                          {navigator.platform.includes("Mac") ? "\u2318O" : "Ctrl+O"}
                        </kbd>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Git actions */}
          {activeProject && <GitActionsControl api={api} gitCwd={gitCwd} />}

          {/* Diff toggle */}
          <button
            type="button"
            className={`rounded-md px-2 py-1 text-[10px] transition-colors duration-150 ${
              state.diffOpen
                ? "bg-accent text-foreground"
                : "text-muted-foreground/40 hover:text-muted-foreground/60"
            }`}
            onClick={() => dispatch({ type: "TOGGLE_DIFF" })}
          >
            Diff
          </button>
        </div>
      </header>

      {/* Error banner */}
      {activeThread.error && (
        <div className="mx-4 mt-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {activeThread.error}
        </div>
      )}

      {pendingApprovals.length > 0 && (
        <div className="px-5 pt-3">
          <div className="mx-auto max-w-3xl space-y-2">
            {pendingApprovals.map((approval) => {
              const isResponding = respondingRequestIds.includes(approval.requestId);
              return (
                <div
                  key={approval.requestId}
                  className="rounded-lg border border-amber-300/40 bg-amber-50 px-3 py-2 dark:border-amber-300/20 dark:bg-amber-500/[0.07]"
                >
                  <p className="text-xs font-medium text-amber-900 dark:text-amber-100">
                    {approval.requestKind === "command"
                      ? "Command approval requested"
                      : "File-change approval requested"}
                  </p>
                  {approval.detail && (
                    <p
                      className="mt-1 truncate font-mono text-[11px] text-amber-900/80 dark:text-amber-100/75"
                      title={approval.detail}
                    >
                      {approval.detail}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="rounded-md border border-border bg-accent px-2 py-1 text-[11px] text-foreground transition-colors duration-150 hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isResponding}
                      onClick={() => void onRespondToApproval(approval.requestId, "accept")}
                    >
                      Approve once
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-sky-300/70 bg-sky-100 px-2 py-1 text-[11px] text-sky-800 transition-colors duration-150 hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-300/30 dark:bg-sky-500/15 dark:text-sky-100 dark:hover:bg-sky-500/22"
                      disabled={isResponding}
                      onClick={() =>
                        void onRespondToApproval(approval.requestId, "acceptForSession")
                      }
                    >
                      Always allow this session
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground/90 transition-colors duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isResponding}
                      onClick={() => void onRespondToApproval(approval.requestId, "decline")}
                    >
                      Decline
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-rose-300/70 bg-rose-100 px-2 py-1 text-[11px] text-rose-800 transition-colors duration-150 hover:bg-rose-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-300/30 dark:bg-rose-500/12 dark:text-rose-100 dark:hover:bg-rose-500/20"
                      disabled={isResponding}
                      onClick={() => void onRespondToApproval(approval.requestId, "cancel")}
                    >
                      Cancel turn
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {activeThread.messages.length === 0 && !isWorking ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground/30">
              Send a message to start the conversation.
            </p>
          </div>
        ) : (
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
                            onClick={() =>
                              setExpandedWorkGroups((existing) => ({
                                ...existing,
                                [groupId]: !existing[groupId],
                              }))
                            }
                          >
                            {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                          </button>
                        )}
                      </div>
                      <div className="space-y-1">
                        {visibleEntries.map((workEntry) => (
                          <div
                            key={`work-row:${workEntry.id}`}
                            className="flex items-start gap-2 py-0.5"
                          >
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
                                    onClick={() => openImageDialog(image.previewUrl, image.name)}
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
                          <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground">
                            {timelineEntry.message.text}
                          </pre>
                        )}
                        <p className="mt-1.5 text-right text-[10px] text-muted-foreground/30">
                          {formatTimestamp(timelineEntry.message.createdAt)}
                        </p>
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
        )}
      </div>

      {/* Input bar */}
      <div className="px-5 pb-1 pt-2">
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
            <div className="px-4 pt-4 pb-2">
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
                          onClick={() => openImageDialog(image.previewUrl, image.name)}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                          {image.name}
                        </div>
                      )}
                      <button
                        type="button"
                        className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-background/80 text-[11px] leading-none text-foreground transition-colors duration-150 hover:bg-background"
                        onClick={() => removeComposerImage(image.id)}
                        aria-label={`Remove ${image.name}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground/35 focus:outline-none"
                rows={2}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onComposerPaste}
                placeholder={
                  phase === "disconnected"
                    ? "Ask for follow-up changes or attach images"
                    : "Ask anything, or attach images..."
                }
                disabled={isSending || isConnecting}
              />
            </div>

            {/* Bottom toolbar */}
            <div className="flex items-center justify-between px-3 pb-3">
              <div className="flex items-center gap-1">
                {/* Model picker */}
                <div className="relative" ref={modelMenuRef}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground/70 transition-colors duration-150 hover:bg-accent hover:text-foreground/80"
                    onClick={() => setIsModelMenuOpen((open) => !open)}
                  >
                    <span className="max-w-[180px] truncate">{selectedModel}</span>
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      className="opacity-50"
                      aria-hidden="true"
                    >
                      <path
                        d="M2.5 4L5 6.5L7.5 4"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {isModelMenuOpen && (
                    <div className="absolute bottom-full left-0 z-20 mb-2 w-[320px] rounded-2xl border border-border bg-popover/95 p-2 shadow-[0_16px_40px_rgba(0,0,0,0.55)] backdrop-blur">
                      <p className="px-2 py-1 text-[11px] text-muted-foreground/70">Select model</p>
                      <div className="max-h-72 overflow-y-auto">
                        {modelOptions.map((model) => {
                          const isSelected = model === selectedModel;
                          return (
                            <button
                              key={model}
                              type="button"
                              className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-xl px-2 py-2 text-left font-mono text-sm transition-colors duration-150 ${
                                isSelected
                                  ? "bg-accent text-foreground"
                                  : "text-foreground/90 hover:bg-accent"
                              }`}
                              onClick={() => onModelSelect(model)}
                            >
                              <span className="truncate">{model}</span>
                              <span
                                className={`pt-0.5 text-sm ${
                                  isSelected ? "text-foreground" : "text-transparent"
                                }`}
                              >
                                ✓
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Divider */}
                <div className="mx-0.5 h-4 w-px bg-border" />

                {/* Reasoning effort */}
                <label
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground/70 transition-colors duration-150 hover:bg-accent hover:text-foreground/80"
                  htmlFor="reasoning-effort"
                >
                  <span>{selectedEffort.charAt(0).toUpperCase() + selectedEffort.slice(1)}</span>
                  <select
                    id="reasoning-effort"
                    className="absolute opacity-0 w-0 h-0"
                    value={selectedEffort}
                    onChange={(event) => setSelectedEffort(event.target.value)}
                  >
                    {REASONING_OPTIONS.map((effort) => (
                      <option key={effort} value={effort} className="bg-popover">
                        {effort}
                        {effort === DEFAULT_REASONING ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    className="opacity-50"
                    aria-hidden="true"
                  >
                    <path
                      d="M2.5 4L5 6.5L7.5 4"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </label>

                {/* Divider */}
                <div className="mx-0.5 h-4 w-px bg-border" />

                {/* Runtime mode toggle */}
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground/70 transition-colors duration-150 hover:bg-accent hover:text-foreground/80"
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
                  {state.runtimeMode === "full-access" ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <rect
                        x="2"
                        y="5.5"
                        width="10"
                        height="7"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                      <path
                        d="M9.5 5.5V4a2.5 2.5 0 0 0-5 0"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <rect
                        x="2"
                        y="5.5"
                        width="10"
                        height="7"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                      <path
                        d="M4.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                  <span>{state.runtimeMode === "full-access" ? "Full access" : "Supervised"}</span>
                </button>
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
                    disabled={isSending || isConnecting || (!prompt.trim() && composerImages.length === 0)}
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

      <BranchToolbar envMode={envMode} onEnvModeChange={setEnvMode} envLocked={envLocked} />

      {activeThread.terminalOpen && api && activeProject && (
        <ThreadTerminalDrawer
          key={activeThread.id}
          api={api}
          threadId={activeThread.id}
          cwd={gitCwd ?? activeProject.cwd}
          height={activeThread.terminalHeight}
          terminalIds={activeThread.terminalIds}
          activeTerminalId={activeThread.activeTerminalId}
          terminalGroups={activeThread.terminalGroups}
          activeTerminalGroupId={activeThread.activeTerminalGroupId}
          focusRequestId={terminalFocusRequestId}
          onSplitTerminal={splitTerminal}
          onNewTerminal={createNewTerminal}
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
            <button
              type="button"
              className="absolute right-2 top-2 z-30 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/60 text-xl leading-none text-white transition-colors duration-150 hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 [-webkit-app-region:no-drag]"
              onClick={() => setExpandedImage(null)}
              aria-label="Close image preview"
            >
              <span className="pointer-events-none">×</span>
            </button>
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
