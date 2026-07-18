import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

const MAX_SESSIONS = 20;
const MAX_ENTRIES_PER_SESSION = 250;
const MAX_ENTRY_TEXT_LENGTH = 12_000;
const MAX_SESSION_TEXT_LENGTH = 120_000;
let traceIdSequence = 0;

if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("t3code:voice-traces:v1");
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

function nextTraceId(prefix: "session" | "entry"): string {
  traceIdSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${traceIdSequence.toString(36)}`;
}

export type VoiceTraceEntryKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "server_tool"
  | "system"
  | "error";

export interface VoiceTraceEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: VoiceTraceEntryKind;
  readonly title: string;
  readonly text?: string | undefined;
  readonly callId?: string | undefined;
  readonly details?: string | undefined;
}

export interface VoiceTraceSession {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: "active" | "completed" | "error";
  readonly title: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly entries: readonly VoiceTraceEntry[];
}

interface StartVoiceTraceInput {
  readonly title: string;
  readonly environmentId: string;
  readonly threadId: string;
}

interface AppendVoiceTraceEntryInput {
  readonly kind: VoiceTraceEntryKind;
  readonly title: string;
  readonly text?: string | undefined;
  readonly callId?: string | undefined;
  readonly details?: string | undefined;
}

interface VoiceTraceState {
  readonly sessions: readonly VoiceTraceSession[];
  readonly activeSessionId: string | null;
  readonly startSession: (input: StartVoiceTraceInput) => string;
  readonly appendEntry: (sessionId: string, input: AppendVoiceTraceEntryInput) => void;
  readonly upsertEntry: (
    sessionId: string,
    entryId: string,
    input: AppendVoiceTraceEntryInput,
  ) => void;
  readonly completeSession: (sessionId: string, status?: "completed" | "error") => void;
  readonly clearHistory: () => void;
}

function clampText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_ENTRY_TEXT_LENGTH
    ? `${value.slice(0, MAX_ENTRY_TEXT_LENGTH)}\n[trace value truncated]`
    : value;
}

export function trimVoiceTraceSessions(
  sessions: readonly VoiceTraceSession[],
): readonly VoiceTraceSession[] {
  return sessions.slice(0, MAX_SESSIONS).map((session) => ({
    ...session,
    entries: trimVoiceTraceEntries(session.entries),
  }));
}

function trimVoiceTraceEntries(entries: readonly VoiceTraceEntry[]): readonly VoiceTraceEntry[] {
  const kept: VoiceTraceEntry[] = [];
  let textLength = 0;
  for (const entry of entries.slice(-MAX_ENTRIES_PER_SESSION).toReversed()) {
    const entryLength =
      entry.title.length + (entry.text?.length ?? 0) + (entry.details?.length ?? 0);
    if (kept.length > 0 && textLength + entryLength > MAX_SESSION_TEXT_LENGTH) break;
    kept.push(entry);
    textLength += entryLength;
  }
  return kept.toReversed();
}

function makeTraceEntry(id: string, input: AppendVoiceTraceEntryInput): VoiceTraceEntry {
  return {
    id,
    timestamp: new Date().toISOString(),
    kind: input.kind,
    title: input.title,
    ...(input.text === undefined ? {} : { text: clampText(input.text) }),
    ...(input.callId === undefined ? {} : { callId: input.callId }),
    ...(input.details === undefined ? {} : { details: clampText(input.details) }),
  };
}

export function upsertVoiceTraceEntry(
  entries: readonly VoiceTraceEntry[],
  entry: VoiceTraceEntry,
): readonly VoiceTraceEntry[] {
  const existing = entries.find((item) => item.id === entry.id);
  if (!existing) return trimVoiceTraceEntries([...entries, entry]);

  return trimVoiceTraceEntries(
    entries.map((item) =>
      item.id === entry.id ? { ...entry, timestamp: existing.timestamp } : item,
    ),
  );
}

export const useVoiceTraceStore = create<VoiceTraceState>()(
  persist(
    (set) => ({
      sessions: [],
      activeSessionId: null,
      startSession: (input) => {
        const id = nextTraceId("session");
        const session: VoiceTraceSession = {
          id,
          startedAt: new Date().toISOString(),
          endedAt: null,
          status: "active",
          title: input.title,
          environmentId: input.environmentId,
          threadId: input.threadId,
          entries: [],
        };
        set((state) => ({
          activeSessionId: id,
          sessions: trimVoiceTraceSessions([session, ...state.sessions]),
        }));
        return id;
      },
      appendEntry: (sessionId, input) => {
        const entry = makeTraceEntry(nextTraceId("entry"), input);
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  entries: trimVoiceTraceEntries([...session.entries, entry]),
                }
              : session,
          ),
        }));
      },
      upsertEntry: (sessionId, entryId, input) => {
        const entry = makeTraceEntry(entryId, input);
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  entries: upsertVoiceTraceEntry(session.entries, entry),
                }
              : session,
          ),
        }));
      },
      completeSession: (sessionId, status = "completed") => {
        set((state) => ({
          activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
          sessions: state.sessions.map((session) =>
            session.id === sessionId
              ? { ...session, endedAt: new Date().toISOString(), status }
              : session,
          ),
        }));
      },
      clearHistory: () => set({ sessions: [], activeSessionId: null }),
    }),
    {
      name: "t3code:voice-traces:v2",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
      ),
      partialize: (state) => ({ sessions: state.sessions }),
    },
  ),
);
