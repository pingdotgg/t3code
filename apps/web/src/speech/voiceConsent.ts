import { VoiceTranscriptionDestination } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { randomUUID } from "../lib/utils";
import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";

// Separate keys: a stale window saving ordinary preferences must not restore either grant.
const AUDIO_KEY = "t3code:voice-audio-grant:v1";
const CLEANUP_KEY = "t3code:voice-cleanup-grant:v1";
const AudioGrant = Schema.NullOr(
  Schema.Struct({ id: Schema.String, destination: VoiceTranscriptionDestination }),
);
const CleanupGrant = Schema.NullOr(Schema.String);
const decodeAudioGrant = Schema.decodeSync(Schema.fromJsonString(AudioGrant));

export function useAudioGrant() {
  return useLocalStorage(AUDIO_KEY, null, AudioGrant)[0];
}

export function chooseAudioDestination(destination: VoiceTranscriptionDestination | null) {
  writeLocalStorageValue(
    AUDIO_KEY,
    destination && { id: randomUUID(), destination },
    null,
    AudioGrant,
  );
}

// Bind this recording to this act of consent, even if the user later reselects the same destination.
export function bindAudioGrant(id: string) {
  try {
    const raw = window.localStorage.getItem(AUDIO_KEY);
    if (!raw || decodeAudioGrant(raw)?.id !== id) return () => false;
    return () => {
      try {
        return window.localStorage.getItem(AUDIO_KEY) === raw;
      } catch {
        return false;
      }
    };
  } catch {
    return () => false;
  }
}

export function useCleanupGrant() {
  return useLocalStorage(CLEANUP_KEY, null, CleanupGrant)[0];
}
export function readCleanupGrant() {
  return readLocalStorageValue(CLEANUP_KEY, null, CleanupGrant);
}
export function chooseTranscriptCleanup(enabled: boolean) {
  writeLocalStorageValue(CLEANUP_KEY, enabled ? randomUUID() : null, null, CleanupGrant);
}
