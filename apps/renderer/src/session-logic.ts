import type { NativeApi, ProviderEvent, ProviderKind, ProviderSession } from "@t3tools/contracts";
import type { ChatMessage, SessionPhase } from "./types";
import { createWsNativeApi } from "./wsNativeApi";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeCode", label: "Claude Code (soon)", available: false },
];

let cachedApi: NativeApi | undefined;

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  // Prefer Electron preload bridge if available
  if (window.nativeApi) {
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  // Fall back to WebSocket transport
  cachedApi = createWsNativeApi();
  return cachedApi;
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

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;

  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }

  return formatDuration(endedAt - startedAt);
}

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  tone: "thinking" | "tool" | "info" | "error";
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

function normalizeDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeItemType(raw: string | undefined): string {
  if (!raw) return "item";
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shouldDropItemType(type: string): boolean {
  if (
    type.includes("preamble") ||
    type.includes("reasoning") ||
    type.includes("thought")
  ) {
    return true;
  }

  return type === "work" || type.startsWith("work ");
}

function shouldShowItemLifecycle(type: string): boolean {
  return (
    type.includes("tool") ||
    type.includes("command") ||
    type.includes("file change")
  );
}

function shouldDropMethod(method: string): boolean {
  return /(^|\/)(preamble|work|reasoning|thought)(\/|$)/i.test(method);
}

function itemTypeMeta(type: string): {
  label: string;
  tone: WorkLogEntry["tone"];
} {
  if (type.includes("command")) {
    return { label: "Command run", tone: "tool" };
  }
  if (type.includes("file change")) {
    return { label: "File change", tone: "tool" };
  }
  if (type.includes("tool")) {
    return { label: "Tool call", tone: "tool" };
  }
  return { label: "Work item", tone: "info" };
}

interface ItemLifecycleCandidate {
  id: string;
  itemId?: string;
  createdAt: string;
  label: string;
  detail?: string;
  tone: WorkLogEntry["tone"];
  phase: "started" | "completed";
}

function extractDetail(
  payload: Record<string, unknown> | undefined,
  item: Record<string, unknown> | undefined,
): string | undefined {
  const candidates = [
    asString(item?.command),
    asString(item?.tool),
    asString(item?.name),
    asString(item?.title),
    asString(item?.summary),
    asString(item?.text),
    asString(item?.prompt),
    asString(payload?.message),
    asString(payload?.prompt),
    asString(payload?.command),
  ];

  for (const candidate of candidates) {
    const detail = normalizeDetail(candidate);
    if (detail) return detail;
  }
  return undefined;
}

function lifecycleCandidateFromItemEvent(
  event: ProviderEvent,
): ItemLifecycleCandidate | null {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const normalizedType = normalizeItemType(asString(item?.type));
  if (shouldDropItemType(normalizedType) || shouldDropMethod(event.method)) {
    return null;
  }
  if (!shouldShowItemLifecycle(normalizedType)) {
    return null;
  }

  const meta = itemTypeMeta(normalizedType);
  const isStarted = event.method === "item/started";
  const isCompleted = event.method === "item/completed";
  if (!isStarted && !isCompleted) {
    return null;
  }

  const detail = extractDetail(payload, item);
  const itemId = event.itemId ?? asString(item?.id);
  return {
    id: event.id,
    ...(itemId ? { itemId } : {}),
    createdAt: event.createdAt,
    label: meta.label,
    ...(detail ? { detail } : {}),
    tone: meta.tone,
    phase: isCompleted ? "completed" : "started",
  };
}

function entryFromRequest(event: ProviderEvent): WorkLogEntry | null {
  if (event.kind !== "request") return null;
  if (shouldDropMethod(event.method)) return null;

  if (event.method.includes("commandExecution")) {
    return {
      id: event.id,
      createdAt: event.createdAt,
      label: "Command approval requested",
      tone: "tool",
    };
  }

  if (event.method.includes("fileChange")) {
    return {
      id: event.id,
      createdAt: event.createdAt,
      label: "File-change approval requested",
      tone: "tool",
    };
  }

  if (event.method.includes("requestUserInput")) {
    return {
      id: event.id,
      createdAt: event.createdAt,
      label: "Tool requested user input",
      tone: "tool",
    };
  }

  return {
    id: event.id,
    createdAt: event.createdAt,
    label: `Request: ${event.method}`,
    tone: "info",
  };
}

function entryFromNotification(event: ProviderEvent): WorkLogEntry | null {
  if (event.kind !== "notification") return null;
  if (shouldDropMethod(event.method)) return null;
  if (event.method === "item/agentMessage/delta") return null;
  if (event.method === "turn/started") {
    return null;
  }
  if (event.method === "thread/started") return null;

  if (event.method === "turn/completed") {
    const payload = asObject(event.payload);
    const turn = asObject(payload?.turn);
    const status = asString(turn?.status);
    if (status !== "failed") {
      return null;
    }
    const turnError = asObject(turn?.error);
    const turnErrorMessage = asString(turnError?.message);
    const turnErrorDetail = normalizeDetail(turnErrorMessage);

    return {
      id: event.id,
      createdAt: event.createdAt,
      label: "Turn failed",
      ...(turnErrorDetail ? { detail: turnErrorDetail } : {}),
      tone: "error",
    };
  }

  if (event.method.startsWith("item/")) return null;

  return null;
}

function entryFromError(event: ProviderEvent): WorkLogEntry | null {
  if (event.kind !== "error") return null;
  if (shouldDropMethod(event.method)) return null;
  const detail = normalizeDetail(event.message);

  return {
    id: event.id,
    createdAt: event.createdAt,
    label: "Runtime error",
    ...(detail ? { detail } : {}),
    tone: "error",
  };
}

function eventTurnId(event: ProviderEvent): string | undefined {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  return event.turnId ?? asString(turn?.id);
}

export function deriveWorkLogEntries(
  events: ProviderEvent[],
  turnId: string | undefined,
): WorkLogEntry[] {
  const ordered = [...events].toReversed();
  const entries: WorkLogEntry[] = [];
  const turnStartedAtIso = turnId
    ? ordered.find((event) => {
        if (event.method !== "turn/started") return false;
        return eventTurnId(event) === turnId;
      })?.createdAt
    : undefined;
  const turnStartedAt = turnStartedAtIso ? Date.parse(turnStartedAtIso) : Number.NaN;

  const shouldIncludeEvent = (event: ProviderEvent): boolean => {
    if (!turnId) return true;
    const scopedTurnId = eventTurnId(event);
    if (scopedTurnId && scopedTurnId !== turnId) {
      return false;
    }

    if (!scopedTurnId && !Number.isNaN(turnStartedAt)) {
      const eventAt = Date.parse(event.createdAt);
      if (!Number.isNaN(eventAt) && eventAt < turnStartedAt) {
        return false;
      }
    }

    return true;
  };

  const completedLifecycleItemIds = new Set<string>();
  for (const event of ordered) {
    if (!shouldIncludeEvent(event)) continue;
    const candidate = lifecycleCandidateFromItemEvent(event);
    if (candidate?.phase === "completed" && candidate.itemId) {
      completedLifecycleItemIds.add(candidate.itemId);
    }
  }

  for (const event of ordered) {
    if (!shouldIncludeEvent(event)) continue;

    const lifecycleCandidate = lifecycleCandidateFromItemEvent(event);
    if (lifecycleCandidate) {
      if (
        lifecycleCandidate.phase === "started" &&
        lifecycleCandidate.itemId &&
        completedLifecycleItemIds.has(lifecycleCandidate.itemId)
      ) {
        continue;
      }
      if (
        lifecycleCandidate.label === "Tool call" &&
        !lifecycleCandidate.detail
      ) {
        continue;
      }

      entries.push({
        id: lifecycleCandidate.id,
        createdAt: lifecycleCandidate.createdAt,
        label: lifecycleCandidate.label,
        ...(lifecycleCandidate.detail
          ? { detail: lifecycleCandidate.detail }
          : {}),
        tone: lifecycleCandidate.tone,
      });
      continue;
    }

    const fromRequest = entryFromRequest(event);
    if (fromRequest) {
      entries.push(fromRequest);
      continue;
    }

    const fromNotification = entryFromNotification(event);
    if (fromNotification) {
      entries.push(fromNotification);
      continue;
    }

    const fromError = entryFromError(event);
    if (fromError) {
      entries.push(fromError);
    }
  }

  return entries;
}

function toTimestamp(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  let messageIndex = 0;
  let workIndex = 0;

  while (messageIndex < messages.length || workIndex < workEntries.length) {
    const message = messages[messageIndex];
    const workEntry = workEntries[workIndex];

    if (!message && workEntry) {
      timeline.push({
        id: `work:${workEntry.id}`,
        kind: "work",
        createdAt: workEntry.createdAt,
        entry: workEntry,
      });
      workIndex += 1;
      continue;
    }

    if (!workEntry && message) {
      timeline.push({
        id: `message:${message.id}`,
        kind: "message",
        createdAt: message.createdAt,
        message,
      });
      messageIndex += 1;
      continue;
    }

    if (!message || !workEntry) {
      break;
    }

    const messageAt = toTimestamp(message.createdAt);
    const workAt = toTimestamp(workEntry.createdAt);

    if (workAt <= messageAt) {
      timeline.push({
        id: `work:${workEntry.id}`,
        kind: "work",
        createdAt: workEntry.createdAt,
        entry: workEntry,
      });
      workIndex += 1;
      continue;
    }

    timeline.push({
      id: `message:${message.id}`,
      kind: "message",
      createdAt: message.createdAt,
      message,
    });
    messageIndex += 1;
  }

  return timeline;
}

export function derivePhase(session: ProviderSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}

export function evolveSession(previous: ProviderSession, event: ProviderEvent): ProviderSession {
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
