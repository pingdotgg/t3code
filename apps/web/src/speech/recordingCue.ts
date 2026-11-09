import type { SpeechRecordingCueSound } from "@t3tools/contracts";

import analogUrl from "../assets/speech-cues/analog.wav?url";
import classicUrl from "../assets/speech-cues/classic.wav?url";
import clickUrl from "../assets/speech-cues/click.wav?url";
import signatureUrl from "../assets/speech-cues/signature.wav?url";
import softUrl from "../assets/speech-cues/soft.wav?url";
import thockUrl from "../assets/speech-cues/thock.wav?url";
import woodUrl from "../assets/speech-cues/wood.wav?url";

// The start sounds from https://github.com/anomalyco/hex, unmodified. See speech-cues/LICENSE.
export const RECORDING_CUE_SOUNDS = {
  classic: { label: "Classic", url: classicUrl },
  signature: { label: "Signature", url: signatureUrl },
  click: { label: "Click", url: clickUrl },
  soft: { label: "Soft tone", url: softUrl },
  wood: { label: "Wood", url: woodUrl },
  analog: { label: "Warm synth", url: analogUrl },
  thock: { label: "Thock", url: thockUrl },
} as const satisfies Record<SpeechRecordingCueSound, { label: string; url: string }>;

const cueElements = new Map<SpeechRecordingCueSound, HTMLAudioElement>();

function cueElement(sound: SpeechRecordingCueSound): HTMLAudioElement {
  const existing = cueElements.get(sound);
  if (existing) return existing;
  const created = new Audio(RECORDING_CUE_SOUNDS[sound].url);
  cueElements.set(sound, created);
  return created;
}

/** Loads a cue ahead of time so it can play the moment recording begins. */
export function preloadRecordingCue(sound: SpeechRecordingCueSound): void {
  cueElement(sound);
}

/** Plays the sound that tells the user dictation is listening. */
export function playRecordingCue(sound: SpeechRecordingCueSound): void {
  const audio = cueElement(sound);
  audio.currentTime = 0;
  void audio.play().catch(() => undefined);
}
