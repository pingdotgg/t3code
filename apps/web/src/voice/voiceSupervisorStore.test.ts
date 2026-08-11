import { beforeEach, describe, expect, it } from "vite-plus/test";

import { decodeRealtimeServerEvent, type RealtimeServerEvent } from "./realtimeEvents";
import {
  MAX_VOICE_ACTIVITY_ENTRIES,
  MAX_VOICE_TRANSCRIPT_CHARS,
  MAX_VOICE_TRANSCRIPT_ENTRIES,
  useVoiceSupervisorStore,
} from "./voiceSupervisorStore";

function event(value: unknown): RealtimeServerEvent {
  const decoded = decodeRealtimeServerEvent(value);
  if (!decoded) throw new Error("Invalid Realtime event fixture");
  return decoded;
}

beforeEach(() => {
  useVoiceSupervisorStore.getState().reset();
});

describe("voiceSupervisorStore", () => {
  it("coalesces transcript deltas and replaces them with the final transcript", () => {
    const store = useVoiceSupervisorStore.getState();
    store.beginSession(3, 1);
    store.ingestEvent(
      3,
      event({
        event_id: "event-1",
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-user",
        delta: "Hello ",
      }),
      2,
    );
    store.ingestEvent(
      3,
      event({
        event_id: "event-2",
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-user",
        delta: "T3",
      }),
      3,
    );

    expect(useVoiceSupervisorStore.getState().transcript).toEqual([
      {
        id: "item-user",
        speaker: "user",
        text: "Hello T3",
        status: "streaming",
        updatedAt: 3,
      },
    ]);

    useVoiceSupervisorStore.getState().ingestEvent(
      3,
      event({
        event_id: "event-3",
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-user",
        transcript: "Hello T3 Code",
      }),
      4,
    );
    expect(useVoiceSupervisorStore.getState().transcript[0]).toMatchObject({
      text: "Hello T3 Code",
      status: "complete",
      updatedAt: 4,
    });
  });

  it("ignores stale generation events and state transitions", () => {
    const store = useVoiceSupervisorStore.getState();
    store.beginSession(9, 1);
    store.markConnected(8, 2);
    store.setMuted(8, true);
    store.ingestEvent(
      8,
      event({
        event_id: "stale",
        type: "session.created",
        session: { id: "stale-session" },
      }),
      3,
    );
    store.failSession(8, "stale failure", 4);
    store.endSession(8, 5);

    expect(useVoiceSupervisorStore.getState()).toMatchObject({
      generation: 9,
      phase: "connecting",
      muted: false,
      sessionId: null,
      errorMessage: null,
    });
    expect(useVoiceSupervisorStore.getState().activity).toHaveLength(1);
  });

  it("marks a transcript failed when the protocol supplies a sparse nested error", () => {
    const store = useVoiceSupervisorStore.getState();
    store.beginSession(5, 1);
    store.ingestEvent(
      5,
      event({
        event_id: "delta",
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-user",
        delta: "Partial",
      }),
      2,
    );
    store.ingestEvent(
      5,
      event({
        event_id: "failed",
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "item-user",
        error: {},
      }),
      3,
    );

    expect(useVoiceSupervisorStore.getState().transcript[0]).toMatchObject({
      id: "item-user",
      status: "failed",
      updatedAt: 3,
    });
    expect(useVoiceSupervisorStore.getState().activity.at(-1)).toMatchObject({
      kind: "error",
      label: "Speech transcription failed",
    });
  });

  it("keeps transcript text, entries, and activity strictly bounded", () => {
    useVoiceSupervisorStore.getState().beginSession(1, 0);
    useVoiceSupervisorStore.getState().ingestEvent(
      1,
      event({
        event_id: "long-delta",
        type: "response.output_audio_transcript.delta",
        response_id: "response-long",
        item_id: "assistant-long",
        delta: "x".repeat(MAX_VOICE_TRANSCRIPT_CHARS + 100),
      }),
      1,
    );
    expect(useVoiceSupervisorStore.getState().transcript[0]?.text).toHaveLength(
      MAX_VOICE_TRANSCRIPT_CHARS,
    );

    for (let index = 0; index < MAX_VOICE_TRANSCRIPT_ENTRIES + 10; index += 1) {
      useVoiceSupervisorStore.getState().ingestEvent(
        1,
        event({
          event_id: `transcript-${index}`,
          type: "conversation.item.input_audio_transcription.completed",
          item_id: `item-${index}`,
          transcript: `Transcript ${index}`,
        }),
        index + 2,
      );
    }
    expect(useVoiceSupervisorStore.getState().transcript).toHaveLength(
      MAX_VOICE_TRANSCRIPT_ENTRIES,
    );
    expect(useVoiceSupervisorStore.getState().transcript[0]?.id).toBe("item-10");

    for (let index = 0; index < MAX_VOICE_ACTIVITY_ENTRIES + 10; index += 1) {
      useVoiceSupervisorStore.getState().ingestEvent(
        1,
        event({
          event_id: `response-${index}`,
          type: "response.created",
          response: { id: `response-${index}`, status: "in_progress" },
        }),
        index + 200,
      );
    }
    expect(useVoiceSupervisorStore.getState().activity).toHaveLength(MAX_VOICE_ACTIVITY_ENTRIES);
    expect(useVoiceSupervisorStore.getState().activity.at(-1)?.id).toBe(
      `response-${MAX_VOICE_ACTIVITY_ENTRIES + 9}`,
    );
  });

  it("projects only serializable UI data and retains it after the session ends", () => {
    const store = useVoiceSupervisorStore.getState();
    store.beginSession(4, 1);
    store.markConnected(4, 2);
    store.setMuted(4, true);
    store.ingestEvent(
      4,
      event({
        event_id: "tool-response",
        type: "response.done",
        response: {
          id: "response-1",
          status: "completed",
          output: [
            {
              id: "tool-item",
              type: "function_call",
              call_id: "tool-call",
              name: "open_thread",
              arguments: '{"secret":"not projected"}',
              status: "completed",
            },
          ],
        },
      }),
      3,
    );
    store.endSession(4, 4);

    const state = useVoiceSupervisorStore.getState();
    expect(state).toMatchObject({ phase: "idle", muted: false, sessionId: null });
    expect(state.activity.some((entry) => entry.label === "Tool requested: open_thread")).toBe(
      true,
    );
    const projection = JSON.stringify({ transcript: state.transcript, activity: state.activity });
    expect(projection).not.toContain("not projected");
    expect(projection).not.toContain("peerConnection");
    expect(projection).not.toContain("dataChannel");
  });

  it("clears retained transcript and activity when the persistent host is torn down", () => {
    const store = useVoiceSupervisorStore.getState();
    store.beginSession(5, 1);
    store.ingestEvent(
      5,
      event({
        event_id: "completed-before-unmount",
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-before-unmount",
        transcript: "Retained only while the host exists",
      }),
      2,
    );
    expect(useVoiceSupervisorStore.getState().transcript).toHaveLength(1);
    expect(useVoiceSupervisorStore.getState().activity.length).toBeGreaterThan(0);

    store.reset();
    expect(useVoiceSupervisorStore.getState()).toMatchObject({
      generation: 0,
      phase: "idle",
      transcript: [],
      activity: [],
    });
  });
});
