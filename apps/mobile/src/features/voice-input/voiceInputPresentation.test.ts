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
  it.each([
    ["preparing", true, false],
    ["recording", true, true],
    ["transcribing", false, false],
    ["post-processing", false, false],
    ["idle", false, false],
    ["error", false, false],
  ] as const)("%s: dictation send shown %s, enabled %s", (phase, shown, enabled) => {
    const presentation = resolveVoiceComposerPresentation(state(phase), 0);
    expect(presentation.showsDictationSend).toBe(shown);
    if (shown) expect(presentation.confirmationEnabled).toBe(enabled);
  });
});

describe("resolvePendingVoiceSend", () => {
  const pending = {
    pending: true,
    committed: true,
    targetsCurrentDraft: true,
    phase: "idle",
    canSend: true,
  } as const;

  it.each([
    ["the transcript landed and the draft can be sent", pending, "send"],
    ["the draft cannot be sent, so the transcript stays", { ...pending, canSend: false }, "clear"],
    [
      "dictation was cancelled before the transcript landed",
      { ...pending, committed: false },
      "clear",
    ],
    ["transcription failed", { ...pending, committed: false, phase: "error" }, "clear"],
    ["recording is still finishing", { ...pending, committed: false, phase: "recording" }, "wait"],
    ["transcription is running", { ...pending, committed: false, phase: "transcribing" }, "wait"],
    ["no voice send was requested", { ...pending, pending: false }, "wait"],
    ["the composer moved to another draft", { ...pending, targetsCurrentDraft: false }, "clear"],
    [
      "the composer moved to another draft mid-recording",
      { ...pending, committed: false, targetsCurrentDraft: false, phase: "recording" },
      "clear",
    ],
  ] as const)("%s", (_case, input, expected) => {
    expect(resolvePendingVoiceSend(input)).toBe(expected);
  });
});
