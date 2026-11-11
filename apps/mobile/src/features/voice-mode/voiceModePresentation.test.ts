import { describe, expect, it } from "vite-plus/test";
import { INITIAL_VOICE_MODE_STATE } from "@t3tools/client-runtime/voice-mode";

import {
  createSpeakingDetector,
  resolveVoiceModeNotice,
  resolveVoiceStripStatus,
  voiceCaptionTail,
} from "./voiceModePresentation";

describe("resolveVoiceStripStatus", () => {
  it("shows connecting until the conversation is live, then prefers the assistant's voice", () => {
    expect(resolveVoiceStripStatus({ phase: "connecting", muted: true, speaking: true })).toBe(
      "connecting",
    );
    expect(resolveVoiceStripStatus({ phase: "active", muted: true, speaking: true })).toBe(
      "speaking",
    );
    expect(resolveVoiceStripStatus({ phase: "active", muted: true, speaking: false })).toBe(
      "muted",
    );
    expect(resolveVoiceStripStatus({ phase: "active", muted: false, speaking: false })).toBe(
      "listening",
    );
  });
});

describe("createSpeakingDetector", () => {
  it("holds through short pauses and releases after sustained silence", () => {
    const isSpeaking = createSpeakingDetector();
    expect(isSpeaking(0, 0)).toBe(false);
    expect(isSpeaking(0.3, 100)).toBe(true);
    expect(isSpeaking(0, 300)).toBe(true);
    expect(isSpeaking(0.001, 600)).toBe(true);
    expect(isSpeaking(0, 700)).toBe(false);
  });
});

describe("voiceCaptionTail", () => {
  it("keeps the newest words of long captions", () => {
    expect(voiceCaptionTail("short")).toBe("short");
    expect(voiceCaptionTail("one two three four", 9)).toBe("…hree four");
  });
});

describe("resolveVoiceModeNotice", () => {
  const target = { environmentId: "env", threadId: "thread" };

  it("stays quiet while live and after the user stops", () => {
    expect(resolveVoiceModeNotice(INITIAL_VOICE_MODE_STATE)).toBeNull();
    expect(
      resolveVoiceModeNotice({ ...INITIAL_VOICE_MODE_STATE, phase: "active", target }),
    ).toBeNull();
  });

  it("reports failures and endings the user did not choose", () => {
    expect(
      resolveVoiceModeNotice({ ...INITIAL_VOICE_MODE_STATE, target, error: "Mic denied" }),
    ).toEqual({ title: "Voice conversation failed", message: "Mic denied" });
    expect(
      resolveVoiceModeNotice({ ...INITIAL_VOICE_MODE_STATE, target, endedReason: "ended" }),
    ).toEqual({ title: "Voice conversation ended" });
    expect(
      resolveVoiceModeNotice({ ...INITIAL_VOICE_MODE_STATE, target, endedReason: "replaced" }),
    ).toEqual({
      title: "Voice conversation ended",
      message: "Voice conversation moved to another window or device.",
    });
  });
});
