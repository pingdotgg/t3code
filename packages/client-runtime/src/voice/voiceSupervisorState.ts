import { extractRealtimeFunctionCalls, type RealtimeServerEvent } from "./realtimeEvents.ts";
import { MAX_VOICE_TRANSCRIPT_CHARS } from "./voiceSupervisorHost.ts";

export const MAX_VOICE_TRANSCRIPT_ENTRIES = 120;
export const MAX_VOICE_ACTIVITY_ENTRIES = 80;
export const MAX_VOICE_ACTIVITY_LABEL_CHARS = 240;
export { MAX_VOICE_TRANSCRIPT_CHARS };

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

export interface VoiceSupervisorData {
  readonly generation: number;
  readonly phase: VoiceSupervisorPhase;
  readonly muted: boolean;
  readonly sessionId: string | null;
  readonly errorMessage: string | null;
  readonly transcript: ReadonlyArray<VoiceTranscriptEntry>;
  readonly activity: ReadonlyArray<VoiceActivityEntry>;
}

export type VoiceSupervisorAction =
  | {
      readonly type: "begin-session";
      readonly generation: number;
      readonly at: number;
    }
  | {
      readonly type: "mark-connected";
      readonly generation: number;
      readonly at: number;
    }
  | {
      readonly type: "set-muted";
      readonly generation: number;
      readonly muted: boolean;
    }
  | {
      readonly type: "ingest-event";
      readonly generation: number;
      readonly event: RealtimeServerEvent;
      readonly at: number;
    }
  | {
      readonly type: "fail-session";
      readonly generation: number;
      readonly message: string;
      readonly at: number;
    }
  | {
      readonly type: "end-session";
      readonly generation: number;
      readonly at: number;
    }
  | { readonly type: "reset" };

const EMPTY_VOICE_TRANSCRIPT: ReadonlyArray<VoiceTranscriptEntry> = Object.freeze([]);
const EMPTY_VOICE_ACTIVITY: ReadonlyArray<VoiceActivityEntry> = Object.freeze([]);

export const initialVoiceSupervisorData: VoiceSupervisorData = Object.freeze({
  generation: 0,
  phase: "idle",
  muted: false,
  sessionId: null,
  errorMessage: null,
  transcript: EMPTY_VOICE_TRANSCRIPT,
  activity: EMPTY_VOICE_ACTIVITY,
});

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
  state: VoiceSupervisorData,
  event: RealtimeServerEvent,
  at: number,
): Partial<VoiceSupervisorData> {
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

export function reduceVoiceSupervisorState(
  state: VoiceSupervisorData,
  action: VoiceSupervisorAction,
): VoiceSupervisorData {
  switch (action.type) {
    case "begin-session":
      return {
        generation: action.generation,
        phase: "connecting",
        muted: false,
        sessionId: null,
        errorMessage: null,
        transcript: [],
        activity: [
          {
            id: `session:${action.generation}:connecting`,
            kind: "session",
            label: "Connecting voice session",
            at: action.at,
          },
        ],
      };
    case "mark-connected":
      if (state.generation !== action.generation) return state;
      if (state.phase === "connected" && state.errorMessage === null) return state;
      return {
        ...state,
        phase: "connected",
        errorMessage: null,
        activity: appendActivity(state.activity, {
          id: `session:${action.generation}:connected`,
          kind: "session",
          label: "Voice connection ready",
          at: action.at,
        }),
      };
    case "set-muted":
      if (state.generation !== action.generation) return state;
      return { ...state, muted: action.muted };
    case "ingest-event":
      if (state.generation !== action.generation) return state;
      return { ...state, ...reduceRealtimeEvent(state, action.event, action.at) };
    case "fail-session": {
      if (state.generation !== action.generation) return state;
      const safeMessage = clipText(action.message, MAX_VOICE_ACTIVITY_LABEL_CHARS);
      return {
        ...state,
        phase: "failed",
        errorMessage: safeMessage,
        activity: appendActivity(state.activity, {
          id: `session:${action.generation}:failed`,
          kind: "error",
          label: safeMessage,
          at: action.at,
        }),
      };
    }
    case "end-session":
      if (state.generation !== action.generation) return state;
      return {
        ...state,
        phase: "idle",
        muted: false,
        sessionId: null,
        errorMessage: null,
        activity: appendActivity(state.activity, {
          id: `session:${action.generation}:ended`,
          kind: "session",
          label: "Voice session ended",
          at: action.at,
        }),
      };
    case "reset":
      return initialVoiceSupervisorData;
  }
}
