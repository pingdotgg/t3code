import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import type { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";
import { voiceSpeakingAtom } from "./voiceReplies";

/** How long the speaker stays silent before what they said is sent. */
const TWO_WAY_PAUSE_MS = 1_500;

const NO_SPEECH_ERROR = "No speech was detected.";
const SETUP_NEEDED = "Finish setting up voice input, then turn two-way voice on again.";

/**
 * Two-way voice: records through the composer's speech input while no reply is read aloud, and
 * hands over what was said once the speaker pauses. A model that is not set up yet opens its setup
 * first, and listening starts once setup finishes. Returns whether the current recording is
 * two-way voice's, whose transcript must not land in the draft.
 */
export function useTwoWayVoice(input: {
  readonly active: boolean;
  readonly disabled: boolean;
  readonly speech: Pick<
    ReturnType<typeof useEnvironmentSpeechInput>,
    "available" | "state" | "preview" | "start" | "cancel" | "submitAfterDictation" | "status"
  > & { readonly setup: { readonly open: boolean } };
  readonly onSpoken: (transcript: string) => void;
  readonly onStopped: (message: string) => void;
}) {
  const speaking = useAtomValue(voiceSpeakingAtom);
  const { start, cancel, submitAfterDictation, available, preview } = input.speech;
  const { phase, error } = input.speech.state;
  const listen = input.active && !input.disabled && !speaking && available;
  const setupOpen = input.speech.setup.open;
  const modelReady =
    input.speech.status?.supported === true && input.speech.status.state !== "missing-model";
  const ownsRecording = useRef(false);
  const starting = useRef(false);
  const settingUp = useRef(false);
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed callbacks to the asynchronous transcript delivery
  useEffect(() => {
    latest.current = input;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the microphone from the voice mode and the reply playback
  useEffect(() => {
    const record = () => {
      ownsRecording.current = true;
      starting.current = true;
      void start().then((began) => {
        starting.current = false;
        if (!ownsRecording.current) {
          if (began) cancel();
          return;
        }
        if (began) return;
        if (latest.current.speech.setup.open) {
          settingUp.current = true;
          return;
        }
        ownsRecording.current = false;
        latest.current.onStopped(SETUP_NEEDED);
      });
    };
    if (!listen) {
      settingUp.current = false;
      if (!ownsRecording.current) return;
      ownsRecording.current = false;
      if (!starting.current) cancel();
      return;
    }
    if (starting.current) return;
    if (settingUp.current) {
      if (setupOpen) return;
      settingUp.current = false;
      if (phase !== "idle") return;
      if (modelReady) {
        record();
        return;
      }
      ownsRecording.current = false;
      latest.current.onStopped(SETUP_NEEDED);
      return;
    }
    if (!ownsRecording.current) {
      if (phase === "idle") record();
      return;
    }
    if (phase === "idle" || (phase === "error" && error === NO_SPEECH_ERROR)) {
      record();
      return;
    }
    if (phase !== "error") return;
    ownsRecording.current = false;
    latest.current.onStopped(error ?? "Voice input stopped.");
  }, [listen, phase, error, start, cancel, setupOpen, modelReady]);

  const heard = preview ? `${preview.committed}${preview.tentative}`.trim() : "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends the spoken turn after a pause in the live transcript
  useEffect(() => {
    if (!ownsRecording.current || phase !== "recording" || heard === "") return;
    const timer = window.setTimeout(
      () =>
        submitAfterDictation((transcript) => {
          if (transcript.trim() !== "") latest.current.onSpoken(transcript.trim());
        }),
      TWO_WAY_PAUSE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [heard, phase, submitAfterDictation]);

  return ownsRecording;
}
