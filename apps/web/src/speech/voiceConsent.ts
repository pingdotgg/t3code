import { VoiceTranscriptionDestination } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import { randomUUID } from "../lib/utils";
import {
  getLocalStorageItem,
  readLocalStorageValue,
  subscribeLocalStorageKey,
  useLocalStorage,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";

// Separate keys: a stale window saving ordinary preferences must not restore either grant.
const AUDIO_KEY = "t3code:voice-audio-grant:v1";
const CLEANUP_KEY = "t3code:voice-cleanup-grant:v1";
const Grant = Schema.Struct({ id: Schema.String, destination: VoiceTranscriptionDestination });
const AudioGrant = Schema.NullOr(Grant);
const sameGrant = Schema.toEquivalence(AudioGrant);
const AudioChoice = Schema.NullOr(
  Schema.Union([Grant, Schema.Struct({ pending: Grant, previous: AudioGrant })]),
);
type AudioChoice = typeof AudioChoice.Type;
const savedKey = (id: string) => `${AUDIO_KEY}:saved:${id}`;
const pendingGrant = (choice: AudioChoice) =>
  choice && "pending" in choice ? choice.pending : null;
const CleanupGrant = Schema.NullOr(Schema.String);
const decodeChoice = Schema.decodeSync(Schema.fromJsonString(AudioChoice));
const readChoice = () => readLocalStorageValue(AUDIO_KEY, null, AudioChoice);

function readSaveMarker(id: string | undefined) {
  try {
    return id ? window.localStorage.getItem(savedKey(id)) : null;
  } catch {
    return undefined;
  }
}

function activeGrant(choice: AudioChoice, marker: string | null | undefined) {
  if (!choice || !("pending" in choice)) return choice;
  // Only a confirmed missing marker means the previous grant still applies.
  if (marker === null) return choice.previous;
  return marker === "true" ? choice.pending : null;
}

export function useAudioGrant() {
  const [choice] = useLocalStorage(AUDIO_KEY, null, AudioChoice);
  const id = pendingGrant(choice)?.id;
  const marker = useSyncExternalStore(
    (notify) => (id ? subscribeLocalStorageKey(savedKey(id), notify) : () => {}),
    () => readSaveMarker(id),
    () => undefined,
  );
  return activeGrant(choice, marker);
}

function replaceChoice(choice: AudioChoice, previous = readChoice()) {
  const old = pendingGrant(previous);
  writeLocalStorageValue(AUDIO_KEY, choice, null, AudioChoice);
  if (old && pendingGrant(getLocalStorageItem(AUDIO_KEY, AudioChoice))?.id !== old.id)
    window.localStorage.removeItem(savedKey(old.id));
}

export function chooseAudioDestination(destination: VoiceTranscriptionDestination | null) {
  replaceChoice(destination && { id: randomUUID(), destination });
}

export function pendingCloudAudioChoice(
  destination: Extract<VoiceTranscriptionDestination, { kind: "cloud" }>,
) {
  const choice = readChoice();
  const pending = { id: randomUUID(), destination };
  replaceChoice(
    { pending, previous: activeGrant(choice, readSaveMarker(pendingGrant(choice)?.id)) },
    choice,
  );
  // A late response can acknowledge only its own choice, never write the destination another tab picked.
  return () => {
    if (pendingGrant(readChoice())?.id === pending.id)
      writeLocalStorageValue(savedKey(pending.id), true, false, Schema.Boolean);
  };
}

// Bind this recording to this act of consent, even if the user later reselects the same destination.
export function bindAudioGrant(id: string) {
  try {
    let cachedRaw: string | null = null;
    let choice: AudioChoice = null;
    const current = () => {
      const raw = window.localStorage.getItem(AUDIO_KEY);
      if (raw !== cachedRaw) {
        choice = raw ? decodeChoice(raw) : null;
        cachedRaw = raw;
      }
      return activeGrant(choice, readSaveMarker(pendingGrant(choice)?.id));
    };
    const bound = current();
    if (bound?.id !== id) return () => false;
    return () => {
      try {
        return sameGrant(current(), bound);
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
