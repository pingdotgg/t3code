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
// A missing grant is both "never asked" and "turned off". Off is stored on its own
// so the first visit can still show the microphone without treating Off as unset.
const DECLINED_KEY = "t3code:voice-audio-declined:v1";
const AudioGrant = Schema.NullOr(
  Schema.Struct({ id: Schema.String, destination: VoiceTranscriptionDestination }),
);
const CleanupGrant = Schema.NullOr(Schema.String);
const DeclinedFlag = Schema.Boolean;
const decodeAudioGrant = Schema.decodeSync(Schema.fromJsonString(AudioGrant));

export function useAudioGrant() {
  return useLocalStorage(AUDIO_KEY, null, AudioGrant)[0];
}

export function useAudioDeclined() {
  return useLocalStorage(DECLINED_KEY, false, DeclinedFlag)[0];
}

export function chooseAudioDestination(destination: VoiceTranscriptionDestination | null) {
  if (destination) {
    writeLocalStorageValue(AUDIO_KEY, { id: randomUUID(), destination }, null, AudioGrant);
    writeLocalStorageValue(DECLINED_KEY, false, false, DeclinedFlag);
    return;
  }
  // Mark Off before removing the grant so a render in between does not look like a first visit.
  writeLocalStorageValue(DECLINED_KEY, true, false, DeclinedFlag);
  writeLocalStorageValue(AUDIO_KEY, null, null, AudioGrant);
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
