import { useNavigate } from "@tanstack/react-router";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useAudioDeclined, useAudioGrant } from "./voiceConsent";

/** This browser can capture microphone audio for dictation. */
export function browserCanCaptureSpeech() {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof AudioWorkletNode !== "undefined"
  );
}

/**
 * True only before this device has chosen a transcription environment or turned voice off.
 * A grant still has to exist before any audio is captured.
 */
export function useVoiceEntryPrompt() {
  const grant = useAudioGrant();
  const declined = useAudioDeclined();
  return grant === null && !declined && browserCanCaptureSpeech();
}

/** What the microphone and dictation shortcut should do. Recording requires `available`. */
export function voiceEntryAction(
  available: boolean,
  promptSetup: boolean,
): "record" | "setup" | "hidden" {
  if (available) return "record";
  if (promptSetup) return "setup";
  return "hidden";
}

export function useOpenVoiceDestinationSettings() {
  const navigate = useNavigate();
  return useStableCallback(() => {
    void navigate({
      to: "/settings/voice",
      hash: "voice-transcription-destination",
    });
  });
}
