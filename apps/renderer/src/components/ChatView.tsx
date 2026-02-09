import type { ProviderApprovalDecision, ProviderEvent } from "@acme/contracts";
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { EDITORS, type EditorId } from "@acme/contracts";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  MODEL_OPTIONS,
  REASONING_OPTIONS,
  resolveModelSlug,
} from "../model-logic";
import {
  derivePhase,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatDuration,
  formatElapsed,
  formatTimestamp,
  readNativeApi,
} from "../session-logic";
import { useStore } from "../store";
import ChatMarkdown from "./ChatMarkdown";

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

const LAST_EDITOR_KEY = "codething:last-editor";

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

interface PendingApprovalCard {
  requestId: string;
  requestKind: "command" | "file-change";
  createdAt: string;
  detail?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function approvalDetail(event: ProviderEvent): string | undefined {
  const payload = asRecord(event.payload);
  const command = asString(payload?.command);
  if (command) return command;
  return asString(payload?.reason);
}

function derivePendingApprovals(
  events: ProviderEvent[],
): PendingApprovalCard[] {
  const pending = new Map<string, PendingApprovalCard>();
  const ordered = [...events].reverse();

  for (const event of ordered) {
    if (
      event.method === "session/closed" ||
      event.method === "session/exited"
    ) {
      pending.clear();
      continue;
    }

    const requestId =
      event.requestId ?? asString(asRecord(event.payload)?.requestId);
    if (!requestId) continue;

    if (
      event.kind === "request" &&
      (event.requestKind === "command" || event.requestKind === "file-change")
    ) {
      const detail = approvalDetail(event);
      pending.set(requestId, {
        requestId,
        requestKind: event.requestKind,
        createdAt: event.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (event.method === "item/requestApproval/decision") {
      pending.delete(requestId);
    }
  }

  return Array.from(pending.values());
}

export default function ChatView() {
  const { state, dispatch } = useStore();
  const api = useMemo(() => readNativeApi(), []);
  const [prompt, setPrompt] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isEditorMenuOpen, setIsEditorMenuOpen] = useState(false);
  const [lastEditor, setLastEditor] = useState<EditorId>(() => {
    const stored = localStorage.getItem(LAST_EDITOR_KEY);
    return EDITORS.some((e) => e.id === stored)
      ? (stored as EditorId)
      : EDITORS[0].id;
  });
  const [selectedEffort, setSelectedEffort] =
    useState<string>(DEFAULT_REASONING);
  const [isSwitchingRuntimeMode, setIsSwitchingRuntimeMode] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<string[]>(
    [],
  );
  const [nowTick, setNowTick] = useState(() => Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const editorMenuRef = useRef<HTMLDivElement>(null);

  const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
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
    if (workLogEntries.length === 0) return null;

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
    workLogEntries.length,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!activeThread?.latestTurnStartedAt) return null;
    if (!activeThread.latestTurnCompletedAt) return null;
    if (workLogEntries.length === 0) return null;

    const turnStartedAt = Date.parse(activeThread.latestTurnStartedAt);
    if (Number.isNaN(turnStartedAt)) return null;

    const entry = timelineEntries.find((timelineEntry) => {
      if (timelineEntry.kind !== "message") return false;
      if (timelineEntry.message.role !== "assistant") return false;
      const messageAt = Date.parse(timelineEntry.message.createdAt);
      return !Number.isNaN(messageAt) && messageAt >= turnStartedAt;
    });
    return entry?.id ?? null;
  }, [
    activeThread?.latestTurnStartedAt,
    activeThread?.latestTurnCompletedAt,
    timelineEntries,
    workLogEntries.length,
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

  const handleRuntimeModeChange = async (
    mode: "approval-required" | "full-access",
  ) => {
    if (mode === state.runtimeMode) return;
    dispatch({ type: "SET_RUNTIME_MODE", mode });
    if (!api) return;

    const sessionIds = state.threads
      .map((t) => t.session)
      .filter(
        (s): s is NonNullable<typeof s> =>
          s !== null && s.status !== "closed",
      )
      .map((s) => s.sessionId);

    if (sessionIds.length === 0) return;

    setIsSwitchingRuntimeMode(true);
    try {
      await Promise.all(
        sessionIds.map((id) =>
          api.providers.stopSession({ sessionId: id }).catch(() => undefined),
        ),
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
      if (
        event.target instanceof Node &&
        !editorMenuRef.current.contains(event.target)
      ) {
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
          void api.shell.openInEditor(activeProject.cwd, lastEditor);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [api, activeProject, lastEditor]);

  const openInEditor = (editorId: EditorId) => {
    if (!api || !activeProject) return;
    void api.shell.openInEditor(activeProject.cwd, editorId);
    setLastEditor(editorId);
    localStorage.setItem(LAST_EDITOR_KEY, editorId);
    setIsEditorMenuOpen(false);
  };

  const ensureSession = async (): Promise<string | null> => {
    if (!api || !activeThread || !activeProject) return null;
    if (activeThread.session && activeThread.session.status !== "closed") {
      return activeThread.session.sessionId;
    }

    setIsConnecting(true);
    try {
      const session = await api.providers.startSession({
        provider: "codex",
        cwd: activeProject.cwd || undefined,
        model: selectedModel || undefined,
        approvalPolicy: runtimeSessionConfig.approvalPolicy,
        sandboxMode: runtimeSessionConfig.sandboxMode,
      });
      dispatch({
        type: "UPDATE_SESSION",
        threadId: activeThread.id,
        session,
      });
      return session.sessionId;
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
    if (!trimmed) return;

    // Auto-title from first message
    if (activeThread.messages.length === 0) {
      const title = trimmed.length > 50 ? `${trimmed.slice(0, 50)}...` : trimmed;
      dispatch({
        type: "SET_THREAD_TITLE",
        threadId: activeThread.id,
        title,
      });
    }

    dispatch({
      type: "SET_ERROR",
      threadId: activeThread.id,
      error: null,
    });
    dispatch({
      type: "PUSH_USER_MESSAGE",
      threadId: activeThread.id,
      id: crypto.randomUUID(),
      text: trimmed,
    });
    setPrompt("");

    const sessionId = await ensureSession();
    if (!sessionId) return;

    setIsSending(true);
    try {
      await api.providers.sendTurn({
        sessionId,
        input: trimmed,
        model: selectedModel || undefined,
        effort: selectedEffort || undefined,
      });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        threadId: activeThread.id,
        error: err instanceof Error ? err.message : "Failed to send message.",
      });
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

  const onRespondToApproval = async (
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => {
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
        error:
          err instanceof Error
            ? err.message
            : "Failed to submit approval decision.",
      });
    } finally {
      setRespondingRequestIds((existing) =>
        existing.filter((id) => id !== requestId),
      );
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
      <div className="flex flex-1 flex-col bg-background text-muted-foreground/40">
        <div className="drag-region h-[52px] shrink-0" />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">Select a thread or create a new one to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-background">
      {/* Top bar */}
      <header className="drag-region flex items-center justify-between border-b border-border px-5 pt-[28px] pb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-foreground">
            {activeThread.title}
          </h2>
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
                          {navigator.platform.includes("Mac")
                            ? "\u2318O"
                            : "Ctrl+O"}
                        </kbd>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
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
        <div className="mx-4 mt-3 rounded-lg border border-rose-400/20 bg-rose-900/20 px-3 py-2 text-xs text-rose-200">
          {activeThread.error}
        </div>
      )}

      {pendingApprovals.length > 0 && (
        <div className="mx-4 mt-3 space-y-2">
          {pendingApprovals.map((approval) => {
            const isResponding = respondingRequestIds.includes(
              approval.requestId,
            );
            return (
              <div
                key={approval.requestId}
                className="rounded-lg border border-amber-300/20 bg-amber-500/[0.07] px-3 py-2"
              >
                <p className="text-xs font-medium text-amber-100">
                  {approval.requestKind === "command"
                    ? "Command approval requested"
                    : "File-change approval requested"}
                </p>
                {approval.detail && (
                  <p
                    className="mt-1 truncate font-mono text-[11px] text-amber-100/75"
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
                    onClick={() =>
                      void onRespondToApproval(approval.requestId, "accept")
                    }
                  >
                    Approve once
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-sky-300/30 bg-sky-500/[0.15] px-2 py-1 text-[11px] text-sky-100 transition-colors duration-150 hover:bg-sky-500/[0.22] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isResponding}
                    onClick={() =>
                      void onRespondToApproval(
                        approval.requestId,
                        "acceptForSession",
                      )
                    }
                  >
                    Always allow this session
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground/90 transition-colors duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isResponding}
                    onClick={() =>
                      void onRespondToApproval(approval.requestId, "decline")
                    }
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-rose-300/30 bg-rose-500/[0.12] px-2 py-1 text-[11px] text-rose-100 transition-colors duration-150 hover:bg-rose-500/[0.2] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isResponding}
                    onClick={() =>
                      void onRespondToApproval(approval.requestId, "cancel")
                    }
                  >
                    Cancel turn
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {activeThread.messages.length === 0 && !isWorking ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground/30">Send a message to start the conversation.</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {timelineEntries.map((timelineEntry, index) => (
              <Fragment key={timelineEntry.id}>
                {timelineEntry.kind === "message" &&
                  timelineEntry.message.role === "assistant" &&
                  (completionDividerBeforeEntryId === timelineEntry.id ||
                    timelineEntries[index - 1]?.kind === "work") && (
                    <div className="my-3 flex items-center gap-3">
                      <span className="h-px flex-1 bg-border" />
                      <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                        {completionSummary
                          ? `Response • ${completionSummary}`
                          : "Response"}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                {timelineEntry.kind === "work" ? (
                  <div className="flex items-start gap-2 py-0.5 pl-1.5">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
                    <p
                      className={`py-[2px] text-[11px] leading-relaxed ${workToneClass(timelineEntry.entry.tone)}`}
                    >
                      {timelineEntry.entry.detail ? (
                        <>
                          {timelineEntry.entry.label}
                          <span
                            className="ml-1.5 inline-block max-w-[70ch] truncate align-bottom font-mono text-[11px] opacity-60"
                            title={timelineEntry.entry.detail}
                          >
                            {timelineEntry.entry.detail}
                          </span>
                        </>
                      ) : (
                        timelineEntry.entry.label
                      )}
                    </p>
                  </div>
                ) : timelineEntry.message.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                      <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground">
                        {timelineEntry.message.text}
                      </pre>
                      <p className="mt-1.5 text-right text-[10px] text-muted-foreground/30">
                        {formatTimestamp(timelineEntry.message.createdAt)}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="px-1 py-0.5">
                    <ChatMarkdown
                      text={
                        timelineEntry.message.text ||
                        (timelineEntry.message.streaming
                          ? ""
                          : "(empty response)")
                      }
                    />
                    {timelineEntry.message.streaming && (
                      <div className="pt-1.5">
                        <span className="inline-flex items-center gap-2 rounded-full border border-sky-400/25 bg-sky-500/[0.08] px-2 py-0.5 text-[10px] text-sky-100/90">
                          <span className="inline-flex gap-1">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-100/80" />
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-100/80 [animation-delay:150ms]" />
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-100/80 [animation-delay:300ms]" />
                          </span>
                          <span>Thinking</span>
                        </span>
                      </div>
                    )}
                    <p className="mt-1.5 text-[10px] text-muted-foreground/30">
                      {formatMessageMeta(
                        timelineEntry.message.createdAt,
                        timelineEntry.message.streaming
                          ? formatElapsed(
                              timelineEntry.message.createdAt,
                              nowIso,
                            )
                          : formatElapsed(
                              timelineEntry.message.createdAt,
                              assistantCompletionByItemId.get(
                                timelineEntry.message.id,
                              ),
                            ),
                      )}
                    </p>
                  </div>
                )}
              </Fragment>
            ))}
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
      <div className="px-5 pb-4 pt-2">
        <form onSubmit={onSend} className="mx-auto max-w-3xl">
          <div className="group rounded-[20px] border border-border bg-card transition-colors duration-200 focus-within:border-ring">
            {/* Textarea area */}
            <div className="px-4 pt-4 pb-2">
              <textarea
                ref={textareaRef}
                className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground/35 focus:outline-none"
                rows={2}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={
                  phase === "disconnected" ? "Ask for follow-up changes" : "Ask anything..."
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
                      state.runtimeMode === "full-access"
                        ? "approval-required"
                        : "full-access",
                    )
                  }
                  title={
                    state.runtimeMode === "full-access"
                      ? "Full access — click to require approvals"
                      : "Approval required — click for full access"
                  }
                >
                  {state.runtimeMode === "full-access" ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                    >
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
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                    >
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
                  <span>
                    {state.runtimeMode === "full-access"
                      ? "Full access"
                      : "Supervised"}
                  </span>
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
                    disabled={isSending || isConnecting || !prompt.trim()}
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
    </div>
  );
}
