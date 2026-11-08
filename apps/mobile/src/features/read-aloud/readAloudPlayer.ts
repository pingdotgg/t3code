import { createAudioPlayer, type AudioPlayer, type AudioStatus } from "expo-audio";
import { useSyncExternalStore } from "react";
import { markdownToSpeechText } from "@t3tools/shared/speechText";

import * as Dialog from "../../components/ui/Dialog";
import { createAudioPlaybackSession, disposeAudioPlayer } from "../../lib/audioSession";
import { stripOptionsCodeFences } from "../../lib/markdownOptionsFence";
import { requestSpeech } from "./readAloudServer";

/**
 * Plays one reply at a time. The PC turns the whole reply into speech and
 * streams the MP3, so playback starts after about a second however long the
 * reply is. Tapping the same reply again stops it; another reply replaces it.
 * Errors show as a dialog straight away, wherever the person is.
 */

/** The PC server's own limit; longer text is refused before it is sent. */
export const READ_ALOUD_MAX_CHARS = 100_000;

export type ReadAloudStatus = "idle" | "loading" | "playing";

export interface ReadAloudState {
  readonly messageId: string | null;
  readonly status: ReadAloudStatus;
  readonly error: string | null;
}

let state: ReadAloudState = { messageId: null, status: "idle", error: null };
let session = 0;
/** The thread screen the playing reply belongs to, so leaving it stops reading. */
let ownerKey: string | null = null;
let stopCurrent: (() => void) | null = null;
const listeners = new Set<() => void>();

function setState(next: ReadAloudState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getReadAloudState(): ReadAloudState {
  return state;
}

export function useReadAloudState(): ReadAloudState {
  return useSyncExternalStore(subscribe, () => state);
}

export function stopReadAloud() {
  session += 1;
  const stop = stopCurrent;
  stopCurrent = null;
  stop?.();
  ownerKey = null;
  setState({ messageId: null, status: "idle", error: null });
}

/** Stops reading if the reply playing belongs to `key` (a thread screen that is going away). */
export function stopReadAloudFor(key: string) {
  if (ownerKey === key && state.status !== "idle") stopReadAloud();
}

function fail(current: number, messageId: string, error: unknown) {
  if (current !== session) return;
  const stop = stopCurrent;
  stopCurrent = null;
  stop?.();
  ownerKey = null;
  const message = error instanceof Error ? error.message : String(error);
  setState({ messageId, status: "idle", error: message });
  Dialog.alert("Couldn't read aloud", message);
}

export async function startReadAloud(input: {
  readonly messageId: string;
  readonly markdown: string;
  readonly serverUrl: string | null;
  readonly voice: string;
  readonly ownerKey?: string | null;
}): Promise<void> {
  stopReadAloud();
  const current = session;
  ownerKey = input.ownerKey ?? null;
  // The reply's options block shows as buttons, not text, so it isn't read.
  const text = markdownToSpeechText(stripOptionsCodeFences(input.markdown));
  if (text.length === 0) return;
  if (!input.serverUrl) {
    fail(
      current,
      input.messageId,
      new Error("Read aloud works only over a direct Tailscale connection to your PC."),
    );
    return;
  }
  if (text.length > READ_ALOUD_MAX_CHARS) {
    fail(current, input.messageId, new Error("This reply is too long to read aloud."));
    return;
  }
  setState({ messageId: input.messageId, status: "loading", error: null });
  let player: AudioPlayer | null = null;
  try {
    const audioUrl = await requestSpeech(input.serverUrl, { text, voice: input.voice });
    if (current !== session) return;
    const created = createAudioPlayer(audioUrl, { updateInterval: 250 });
    player = created;
    // While play() runs, a release comes from its own failure cleanup, which the catch reports.
    let activating = false;
    const playback = createAudioPlaybackSession(created, false, (requested) => {
      // Another player (a video, a voice note, the recorder) took the audio session.
      if (!requested && !activating && current === session && stopCurrent) stopReadAloud();
    });
    let released = false;
    const subscription = created.addListener("playbackStatusUpdate", (status: AudioStatus) => {
      if (current !== session) return;
      if (status.didJustFinish) {
        stopReadAloud();
        return;
      }
      if ("error" in status && typeof status.error === "string" && status.error.length > 0) {
        fail(current, input.messageId, new Error("The audio couldn't be played."));
        return;
      }
      if (status.playing && state.status !== "playing") {
        setState({ messageId: input.messageId, status: "playing", error: null });
      }
    });
    stopCurrent = () => {
      if (released) return;
      released = true;
      subscription.remove();
      playback.pause();
      disposeAudioPlayer(created);
    };
    activating = true;
    try {
      await playback.play();
    } finally {
      activating = false;
    }
    // play() returns quietly when another player (or the recorder) holds the audio session.
    if (current === session && !playback.requested) {
      fail(current, input.messageId, new Error("Another player is using the audio. Try again."));
    }
  } catch (error) {
    if (player && !stopCurrent) disposeAudioPlayer(player);
    fail(current, input.messageId, error);
  }
}
