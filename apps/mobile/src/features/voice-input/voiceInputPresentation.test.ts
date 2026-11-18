import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { describe, expect, it } from "vite-plus/test";

import {
  resolvePendingVoiceSend,
  resolveVoiceComposerPresentation,
} from "./voiceInputPresentation";

const state = (phase: VoiceInputState["phase"]): VoiceInputState =>
  phase === "error"
    ? { phase, error: "No speech was detected.", errorAction: "retry" }
    : ({ phase, error: null, errorAction: null } as VoiceInputState);

describe("resolveVoiceComposerPresentation", () => {
  it("offers send while recording so one tap stops and sends", () => {
    const recording = resolveVoiceComposerPresentation(state("recording"), 3);
    expect(recording.showsDictationSend).toBe(true);
    expect(recording.confirmationEnabled).toBe(true);
  });

  it("shows send disabled while the microphone is still preparing", () => {
    const preparing = resolveVoiceComposerPresentation(state("preparing"), 0);
    expect(preparing.showsDictationSend).toBe(true);
    expect(preparing.confirmationEnabled).toBe(false);
  });

  it("hides the dictation send once recording has stopped or when idle", () => {
    for (const phase of ["idle", "error", "transcribing", "post-processing"] as const) {
      expect(resolveVoiceComposerPresentation(state(phase), 0).showsDictationSend).toBe(false);
    }
  });
});

describe("resolvePendingVoiceSend", () => {
  const pending = { pending: true, committed: true, phase: "idle", canSend: true } as const;

  it("sends once the transcript has landed and the draft can be sent", () => {
    expect(resolvePendingVoiceSend(pending)).toBe("send");
  });

  it("keeps the transcript in the draft when the draft cannot be sent", () => {
    expect(resolvePendingVoiceSend({ ...pending, canSend: false })).toBe("clear");
  });

  it("sends nothing when dictation was cancelled before the transcript landed", () => {
    expect(resolvePendingVoiceSend({ ...pending, committed: false })).toBe("clear");
  });

  it("sends nothing when transcription fails", () => {
    expect(resolvePendingVoiceSend({ ...pending, committed: false, phase: "error" })).toBe("clear");
  });

  it("waits while recording is still finishing", () => {
    for (const phase of ["recording", "transcribing", "post-processing"] as const) {
      expect(resolvePendingVoiceSend({ ...pending, committed: false, phase })).toBe("wait");
    }
  });

  it("does nothing when no voice send was requested", () => {
    expect(resolvePendingVoiceSend({ ...pending, pending: false })).toBe("wait");
  });
});
