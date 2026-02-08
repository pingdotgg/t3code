import type {
  ProviderEvent,
  ProviderKind,
  ProviderSession,
} from "@acme/contracts";
import type { ChatMessage, SessionPhase } from "./types";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeCode", label: "Claude Code (soon)", available: false },
];

export function readNativeApi() {
  if (typeof window === "undefined") return undefined;
  return window.nativeApi;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function formatTimestamp(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(isoDate));
}

export function derivePhase(session: ProviderSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}

export function evolveSession(
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

  return { ...previous, updatedAt: event.createdAt };
}

export function applyEventToMessages(
  previous: ChatMessage[],
  event: ProviderEvent,
  activeAssistantItemRef: { current: string | null },
): ChatMessage[] {
  const payload = asObject(event.payload);

  if (event.method === "item/started") {
    const item = asObject(payload?.item);
    if (asString(item?.type) !== "agentMessage") return previous;
    const itemId = asString(item?.id);
    if (!itemId) return previous;

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
    if (!itemId || !delta) return previous;

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
    if (!existing) return previous;
    updated[existingIndex] = {
      ...existing,
      text: `${existing.text}${delta}`,
      streaming: true,
    };
    return updated;
  }

  if (event.method === "item/completed") {
    const item = asObject(payload?.item);
    if (asString(item?.type) !== "agentMessage") return previous;
    const itemId = asString(item?.id);
    if (!itemId) return previous;

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
    if (!existing) return previous;
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
