import { create } from "zustand";

import { extractRealtimeFunctionCalls, type RealtimeServerEvent } from "./realtimeEvents";

export const MAX_VOICE_TRANSCRIPT_ENTRIES = 120;
export const MAX_VOICE_ACTIVITY_ENTRIES = 80;
export const MAX_VOICE_TRANSCRIPT_CHARS = 12_000;

const MAX_VOICE_ACTIVITY_LABEL_CHARS = 240;

export type VoiceSupervisorPhase = "idle" | "connecting" | "connected" | "failed";
export type VoiceTranscriptSpeaker = "user" | "assistant";
export type VoiceTranscriptStatus = "streaming" | "complete" | "failed";
export type VoiceActivityKind = "session" | "speech" | "response" | "tool" | "error";

export interface VoiceTranscriptEntry {
  readonly id: string;
  readonly speaker: VoiceTranscriptSpeaker;
  readonly text: string;
  readonly status: VoiceTranscriptStatus;
  readonly updatedAt: number;
}

export interface VoiceActivityEntry {
  readonly id: string;
  readonly kind: VoiceActivityKind;
  readonly label: string;
  readonly at: number;
}

export interface VoiceSupervisorStoreState {
  readonly generation: number;
  readonly phase: VoiceSupervisorPhase;
  readonly muted: boolean;
  readonly sessionId: string | null;
  readonly errorMessage: string | null;
  readonly transcript: ReadonlyArray<VoiceTranscriptEntry>;
  readonly activity: ReadonlyArray<VoiceActivityEntry>;
  readonly beginSession: (generation: number, at?: number) => void;
  readonly markConnected: (generation: number, at?: number) => void;
  readonly setMuted: (generation: number, muted: boolean) => void;
  readonly ingestEvent: (generation: number, event: RealtimeServerEvent, at?: number) => void;
  readonly failSession: (generation: number, message: string, at?: number) => void;
  readonly endSession: (generation: number, at?: number) => void;
  readonly reset: () => void;
}

interface VoiceSupervisorData {
  readonly generation: number;
  readonly phase: VoiceSupervisorPhase;
  readonly muted: boolean;
  readonly sessionId: string | null;
  readonly errorMessage: string | null;
  readonly transcript: ReadonlyArray<VoiceTranscriptEntry>;
  readonly activity: ReadonlyArray<VoiceActivityEntry>;
}

const initialData: VoiceSupervisorData = {
  generation: 0,
  phase: "idle",
  muted: false,
  sessionId: null,
  errorMessage: null,
  transcript: [],
  activity: [],
};

const eventTime = (at: number | undefined) => at ?? Date.now();

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function appendActivity(
  activity: ReadonlyArray<VoiceActivityEntry>,
  entry: VoiceActivityEntry,
): ReadonlyArray<VoiceActivityEntry> {
  const next = [
    ...activity,
    { ...entry, label: clipText(entry.label, MAX_VOICE_ACTIVITY_LABEL_CHARS) },
  ];
  return next.length > MAX_VOICE_ACTIVITY_ENTRIES
    ? next.slice(next.length - MAX_VOICE_ACTIVITY_ENTRIES)
    : next;
}

function upsertTranscript(
  transcript: ReadonlyArray<VoiceTranscriptEntry>,
  input: {
    readonly id: string;
    readonly speaker: VoiceTranscriptSpeaker;
    readonly text: string;
    readonly status: VoiceTranscriptStatus;
    readonly updatedAt: number;
    readonly append: boolean;
  },
): ReadonlyArray<VoiceTranscriptEntry> {
  const index = transcript.findIndex(
    (entry) => entry.id === input.id && entry.speaker === input.speaker,
  );
  const previous = index >= 0 ? transcript[index] : undefined;
  const text = clipText(
    input.append && previous ? `${previous.text}${input.text}` : input.text,
    MAX_VOICE_TRANSCRIPT_CHARS,
  );
  const entry: VoiceTranscriptEntry = {
    id: input.id,
    speaker: input.speaker,
    text,
    status: input.status,
    updatedAt: input.updatedAt,
  };

  if (index >= 0) {
    const next = transcript.slice();
    next[index] = entry;
    return next;
  }
  const next = [...transcript, entry];
  return next.length > MAX_VOICE_TRANSCRIPT_ENTRIES
    ? next.slice(next.length - MAX_VOICE_TRANSCRIPT_ENTRIES)
    : next;
}

function markTranscriptFailed(
  transcript: ReadonlyArray<VoiceTranscriptEntry>,
  itemId: string,
  updatedAt: number,
): ReadonlyArray<VoiceTranscriptEntry> {
  const index = transcript.findIndex((entry) => entry.id === itemId && entry.speaker === "user");
  if (index < 0) return transcript;
  const entry = transcript[index];
  if (!entry) return transcript;
  const next = transcript.slice();
  next[index] = { ...entry, status: "failed", updatedAt };
  return next;
}

function reduceRealtimeEvent(
  state: VoiceSupervisorStoreState,
  event: RealtimeServerEvent,
  at: number,
): Partial<VoiceSupervisorStoreState> {
  switch (event.type) {
    case "session.created":
      return {
        sessionId: event.session.id,
        phase: "connected",
        errorMessage: null,
        ...(state.phase === "connected"
          ? {}
          : {
              activity: appendActivity(state.activity, {
                id: event.event_id,
                kind: "session",
                label: "Voice session connected",
                at,
              }),
            }),
      };
    case "session.updated":
      return { sessionId: event.session.id };
    case "input_audio_buffer.speech_started":
      return {
        activity: appendActivity(state.activity, {
          id: event.event_id,
          kind: "speech",
          label: "Listening",
          at,
        }),
      };
    case "input_audio_buffer.speech_stopped":
      return {
        activity: appendActivity(state.activity, {
          id: event.event_id,
          kind: "speech",
          label: "Processing speech",
          at,
        }),
      };
    case "conversation.item.input_audio_transcription.delta":
      return {
        transcript: upsertTranscript(state.transcript, {
          id: event.item_id,
          speaker: "user",
          text: event.delta,
          status: "streaming",
          updatedAt: at,
          append: true,
        }),
      };
    case "conversation.item.input_audio_transcription.completed":
      return {
        transcript: upsertTranscript(state.transcript, {
          id: event.item_id,
          speaker: "user",
          text: event.transcript,
          status: "complete",
          updatedAt: at,
          append: false,
        }),
        activity: appendActivity(state.activity, {
          id: event.event_id,
          kind: "speech",
          label: "Transcript ready",
          at,
        }),
      };
    case "conversation.item.input_audio_transcription.failed":
      return {
        transcript: markTranscriptFailed(state.transcript, event.item_id, at),
        activity: appendActivity(state.activity, {
          id: event.event_id,
          kind: "error",
          label: "Speech transcription failed",
          at,
        }),
      };
    case "response.output_audio_transcript.delta":
      return {
        transcript: upsertTranscript(state.transcript, {
          id: event.item_id,
          speaker: "assistant",
          text: event.delta,
          status: "streaming",
          updatedAt: at,
          append: true,
        }),
      };
    case "response.output_audio_transcript.done":
      return {
        transcript: upsertTranscript(state.transcript, {
          id: event.item_id,
          speaker: "assistant",
          text: event.transcript,
          status: "complete",
          updatedAt: at,
          append: false,
        }),
      };
    case "response.created":
      return {
        activity: appendActivity(state.activity, {
          id: event.event_id,
          kind: "response",
          label: "Agent responding",
          at,
        }),
      };
    case "response.done": {
      let activity = appendActivity(state.activity, {
        id: event.event_id,
        kind: "response",
        label: event.response.status === "completed" ? "Response completed" : "Response ended",
        at,
      });
      for (const call of extractRealtimeFunctionCalls(event)) {
        activity = appendActivity(activity, {
          id: `${event.event_id}:tool:${call.callId}`,
          kind: "tool",
          label: `Tool requested: ${call.name}`,
          at,
        });
      }
      return { activity };
    }
    case "error":
      return {
        activity: appendActivity(state.activity, {
          id: event.event_id,
          kind: "error",
          label: "The voice provider reported an error",
          at,
        }),
      };
  }
}

export const useVoiceSupervisorStore = create<VoiceSupervisorStoreState>()((set) => ({
  ...initialData,
  beginSession: (generation, at) =>
    set({
      generation,
      phase: "connecting",
      muted: false,
      sessionId: null,
      errorMessage: null,
      transcript: [],
      activity: [
        {
          id: `session:${generation}:connecting`,
          kind: "session",
          label: "Connecting voice session",
          at: eventTime(at),
        },
      ],
    }),
  markConnected: (generation, at) =>
    set((state) => {
      if (state.generation !== generation) return state;
      if (state.phase === "connected" && state.errorMessage === null) return state;
      return {
        phase: "connected",
        errorMessage: null,
        activity: appendActivity(state.activity, {
          id: `session:${generation}:connected`,
          kind: "session",
          label: "Voice connection ready",
          at: eventTime(at),
        }),
      };
    }),
  setMuted: (generation, muted) =>
    set((state) => (state.generation === generation ? { muted } : state)),
  ingestEvent: (generation, event, at) =>
    set((state) => {
      if (state.generation !== generation) return state;
      return reduceRealtimeEvent(state, event, eventTime(at));
    }),
  failSession: (generation, message, at) =>
    set((state) => {
      if (state.generation !== generation) return state;
      const safeMessage = clipText(message, MAX_VOICE_ACTIVITY_LABEL_CHARS);
      return {
        phase: "failed",
        errorMessage: safeMessage,
        activity: appendActivity(state.activity, {
          id: `session:${generation}:failed`,
          kind: "error",
          label: safeMessage,
          at: eventTime(at),
        }),
      };
    }),
  endSession: (generation, at) =>
    set((state) => {
      if (state.generation !== generation) return state;
      return {
        phase: "idle",
        muted: false,
        sessionId: null,
        errorMessage: null,
        activity: appendActivity(state.activity, {
          id: `session:${generation}:ended`,
          kind: "session",
          label: "Voice session ended",
          at: eventTime(at),
        }),
      };
    }),
  reset: () => set(initialData),
}));
