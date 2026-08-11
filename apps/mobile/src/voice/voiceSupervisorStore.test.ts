import { decodeRealtimeServerEvent } from "@t3tools/client-runtime/voice/realtime-events";
import {
  initialVoiceSupervisorData,
  MAX_VOICE_TRANSCRIPT_ENTRIES,
} from "@t3tools/client-runtime/voice/voice-supervisor-state";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createMobileVoiceSupervisorStore } from "./voiceSupervisorStore";

function completedTranscript(index: number) {
  const event = decodeRealtimeServerEvent({
    event_id: `event-${index}`,
    type: "conversation.item.input_audio_transcription.completed",
    item_id: `item-${index}`,
    transcript: `Transcript ${index}`,
  });
  if (event === null) throw new Error("Invalid transcript fixture.");
  return event;
}

describe("mobile voice supervisor Effect Atom store", () => {
  it("projects shared state, rejects stale generations, and resets retained history", () => {
    const registry = AtomRegistry.make();
    const store = createMobileVoiceSupervisorStore(registry);
    const subscriber = vi.fn();
    const unsubscribe = registry.subscribe(store.dataAtom, subscriber);

    store.projector.beginSession(4, 1);
    store.projector.markConnected(4, 2);
    store.projector.ingestEvent(4, completedTranscript(1), 3);
    const current = registry.get(store.dataAtom);
    expect(current).toMatchObject({
      generation: 4,
      phase: "connected",
      transcript: [{ id: "item-1", text: "Transcript 1", status: "complete" }],
    });

    subscriber.mockClear();
    store.projector.failSession(3, "stale", 4);
    store.projector.setMuted(3, true);
    expect(registry.get(store.dataAtom)).toBe(current);
    expect(subscriber).not.toHaveBeenCalled();

    store.projector.endSession(4, 5);
    const ended = registry.get(store.dataAtom);
    subscriber.mockClear();
    const now = vi.spyOn(Date, "now");
    store.projector.ingestEvent(4, completedTranscript(2));
    expect(registry.get(store.dataAtom)).toBe(ended);
    expect(now).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
    now.mockRestore();

    store.projector.reset();
    expect(registry.get(store.dataAtom)).toBe(initialVoiceSupervisorData);
    unsubscribe();
  });

  it("inherits the shared transcript retention bound", () => {
    const registry = AtomRegistry.make();
    const store = createMobileVoiceSupervisorStore(registry);
    store.projector.beginSession(1, 0);
    for (let index = 0; index < MAX_VOICE_TRANSCRIPT_ENTRIES + 3; index += 1) {
      store.projector.ingestEvent(1, completedTranscript(index), index);
    }

    const transcript = registry.get(store.dataAtom).transcript;
    expect(transcript).toHaveLength(MAX_VOICE_TRANSCRIPT_ENTRIES);
    expect(transcript[0]?.id).toBe("item-3");
    expect(transcript.at(-1)?.id).toBe(`item-${MAX_VOICE_TRANSCRIPT_ENTRIES + 2}`);
  });
});
