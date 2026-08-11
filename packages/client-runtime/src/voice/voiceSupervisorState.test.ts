import { describe, expect, it } from "@effect/vitest";

import { decodeRealtimeServerEvent, type RealtimeServerEvent } from "./realtimeEvents.ts";
import {
  initialVoiceSupervisorData,
  MAX_VOICE_ACTIVITY_ENTRIES,
  MAX_VOICE_ACTIVITY_LABEL_CHARS,
  MAX_VOICE_TRANSCRIPT_CHARS,
  MAX_VOICE_TRANSCRIPT_ENTRIES,
  reduceVoiceSupervisorState,
  type VoiceSupervisorAction,
  type VoiceSupervisorData,
} from "./voiceSupervisorState.ts";

function event(value: unknown): RealtimeServerEvent {
  const decoded = decodeRealtimeServerEvent(value);
  if (!decoded) throw new Error("Invalid Realtime event fixture");
  return decoded;
}

function beginSession(generation = 1, at = 0): VoiceSupervisorData {
  return reduceVoiceSupervisorState(initialVoiceSupervisorData, {
    type: "begin-session",
    generation,
    at,
  });
}

describe("reduceVoiceSupervisorState", () => {
  it("keeps the exported reset singleton and its arrays safe from mutation", () => {
    expect(Object.isFrozen(initialVoiceSupervisorData)).toBe(true);
    expect(Object.isFrozen(initialVoiceSupervisorData.transcript)).toBe(true);
    expect(Object.isFrozen(initialVoiceSupervisorData.activity)).toBe(true);
    expect(Reflect.set(initialVoiceSupervisorData, "generation", 999)).toBe(false);
    expect(() =>
      Reflect.apply(Array.prototype.push, initialVoiceSupervisorData.transcript, [
        {
          id: "poison-transcript",
          speaker: "user",
          text: "must not persist",
          status: "complete",
          updatedAt: 1,
        },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(Array.prototype.push, initialVoiceSupervisorData.activity, [
        {
          id: "poison-activity",
          kind: "error",
          label: "must not persist",
          at: 1,
        },
      ]),
    ).toThrow(TypeError);

    const populated = reduceVoiceSupervisorState(beginSession(1, 1), {
      type: "ingest-event",
      generation: 1,
      event: event({
        event_id: "completed",
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-user",
        transcript: "Temporary transcript",
      }),
      at: 2,
    });
    const reset = reduceVoiceSupervisorState(populated, { type: "reset" });
    expect(reset).toBe(initialVoiceSupervisorData);
    expect(reset).toEqual({
      generation: 0,
      phase: "idle",
      muted: false,
      sessionId: null,
      errorMessage: null,
      transcript: [],
      activity: [],
    });
  });

  it("preserves the complete session lifecycle and reset behavior", () => {
    expect(initialVoiceSupervisorData).toEqual({
      generation: 0,
      phase: "idle",
      muted: false,
      sessionId: null,
      errorMessage: null,
      transcript: [],
      activity: [],
    });

    let state = beginSession(3, 1);
    expect(state).toEqual({
      generation: 3,
      phase: "connecting",
      muted: false,
      sessionId: null,
      errorMessage: null,
      transcript: [],
      activity: [
        {
          id: "session:3:connecting",
          kind: "session",
          label: "Connecting voice session",
          at: 1,
        },
      ],
    });

    state = reduceVoiceSupervisorState(state, { type: "mark-connected", generation: 3, at: 2 });
    state = reduceVoiceSupervisorState(state, { type: "set-muted", generation: 3, muted: true });
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 3,
      event: event({
        event_id: "session-created",
        type: "session.created",
        session: { id: "session-3" },
      }),
      at: 3,
    });

    expect(state).toMatchObject({
      phase: "connected",
      muted: true,
      sessionId: "session-3",
      errorMessage: null,
    });
    expect(state.activity.map((entry) => entry.label)).toEqual([
      "Connecting voice session",
      "Voice connection ready",
    ]);

    state = reduceVoiceSupervisorState(state, { type: "end-session", generation: 3, at: 4 });
    expect(state).toMatchObject({
      generation: 3,
      phase: "idle",
      muted: false,
      sessionId: null,
      errorMessage: null,
    });
    expect(state.activity.at(-1)).toEqual({
      id: "session:3:ended",
      kind: "session",
      label: "Voice session ended",
      at: 4,
    });

    expect(reduceVoiceSupervisorState(state, { type: "reset" })).toBe(initialVoiceSupervisorData);
  });

  it("coalesces both speakers' transcript deltas and replaces them with final text", () => {
    let state = beginSession(3, 1);
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 3,
      event: event({
        event_id: "user-1",
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-user",
        delta: "Hello ",
      }),
      at: 2,
    });
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 3,
      event: event({
        event_id: "user-2",
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-user",
        delta: "T3",
      }),
      at: 3,
    });
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 3,
      event: event({
        event_id: "user-final",
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-user",
        transcript: "Hello T3 Code",
      }),
      at: 4,
    });
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 3,
      event: event({
        event_id: "assistant-1",
        type: "response.output_audio_transcript.delta",
        response_id: "response-1",
        item_id: "item-assistant",
        delta: "On ",
      }),
      at: 5,
    });
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 3,
      event: event({
        event_id: "assistant-2",
        type: "response.output_audio_transcript.delta",
        response_id: "response-1",
        item_id: "item-assistant",
        delta: "it",
      }),
      at: 6,
    });
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 3,
      event: event({
        event_id: "assistant-final",
        type: "response.output_audio_transcript.done",
        response_id: "response-1",
        item_id: "item-assistant",
        transcript: "On it now",
      }),
      at: 7,
    });

    expect(state.transcript).toEqual([
      {
        id: "item-user",
        speaker: "user",
        text: "Hello T3 Code",
        status: "complete",
        updatedAt: 4,
      },
      {
        id: "item-assistant",
        speaker: "assistant",
        text: "On it now",
        status: "complete",
        updatedAt: 7,
      },
    ]);
  });

  it("returns the same object for every stale generation action and settled connect duplicate", () => {
    const state = beginSession(9, 1);
    const staleEvent = event({
      event_id: "stale",
      type: "session.created",
      session: { id: "stale-session" },
    });
    const staleActions: ReadonlyArray<VoiceSupervisorAction> = [
      { type: "mark-connected", generation: 8, at: 2 },
      { type: "set-muted", generation: 8, muted: true },
      { type: "ingest-event", generation: 8, event: staleEvent, at: 3 },
      { type: "fail-session", generation: 8, message: "stale failure", at: 4 },
      { type: "end-session", generation: 8, at: 5 },
    ];

    for (const action of staleActions) {
      expect(reduceVoiceSupervisorState(state, action)).toBe(state);
    }

    const connected = reduceVoiceSupervisorState(state, {
      type: "mark-connected",
      generation: 9,
      at: 6,
    });
    expect(
      reduceVoiceSupervisorState(connected, {
        type: "mark-connected",
        generation: 9,
        at: 7,
      }),
    ).toBe(connected);
  });

  it("marks sparse transcription failures without requiring nested error fields", () => {
    let state = beginSession(5, 1);
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 5,
      event: event({
        event_id: "delta",
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-user",
        delta: "Partial",
      }),
      at: 2,
    });
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 5,
      event: event({
        event_id: "failed",
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "item-user",
        error: {},
      }),
      at: 3,
    });

    expect(state.transcript[0]).toEqual({
      id: "item-user",
      speaker: "user",
      text: "Partial",
      status: "failed",
      updatedAt: 3,
    });
    expect(state.activity.at(-1)).toMatchObject({
      kind: "error",
      label: "Speech transcription failed",
    });

    const transcript = state.transcript;
    const missing = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 5,
      event: event({
        event_id: "missing-failed",
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "missing-item",
        error: {},
      }),
      at: 4,
    });
    expect(missing.transcript).toBe(transcript);
    expect(missing.activity.at(-1)?.id).toBe("missing-failed");
  });

  it("keeps transcript text, transcript entries, activity, and labels strictly bounded", () => {
    let state = beginSession(1, 0);
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 1,
      event: event({
        event_id: "long-delta",
        type: "response.output_audio_transcript.delta",
        response_id: "response-long",
        item_id: "assistant-long",
        delta: "x".repeat(MAX_VOICE_TRANSCRIPT_CHARS + 100),
      }),
      at: 1,
    });
    expect(state.transcript[0]?.text).toHaveLength(MAX_VOICE_TRANSCRIPT_CHARS);
    expect(state.transcript[0]?.text.endsWith("…")).toBe(true);

    for (let index = 0; index < MAX_VOICE_TRANSCRIPT_ENTRIES + 10; index += 1) {
      state = reduceVoiceSupervisorState(state, {
        type: "ingest-event",
        generation: 1,
        event: event({
          event_id: `transcript-${index}`,
          type: "conversation.item.input_audio_transcription.completed",
          item_id: `item-${index}`,
          transcript: `Transcript ${index}`,
        }),
        at: index + 2,
      });
    }
    expect(state.transcript).toHaveLength(MAX_VOICE_TRANSCRIPT_ENTRIES);
    expect(state.transcript[0]?.id).toBe("item-10");

    for (let index = 0; index < MAX_VOICE_ACTIVITY_ENTRIES + 10; index += 1) {
      state = reduceVoiceSupervisorState(state, {
        type: "ingest-event",
        generation: 1,
        event: event({
          event_id: `response-${index}`,
          type: "response.created",
          response: { id: `response-${index}`, status: "in_progress" },
        }),
        at: index + 200,
      });
    }
    expect(state.activity).toHaveLength(MAX_VOICE_ACTIVITY_ENTRIES);
    expect(state.activity.at(-1)?.id).toBe(`response-${MAX_VOICE_ACTIVITY_ENTRIES + 9}`);

    state = reduceVoiceSupervisorState(state, {
      type: "fail-session",
      generation: 1,
      message: "z".repeat(MAX_VOICE_ACTIVITY_LABEL_CHARS + 100),
      at: 400,
    });
    expect(state.errorMessage).toHaveLength(MAX_VOICE_ACTIVITY_LABEL_CHARS);
    expect(state.errorMessage?.endsWith("…")).toBe(true);
    expect(state.activity.at(-1)?.label).toBe(state.errorMessage);
  });

  it("projects activity labels in event order without retaining tool arguments", () => {
    let state = beginSession(4, 1);
    const events: ReadonlyArray<readonly [RealtimeServerEvent, number]> = [
      [
        event({
          event_id: "created",
          type: "session.created",
          session: { id: "session-4" },
        }),
        2,
      ],
      [
        event({
          event_id: "updated",
          type: "session.updated",
          session: { id: "session-4-updated" },
        }),
        3,
      ],
      [
        event({
          event_id: "speech-started",
          type: "input_audio_buffer.speech_started",
          item_id: "speech-item",
          audio_start_ms: 0,
        }),
        4,
      ],
      [
        event({
          event_id: "speech-stopped",
          type: "input_audio_buffer.speech_stopped",
          item_id: "speech-item",
          audio_end_ms: 200,
        }),
        5,
      ],
      [
        event({
          event_id: "response-created",
          type: "response.created",
          response: { id: "response-1", status: "in_progress" },
        }),
        6,
      ],
      [
        event({
          event_id: "response-done",
          type: "response.done",
          response: {
            id: "response-1",
            status: "completed",
            output: [
              {
                id: "tool-1",
                type: "function_call",
                call_id: "call-1",
                name: "list_threads",
                arguments: '{"secret":"first"}',
                status: "completed",
              },
              {
                id: "tool-2",
                type: "function_call",
                call_id: "call-2",
                name: "open_thread",
                arguments: '{"secret":"second"}',
                status: "completed",
              },
            ],
          },
        }),
        7,
      ],
      [
        event({
          event_id: "provider-error",
          type: "error",
          error: {},
        }),
        8,
      ],
    ];

    for (const [realtimeEvent, at] of events) {
      state = reduceVoiceSupervisorState(state, {
        type: "ingest-event",
        generation: 4,
        event: realtimeEvent,
        at,
      });
    }

    expect(state.sessionId).toBe("session-4-updated");
    expect(state.activity).toEqual([
      {
        id: "session:4:connecting",
        kind: "session",
        label: "Connecting voice session",
        at: 1,
      },
      { id: "created", kind: "session", label: "Voice session connected", at: 2 },
      { id: "speech-started", kind: "speech", label: "Listening", at: 4 },
      { id: "speech-stopped", kind: "speech", label: "Processing speech", at: 5 },
      { id: "response-created", kind: "response", label: "Agent responding", at: 6 },
      { id: "response-done", kind: "response", label: "Response completed", at: 7 },
      {
        id: "response-done:tool:call-1",
        kind: "tool",
        label: "Tool requested: list_threads",
        at: 7,
      },
      {
        id: "response-done:tool:call-2",
        kind: "tool",
        label: "Tool requested: open_thread",
        at: 7,
      },
      {
        id: "provider-error",
        kind: "error",
        label: "The voice provider reported an error",
        at: 8,
      },
    ]);
    const projection = JSON.stringify({ transcript: state.transcript, activity: state.activity });
    expect(projection).not.toContain("first");
    expect(projection).not.toContain("second");
    expect(projection).not.toContain("peerConnection");
    expect(projection).not.toContain("dataChannel");

    const ended = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 4,
      event: event({
        event_id: "response-failed",
        type: "response.done",
        response: {
          id: "response-2",
          status: "failed",
          output: [
            {
              id: "ignored-tool",
              type: "function_call",
              call_id: "ignored-call",
              name: "interrupt_thread",
              arguments: "{}",
              status: "completed",
            },
          ],
        },
      }),
      at: 9,
    });
    expect(ended.activity.at(-1)).toEqual({
      id: "response-failed",
      kind: "response",
      label: "Response ended",
      at: 9,
    });
  });

  it("retains projected history on end and clears it when a new session begins", () => {
    let state = beginSession(5, 1);
    state = reduceVoiceSupervisorState(state, {
      type: "ingest-event",
      generation: 5,
      event: event({
        event_id: "completed-before-stop",
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-before-stop",
        transcript: "Retained until another session starts",
      }),
      at: 2,
    });
    const transcript = state.transcript;

    state = reduceVoiceSupervisorState(state, { type: "end-session", generation: 5, at: 3 });
    expect(state.transcript).toBe(transcript);
    expect(state.activity.at(-1)?.label).toBe("Voice session ended");

    state = reduceVoiceSupervisorState(state, { type: "begin-session", generation: 6, at: 4 });
    expect(state).toMatchObject({
      generation: 6,
      phase: "connecting",
      transcript: [],
      errorMessage: null,
    });
    expect(state.activity).toEqual([
      {
        id: "session:6:connecting",
        kind: "session",
        label: "Connecting voice session",
        at: 4,
      },
    ]);
  });
});
