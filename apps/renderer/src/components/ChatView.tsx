import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { derivePhase, formatTimestamp, readNativeApi } from "../session-logic";
import { useStore } from "../store";

export default function ChatView() {
  const { state, dispatch } = useStore();
  const api = useMemo(() => readNativeApi(), []);
  const [prompt, setPrompt] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
  const activeProject = state.projects.find(
    (p) => p.id === activeThread?.projectId,
  );
  const phase = derivePhase(activeThread?.session ?? null);

  // Auto-scroll on new messages
  const messageCount = activeThread?.messages.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger on message count change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);

  // Auto-resize textarea
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger on prompt change
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [prompt]);

  const ensureSession = async (): Promise<boolean> => {
    if (!api || !activeThread || !activeProject) return false;
    if (activeThread.session && activeThread.session.status !== "closed")
      return true;

    setIsConnecting(true);
    try {
      const session = await api.providers.startSession({
        provider: "codex",
        cwd: activeProject.cwd || undefined,
        model: activeProject.model || undefined,
      });
      dispatch({
        type: "UPDATE_SESSION",
        threadId: activeThread.id,
        session,
      });
      return true;
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        threadId: activeThread.id,
        error: err instanceof Error ? err.message : "Failed to connect.",
      });
      return false;
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

    const connected = await ensureSession();
    if (!connected) return;

    // Re-read thread to get session after potential connection
    const updatedThread = state.threads.find((t) => t.id === activeThread.id);
    const sessionId =
      updatedThread?.session?.sessionId ?? activeThread.session?.sessionId;
    if (!sessionId) return;

    setIsSending(true);
    try {
      await api.providers.sendTurn({ sessionId, input: trimmed });
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend(e as unknown as FormEvent);
    }
  };

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-[#0c0c0c] text-[#a0a0a0]/40">
        <div className="text-center">
          <div className="mb-3 text-4xl">&#x2728;</div>
          <p className="text-sm">
            Select a thread or create a new one to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-[#0c0c0c]">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-white/[0.08] px-5 py-3">
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
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full ${
                phase === "running"
                  ? "animate-pulse bg-emerald-400"
                  : phase === "ready"
                    ? "bg-emerald-400"
                    : phase === "connecting"
                      ? "animate-pulse bg-amber-400"
                      : "bg-[#a0a0a0]/30"
              }`}
            />
            <span className="text-[10px] text-[#a0a0a0]/50">{phase}</span>
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
        {activeThread.messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-[#a0a0a0]/30">
              Send a message to start the conversation.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
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
                      <span className="inline-flex gap-1 pt-1">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/50" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/50 [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/50 [animation-delay:300ms]" />
                      </span>
                    )}
                    {!msg.streaming && (
                      <p className="mt-1.5 text-[10px] text-[#a0a0a0]/30">
                        {formatTimestamp(msg.createdAt)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="border-t border-white/[0.08] px-5 py-3">
        <form
          onSubmit={onSend}
          className="mx-auto flex max-w-3xl items-end gap-2"
        >
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              className="w-full resize-none rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 py-3 pr-12 font-mono text-sm text-[#e0e0e0] placeholder:text-[#a0a0a0]/30 focus:border-white/20 focus:outline-none"
              rows={1}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                phase === "disconnected"
                  ? "Type a message (session auto-connects)..."
                  : "Type a message..."
              }
              disabled={isSending || isConnecting}
            />
            {activeProject && (
              <span className="absolute right-3 bottom-2 text-[9px] text-[#a0a0a0]/25">
                {activeProject.model}
              </span>
            )}
          </div>
          {phase === "running" ? (
            <button
              type="button"
              className="shrink-0 rounded-xl bg-rose-600/80 px-4 py-3 text-xs font-medium text-white transition-colors duration-150 hover:bg-rose-600"
              onClick={() => void onInterrupt()}
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="shrink-0 rounded-xl bg-white px-4 py-3 text-xs font-medium text-[#0c0c0c] transition-colors duration-150 hover:bg-white/90 disabled:opacity-40"
              disabled={isSending || isConnecting || !prompt.trim()}
            >
              {isConnecting
                ? "Connecting..."
                : isSending
                  ? "Sending..."
                  : "Send"}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
