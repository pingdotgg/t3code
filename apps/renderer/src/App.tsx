import {
  type FormEvent,
  type MutableRefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  ProviderEvent,
  ProviderKind,
  ProviderSession,
} from "@acme/contracts";

type SessionPhase = "disconnected" | "connecting" | "ready" | "running";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  streaming: boolean;
}

const PROVIDER_OPTIONS: Array<{
  value: ProviderKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeCode", label: "Claude Code (soon)", available: false },
];

function readNativeApi() {
  if (typeof window === "undefined") {
    return undefined;
  }

  return window.nativeApi;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatTimestamp(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(isoDate));
}

function derivePhase(session: ProviderSession | null): SessionPhase {
  if (!session || session.status === "closed") {
    return "disconnected";
  }

  if (session.status === "connecting") {
    return "connecting";
  }

  if (session.status === "running") {
    return "running";
  }

  return "ready";
}

function evolveSession(
  previous: ProviderSession,
  event: ProviderEvent,
): ProviderSession {
  const payload = asObject(event.payload);

  if (event.method === "thread/started") {
    const thread = asObject(payload?.thread);
    return {
      ...previous,
      threadId: asString(thread?.id) ?? event.threadId ?? previous.threadId,
      updatedAt: event.createdAt,
    };
  }

  if (event.method === "turn/started") {
    const turn = asObject(payload?.turn);
    return {
      ...previous,
      status: "running",
      activeTurnId: asString(turn?.id) ?? event.turnId ?? previous.activeTurnId,
      updatedAt: event.createdAt,
    };
  }

  if (event.method === "turn/completed") {
    const turn = asObject(payload?.turn);
    const status = asString(turn?.status);
    const turnError = asObject(turn?.error);
    return {
      ...previous,
      status: status === "failed" ? "error" : "ready",
      activeTurnId: undefined,
      lastError: asString(turnError?.message) ?? previous.lastError,
      updatedAt: event.createdAt,
    };
  }

  if (event.kind === "error") {
    return {
      ...previous,
      status: "error",
      lastError: event.message ?? previous.lastError,
      updatedAt: event.createdAt,
    };
  }

  if (event.method === "session/closed" || event.method === "session/exited") {
    return {
      ...previous,
      status: "closed",
      activeTurnId: undefined,
      lastError: event.message ?? previous.lastError,
      updatedAt: event.createdAt,
    };
  }

  return {
    ...previous,
    updatedAt: event.createdAt,
  };
}

function applyEventToMessages(
  previous: ChatMessage[],
  event: ProviderEvent,
  activeAssistantItemRef: MutableRefObject<string | null>,
): ChatMessage[] {
  const payload = asObject(event.payload);

  if (event.method === "item/started") {
    const item = asObject(payload?.item);
    if (asString(item?.type) !== "agentMessage") {
      return previous;
    }

    const itemId = asString(item?.id);
    if (!itemId) {
      return previous;
    }

    activeAssistantItemRef.current = itemId;
    const seedText = asString(item?.text) ?? "";
    const filtered = previous.filter((entry) => entry.id !== itemId);
    return [
      ...filtered,
      {
        id: itemId,
        role: "assistant",
        text: seedText,
        createdAt: event.createdAt,
        streaming: true,
      },
    ];
  }

  if (event.method === "item/agentMessage/delta") {
    const itemId = event.itemId ?? asString(payload?.itemId);
    const delta = event.textDelta ?? asString(payload?.delta) ?? "";
    if (!itemId || !delta) {
      return previous;
    }

    const existingIndex = previous.findIndex((entry) => entry.id === itemId);
    if (existingIndex === -1) {
      activeAssistantItemRef.current = itemId;
      return [
        ...previous,
        {
          id: itemId,
          role: "assistant",
          text: delta,
          createdAt: event.createdAt,
          streaming: true,
        },
      ];
    }

    const updated = [...previous];
    const existing = updated[existingIndex];
    if (!existing) {
      return previous;
    }
    updated[existingIndex] = {
      ...existing,
      text: `${existing.text}${delta}`,
      streaming: true,
    };
    return updated;
  }

  if (event.method === "item/completed") {
    const item = asObject(payload?.item);
    if (asString(item?.type) !== "agentMessage") {
      return previous;
    }

    const itemId = asString(item?.id);
    if (!itemId) {
      return previous;
    }

    const fullText = asString(item?.text);
    const existingIndex = previous.findIndex((entry) => entry.id === itemId);
    if (existingIndex === -1) {
      return [
        ...previous,
        {
          id: itemId,
          role: "assistant",
          text: fullText ?? "",
          createdAt: event.createdAt,
          streaming: false,
        },
      ];
    }

    const updated = [...previous];
    const existing = updated[existingIndex];
    if (!existing) {
      return previous;
    }
    updated[existingIndex] = {
      ...existing,
      text: fullText ?? existing.text,
      streaming: false,
    };

    if (activeAssistantItemRef.current === itemId) {
      activeAssistantItemRef.current = null;
    }

    return updated;
  }

  if (event.method === "turn/completed") {
    return previous.map((entry) => ({ ...entry, streaming: false }));
  }

  return previous;
}

export default function App() {
  const api = useMemo(() => readNativeApi(), []);
  const [provider, setProvider] = useState<ProviderKind>("codex");
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("gpt-5.1-codex");
  const [prompt, setPrompt] = useState("");
  const [session, setSession] = useState<ProviderSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ProviderEvent[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentSessionIdRef = useRef<string | null>(null);
  const activeAssistantItemRef = useRef<string | null>(null);

  useEffect(() => {
    currentSessionIdRef.current = session?.sessionId ?? null;
  }, [session?.sessionId]);

  useEffect(() => {
    if (!api) {
      return;
    }

    return api.providers.onEvent((event) => {
      const currentSessionId = currentSessionIdRef.current;
      if (!currentSessionId || currentSessionId !== event.sessionId) {
        return;
      }

      setEvents((previous) => [event, ...previous].slice(0, 200));
      setSession((previous) => {
        if (!previous || previous.sessionId !== event.sessionId) {
          return previous;
        }
        return evolveSession(previous, event);
      });
      setMessages((previous) =>
        applyEventToMessages(previous, event, activeAssistantItemRef),
      );

      if (event.kind === "error" && event.message) {
        setError(event.message);
      }
    });
  }, [api]);

  const phase = derivePhase(session);

  const onConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!api || provider !== "codex" || isConnecting) {
      return;
    }

    setError(null);
    setIsConnecting(true);
    try {
      const nextSession = await api.providers.startSession({
        provider,
        cwd: cwd.trim() || undefined,
        model: model.trim() || undefined,
      });
      currentSessionIdRef.current = nextSession.sessionId;
      activeAssistantItemRef.current = null;
      setSession(nextSession);
      setMessages([]);
      setEvents([]);
    } catch (connectError) {
      setError(
        connectError instanceof Error
          ? connectError.message
          : "Unable to connect to Codex app-server.",
      );
    } finally {
      setIsConnecting(false);
    }
  };

  const onDisconnect = async () => {
    if (!api || !session) {
      return;
    }

    await api.providers.stopSession({ sessionId: session.sessionId });
    currentSessionIdRef.current = null;
    setSession((previous) =>
      previous
        ? {
            ...previous,
            status: "closed",
            activeTurnId: undefined,
            updatedAt: new Date().toISOString(),
          }
        : previous,
    );
  };

  const onSendPrompt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!api || !session || isSending) {
      return;
    }

    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }

    setError(null);
    setMessages((previous) => [
      ...previous,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: trimmed,
        createdAt: new Date().toISOString(),
        streaming: false,
      },
    ]);
    setPrompt("");
    setIsSending(true);

    try {
      await api.providers.sendTurn({
        sessionId: session.sessionId,
        input: trimmed,
      });
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : "Failed to start a Codex turn.",
      );
    } finally {
      setIsSending(false);
    }
  };

  const onInterrupt = async () => {
    if (!api || !session) {
      return;
    }

    await api.providers.interruptTurn({
      sessionId: session.sessionId,
      turnId: session.activeTurnId,
    });
  };

  if (!api) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center px-6 py-10">
        <section className="surface-card w-full rounded-3xl p-8">
          <p className="label-chip">CodeThing</p>
          <h1 className="mt-3 text-3xl">Native bridge unavailable</h1>
          <p className="mt-3 text-sm text-amber-100/80">
            Launch the renderer through Electron so `window.nativeApi` is
            exposed by preload.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl px-4 py-6 text-[#f3f0e9] sm:px-8">
      <header className="surface-card relative overflow-hidden rounded-3xl px-6 py-7 sm:px-8">
        <div className="grain absolute inset-0 pointer-events-none" />
        <p className="label-chip relative">CodeThing / Provider Shell</p>
        <h1 className="relative mt-3 text-4xl tracking-tight sm:text-5xl">
          Codex-first workspace
        </h1>
        <p className="relative mt-3 max-w-3xl text-sm text-[#efe8d7]/82 sm:text-base">
          Built on the Codex app-server protocol with a provider abstraction in
          the IPC layer, so Claude Code can be added without reshaping the UI
          contract.
        </p>

        <form
          className="relative mt-6 grid gap-3 rounded-2xl border border-[#f6a40f]/30 bg-[#0f2034]/65 p-4 sm:grid-cols-6"
          onSubmit={onConnect}
        >
          <label className="sm:col-span-2">
            <span className="field-label">Provider</span>
            <select
              className="field-input"
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value as ProviderKind)
              }
              disabled={isConnecting || phase !== "disconnected"}
            >
              {PROVIDER_OPTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={!option.available}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="sm:col-span-2">
            <span className="field-label">Working directory</span>
            <input
              className="field-input font-mono text-xs sm:text-sm"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder="/Users/theo/Code/Work/..."
              disabled={isConnecting || phase !== "disconnected"}
            />
          </label>

          <label className="sm:col-span-1">
            <span className="field-label">Model</span>
            <input
              className="field-input font-mono text-xs sm:text-sm"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="gpt-5.1-codex"
              disabled={isConnecting || phase !== "disconnected"}
            />
          </label>

          <div className="sm:col-span-1 flex items-end">
            {phase === "disconnected" ? (
              <button
                type="submit"
                className="action-button action-primary w-full"
                disabled={provider !== "codex" || isConnecting}
              >
                {isConnecting ? "Connecting..." : "Connect"}
              </button>
            ) : (
              <button
                type="button"
                className="action-button action-danger w-full"
                onClick={() => void onDisconnect()}
              >
                Disconnect
              </button>
            )}
          </div>
        </form>

        <div className="relative mt-4 flex flex-wrap gap-2 text-xs">
          <span className="status-pill">
            phase={phase} provider={session?.provider ?? "none"}
          </span>
          <span className="status-pill">
            thread={session?.threadId ?? "none"}
          </span>
          <span className="status-pill">
            turn={session?.activeTurnId ?? "none"}
          </span>
        </div>
      </header>

      {error ? (
        <div className="mt-4 rounded-2xl border border-rose-300/35 bg-rose-900/35 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      <section className="mt-5 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <article className="surface-card rounded-3xl p-4 sm:p-5">
          <h2 className="text-xl">Conversation</h2>
          <div className="mt-4 max-h-[52vh] space-y-3 overflow-y-auto pr-1">
            {messages.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#f6d79e]/30 bg-[#0d1827]/70 px-4 py-5 text-sm text-[#d8d0c3]/75">
                No turns yet. Start a session, then send a prompt.
              </div>
            ) : null}

            {messages.map((entry) => (
              <div
                key={entry.id}
                className={`message-card ${
                  entry.role === "user" ? "message-user" : "message-assistant"
                }`}
              >
                <header className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-[#d8d0c3]/68">
                  <span>{entry.role === "user" ? "you" : "codex"}</span>
                  <span>{formatTimestamp(entry.createdAt)}</span>
                </header>
                <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6">
                  {entry.text || (entry.streaming ? "..." : "(empty response)")}
                </pre>
              </div>
            ))}
          </div>

          <form className="mt-4 grid gap-3" onSubmit={onSendPrompt}>
            <textarea
              className="field-input min-h-28 resize-y font-mono text-sm leading-6"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask Codex to inspect, plan, or edit this project..."
              disabled={phase === "disconnected" || isSending}
            />
            <div className="flex gap-2">
              <button
                type="submit"
                className="action-button action-primary"
                disabled={phase === "disconnected" || isSending}
              >
                {isSending ? "Starting turn..." : "Send"}
              </button>
              <button
                type="button"
                className="action-button action-muted"
                disabled={phase !== "running"}
                onClick={() => void onInterrupt()}
              >
                Interrupt
              </button>
            </div>
          </form>
        </article>

        <aside className="surface-card rounded-3xl p-4 sm:p-5">
          <h2 className="text-xl">Protocol stream</h2>
          <p className="mt-2 text-xs text-[#d8d0c3]/76">
            Live notifications from the app-server (latest first).
          </p>
          <div className="mt-4 max-h-[58vh] space-y-2 overflow-y-auto pr-1">
            {events.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[#f6d79e]/30 bg-[#0d1827]/70 px-3 py-4 text-xs text-[#d8d0c3]/76">
                Waiting for events...
              </p>
            ) : null}
            {events.map((entry) => (
              <div key={entry.id} className="event-card">
                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#f8ca64]">
                  {entry.method}
                </p>
                {entry.message ? (
                  <p className="mt-1 text-xs text-[#efe8d7]/88">
                    {entry.message}
                  </p>
                ) : null}
                <p className="mt-2 text-[11px] text-[#d8d0c3]/66">
                  {formatTimestamp(entry.createdAt)}
                  {entry.turnId ? ` · ${entry.turnId}` : ""}
                </p>
              </div>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}
