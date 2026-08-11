import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  initialVoiceSupervisorData as sharedInitialVoiceSupervisorData,
  MAX_VOICE_ACTIVITY_ENTRIES as SHARED_MAX_VOICE_ACTIVITY_ENTRIES,
  MAX_VOICE_TRANSCRIPT_CHARS as SHARED_MAX_VOICE_TRANSCRIPT_CHARS,
  MAX_VOICE_TRANSCRIPT_ENTRIES as SHARED_MAX_VOICE_TRANSCRIPT_ENTRIES,
  reduceVoiceSupervisorState as sharedReduceVoiceSupervisorState,
} from "@t3tools/client-runtime/voice/voice-supervisor-state";
import {
  decodeRealtimeServerEvent,
  type RealtimeServerEvent,
} from "@t3tools/client-runtime/voice/realtime-events";

import {
  initialVoiceSupervisorData,
  MAX_VOICE_ACTIVITY_ENTRIES,
  MAX_VOICE_TRANSCRIPT_CHARS,
  MAX_VOICE_TRANSCRIPT_ENTRIES,
  reduceVoiceSupervisorState,
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

describe("voiceSupervisorStore adapter", () => {
  it("re-exports the shared reducer, initial data, and public bounds", () => {
    expect(reduceVoiceSupervisorState).toBe(sharedReduceVoiceSupervisorState);
    expect(initialVoiceSupervisorData).toBe(sharedInitialVoiceSupervisorData);
    expect(MAX_VOICE_ACTIVITY_ENTRIES).toBe(SHARED_MAX_VOICE_ACTIVITY_ENTRIES);
    expect(MAX_VOICE_TRANSCRIPT_ENTRIES).toBe(SHARED_MAX_VOICE_TRANSCRIPT_ENTRIES);
    expect(MAX_VOICE_TRANSCRIPT_CHARS).toBe(SHARED_MAX_VOICE_TRANSCRIPT_CHARS);
  });

  it("delegates every public action and preserves action identity through reset", () => {
    const initial = useVoiceSupervisorStore.getState();
    const actions = {
      beginSession: initial.beginSession,
      markConnected: initial.markConnected,
      setMuted: initial.setMuted,
      ingestEvent: initial.ingestEvent,
      failSession: initial.failSession,
      endSession: initial.endSession,
      reset: initial.reset,
    };

    actions.beginSession(4, 1);
    actions.markConnected(4, 2);
    actions.setMuted(4, true);
    actions.ingestEvent(
      4,
      event({
        event_id: "completed",
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-user",
        transcript: "Keep this until reset",
      }),
      3,
    );
    actions.failSession(4, "Temporary failure", 4);
    actions.endSession(4, 5);

    expect(useVoiceSupervisorStore.getState()).toMatchObject({
      generation: 4,
      phase: "idle",
      muted: false,
      sessionId: null,
      errorMessage: null,
      transcript: [
        {
          id: "item-user",
          speaker: "user",
          text: "Keep this until reset",
          status: "complete",
          updatedAt: 3,
        },
      ],
    });

    actions.reset();
    const reset = useVoiceSupervisorStore.getState();
    expect(reset).toMatchObject(initialVoiceSupervisorData);
    expect(reset.transcript).toBe(initialVoiceSupervisorData.transcript);
    expect(reset.activity).toBe(initialVoiceSupervisorData.activity);
    expect(Object.isFrozen(reset.transcript)).toBe(true);
    expect(Object.isFrozen(reset.activity)).toBe(true);
    expect(() => Reflect.apply(Array.prototype.push, reset.transcript, ["poison"])).toThrow(
      TypeError,
    );
    expect(() => Reflect.apply(Array.prototype.push, reset.activity, ["poison"])).toThrow(
      TypeError,
    );
    expect(reset.transcript).toEqual([]);
    expect(reset.activity).toEqual([]);
    expect(reset.beginSession).toBe(actions.beginSession);
    expect(reset.markConnected).toBe(actions.markConnected);
    expect(reset.setMuted).toBe(actions.setMuted);
    expect(reset.ingestEvent).toBe(actions.ingestEvent);
    expect(reset.failSession).toBe(actions.failSession);
    expect(reset.endSession).toBe(actions.endSession);
    expect(reset.reset).toBe(actions.reset);
  });

  it("uses explicit zero timestamps and Date.now only when a timestamp is omitted", () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(101).mockReturnValueOnce(102);

    useVoiceSupervisorStore.getState().beginSession(1, 0);
    expect(useVoiceSupervisorStore.getState().activity[0]?.at).toBe(0);
    expect(now).not.toHaveBeenCalled();

    useVoiceSupervisorStore.getState().beginSession(2);
    useVoiceSupervisorStore.getState().markConnected(2);
    expect(useVoiceSupervisorStore.getState().activity.map((entry) => entry.at)).toEqual([
      101, 102,
    ]);
    expect(now).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("rejects stale and duplicate actions without reading the clock or notifying subscribers", () => {
    useVoiceSupervisorStore.getState().beginSession(9, 1);
    useVoiceSupervisorStore.getState().markConnected(9, 2);
    const state = useVoiceSupervisorStore.getState();
    const subscriber = vi.fn();
    const unsubscribe = useVoiceSupervisorStore.subscribe(subscriber);
    const now = vi.spyOn(Date, "now");

    state.markConnected(9);
    state.markConnected(8);
    state.setMuted(8, true);
    state.ingestEvent(
      8,
      event({
        event_id: "stale",
        type: "session.created",
        session: { id: "stale-session" },
      }),
    );
    state.failSession(8, "stale failure");
    state.endSession(8);

    expect(useVoiceSupervisorStore.getState()).toBe(state);
    expect(now).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();

    state.endSession(9, 10);
    const ended = useVoiceSupervisorStore.getState();
    subscriber.mockClear();
    ended.ingestEvent(
      9,
      event({
        event_id: "late-session",
        type: "session.created",
        session: { id: "late-session" },
      }),
    );
    expect(useVoiceSupervisorStore.getState()).toBe(ended);
    expect(now).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
    now.mockRestore();
    unsubscribe();
  });
});
