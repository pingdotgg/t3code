import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  derivePhase,
  deriveWorkLogEntries,
  formatElapsed,
  formatTimestamp,
  readNativeApi,
} from "../session-logic";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  MODEL_OPTIONS,
  REASONING_OPTIONS,
  resolveModelSlug,
} from "../model-logic";
import { useStore } from "../store";

function formatMessageMeta(createdAt: string, duration: string | null): string {
  if (!duration) return formatTimestamp(createdAt);
  return `${formatTimestamp(createdAt)} • ${duration}`;
}

function statusLabel(phase: string): string {
  if (phase === "running") return "Thinking / working";
  if (phase === "connecting") return "Connecting";
  if (phase === "ready") return "Ready";
  return "Disconnected";
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "thinking") return "text-sky-100";
  if (tone === "tool") return "text-emerald-100";
  if (tone === "error") return "text-rose-100";
  return "text-[#d8d8d8]";
}

export default function ChatView() {
  const { state, dispatch } = useStore();
  const api = useMemo(() => readNativeApi(), []);
  const [prompt, setPrompt] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [selectedEffort, setSelectedEffort] = useState<string>(
    DEFAULT_REASONING,
  );
  const [nowTick, setNowTick] = useState(() => Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
  const activeProject = state.projects.find(
    (p) => p.id === activeThread?.projectId,
  );
  const selectedModel = resolveModelSlug(
    activeThread?.model ?? activeProject?.model ?? DEFAULT_MODEL,
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const isWorking = phase === "running" || isSending || isConnecting;
  const activeTurnId = activeThread?.session?.activeTurnId;
  const nowIso = new Date(nowTick).toISOString();
  const modelOptions = MODEL_OPTIONS;
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(activeThread?.events ?? [], activeTurnId),
    [activeThread?.events, activeTurnId],
  );
  const assistantCompletionByItemId = useMemo(() => {
    const map = new Map<string, string>();
    const ordered = [...(activeThread?.events ?? [])].reverse();
    for (const event of ordered) {
      if (event.method !== "item/completed") continue;
      if (!event.itemId) continue;
      map.set(event.itemId, event.createdAt);
    }
    return map;
  }, [activeThread?.events]);
  const recentWorkLogEntries = workLogEntries.slice(-12);

  // Auto-scroll on new messages
  const messageCount = activeThread?.messages.length ?? 0;
  const workLogCount = recentWorkLogEntries.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger on message count change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-scroll while active work-log events stream in
  useEffect(() => {
    if (phase !== "running") return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [phase, workLogCount]);

  // Auto-resize textarea
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger on prompt change
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
      if (
        event.target instanceof Node &&
        !modelMenuRef.current.contains(event.target)
      ) {
        setIsModelMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isModelMenuOpen]);

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
      const title =
        trimmed.length > 50 ? `${trimmed.slice(0, 50)}...` : trimmed;
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
      <div className="flex flex-1 flex-col bg-[#0c0c0c] text-[#a0a0a0]/40">
        <div className="drag-region h-[52px] shrink-0" />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">
              Select a thread or create a new one to get started.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-[#0c0c0c]">
      {/* Top bar */}
      <header className="drag-region flex items-center justify-between border-b border-white/[0.08] px-5 pt-[28px] pb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-[#e0e0e0]">
            {activeThread.title}
          </h2>
          {activeProject && (
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-[#a0a0a0]/50">
              {activeProject.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Status indicator */}
          <div
            className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] ${
              phase === "running"
                ? "border-sky-400/35 bg-sky-500/[0.08] text-sky-100"
                : phase === "connecting"
                  ? "border-amber-400/35 bg-amber-500/[0.08] text-amber-100"
                  : phase === "ready"
                    ? "border-emerald-400/35 bg-emerald-500/[0.08] text-emerald-100"
                    : "border-white/[0.08] bg-white/[0.04] text-[#a0a0a0]/70"
            }`}
          >
            <span className="relative inline-flex h-2.5 w-2.5">
              {(phase === "running" || phase === "connecting") && (
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full ${
                    phase === "running" ? "bg-sky-300/70" : "bg-amber-300/70"
                  }`}
                />
              )}
              <span
                className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                  phase === "running"
                    ? "bg-sky-200"
                    : phase === "connecting"
                      ? "bg-amber-200"
                      : phase === "ready"
                        ? "bg-emerald-200"
                        : "bg-[#a0a0a0]/40"
                }`}
              />
            </span>
            <span>{statusLabel(phase)}</span>
          </div>
          {/* Diff toggle */}
          <button
            type="button"
            className={`rounded-md px-2 py-1 text-[10px] transition-colors duration-150 ${
              state.diffOpen
                ? "bg-white/10 text-white"
                : "text-[#a0a0a0]/40 hover:text-[#a0a0a0]/60"
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {activeThread.messages.length === 0 && !isWorking ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-[#a0a0a0]/30">
              Send a message to start the conversation.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {isWorking && (
              <div className="rounded-2xl border border-sky-400/20 bg-sky-500/[0.06] px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="inline-flex items-center gap-2 text-xs text-sky-100">
                    <span className="relative inline-flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-300/70" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-200" />
                    </span>
                    <span>Model is working</span>
                  </div>
                  <span className="text-[10px] text-sky-100/70">
                    {recentWorkLogEntries.length} event
                    {recentWorkLogEntries.length === 1 ? "" : "s"}
                  </span>
                </div>
                {recentWorkLogEntries.length === 0 ? (
                  <p className="pt-2 text-[11px] text-sky-100/70">
                    Waiting for tool/preamble updates...
                  </p>
                ) : (
                  <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-1">
                    {recentWorkLogEntries.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-lg border border-white/[0.08] bg-black/20 px-2 py-1.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p
                            className={`text-[11px] ${workToneClass(entry.tone)}`}
                          >
                            {entry.label}
                          </p>
                          <span className="shrink-0 text-[10px] text-[#a0a0a0]/60">
                            {formatTimestamp(entry.createdAt)}
                          </span>
                        </div>
                        {entry.detail && (
                          <p className="pt-0.5 font-mono text-[11px] text-[#d0d0d0]/75">
                            {entry.detail}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {activeThread.messages.map((msg) => (
              <div key={msg.id}>
                {msg.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-white/[0.08] bg-white/[0.05] px-4 py-3">
                      <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-[#e0e0e0]">
                        {msg.text}
                      </pre>
                      <p className="mt-1.5 text-right text-[10px] text-[#a0a0a0]/30">
                        {formatTimestamp(msg.createdAt)}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="border-l-2 border-white/[0.15] pl-4">
                    <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-[#d0d0d0]">
                      {msg.text || (msg.streaming ? "" : "(empty response)")}
                    </pre>
                    {msg.streaming && (
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
                    <p className="mt-1.5 text-[10px] text-[#a0a0a0]/30">
                      {formatMessageMeta(
                        msg.createdAt,
                        msg.streaming
                          ? formatElapsed(msg.createdAt, nowIso)
                          : formatElapsed(
                              msg.createdAt,
                              assistantCompletionByItemId.get(msg.id),
                            ),
                      )}
                    </p>
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="px-5 pb-4 pt-2">
        <form
          onSubmit={onSend}
          className="mx-auto max-w-3xl"
        >
          <div className="group rounded-[20px] border border-white/[0.08] bg-[#141416] transition-colors duration-200 focus-within:border-white/[0.16]">
            {/* Textarea area */}
            <div className="px-4 pt-4 pb-2">
              <textarea
                ref={textareaRef}
                className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-[#e0e0e0] placeholder:text-[#a0a0a0]/35 focus:outline-none"
                rows={2}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={
                  phase === "disconnected"
                    ? "Ask for follow-up changes"
                    : "Ask anything..."
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
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-[#a0a0a0]/70 transition-colors duration-150 hover:bg-white/[0.06] hover:text-[#d0d0d0]"
                    onClick={() => setIsModelMenuOpen((open) => !open)}
                  >
                    <span className="max-w-[180px] truncate">
                      {selectedModel}
                    </span>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="opacity-50">
                      <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {isModelMenuOpen && (
                    <div className="absolute bottom-full left-0 z-20 mb-2 w-[320px] rounded-2xl border border-white/[0.1] bg-[#1b1b1d]/95 p-2 shadow-[0_16px_40px_rgba(0,0,0,0.55)] backdrop-blur">
                      <p className="px-2 py-1 text-[11px] text-[#a0a0a0]/70">
                        Select model
                      </p>
                      <div className="max-h-72 overflow-y-auto">
                        {modelOptions.map((model) => {
                          const isSelected = model === selectedModel;
                          return (
                            <button
                              key={model}
                              type="button"
                              className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-xl px-2 py-2 text-left font-mono text-sm transition-colors duration-150 ${
                                isSelected
                                  ? "bg-white/[0.08] text-white"
                                  : "text-[#d4d4d4] hover:bg-white/[0.05]"
                              }`}
                              onClick={() => onModelSelect(model)}
                            >
                              <span className="truncate">{model}</span>
                              <span
                                className={`pt-0.5 text-sm ${
                                  isSelected ? "text-white" : "text-transparent"
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
                <div className="mx-0.5 h-4 w-px bg-white/[0.08]" />

                {/* Reasoning effort */}
                <label
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-[#a0a0a0]/70 transition-colors duration-150 hover:bg-white/[0.06] hover:text-[#d0d0d0]"
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
                      <option key={effort} value={effort} className="bg-[#1b1b1d]">
                        {effort}
                        {effort === DEFAULT_REASONING ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="opacity-50">
                    <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </label>
              </div>

              {/* Right side: send / stop button */}
              <div className="flex items-center gap-2">
                {activeProject && (
                  <span className="text-[11px] text-[#a0a0a0]/25">
                    {activeProject.name}
                  </span>
                )}
                {phase === "running" ? (
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:bg-rose-500 hover:scale-105"
                    onClick={() => void onInterrupt()}
                    aria-label="Stop generation"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                      <rect x="2" y="2" width="8" height="8" rx="1.5" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-[#0c0c0c] transition-all duration-150 hover:bg-white hover:scale-105 disabled:opacity-30 disabled:hover:scale-100"
                    disabled={isSending || isConnecting || !prompt.trim()}
                    aria-label={isConnecting ? "Connecting" : isSending ? "Sending" : "Send message"}
                  >
                    {isConnecting || isSending ? (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="animate-spin">
                        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="20 12" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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
