import { useSyncExternalStore } from "react";

import { markdownToSpeechText, splitSpeechText } from "./speechText";

/**
 * Plays one reply at a time. On the desktop app each piece is synthesized by
 * edge-tts (Edge's natural voices) while the previous piece plays; without
 * the desktop bridge, or when edge-tts fails, it falls back to the browser's
 * own speechSynthesis (the basic Windows voices) and says why.
 */

export type ReadAloudStatus = "idle" | "loading" | "playing";

export interface ReadAloudState {
  readonly messageId: string | null;
  readonly status: ReadAloudStatus;
  /** Set when the natural voice couldn't be used for the current reply. */
  readonly fallbackReason: string | null;
}

/** Pieces requested ahead of the one playing. */
const LOOKAHEAD_PIECES = 2;

const IDLE: ReadAloudState = { messageId: null, status: "idle", fallbackReason: null };

let state: ReadAloudState = IDLE;
let session = 0;
let stopCurrent: (() => void) | null = null;
const listeners = new Set<() => void>();

function setState(next: ReadAloudState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useReadAloudState(): ReadAloudState {
  return useSyncExternalStore(subscribe, () => state);
}

export function stopReadAloud() {
  session += 1;
  stopCurrent?.();
  stopCurrent = null;
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  setState(IDLE);
}

function base64ToBlobUrl(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}

function playAudio(url: string, isCurrent: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    const finish = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    stopCurrent = () => {
      audio.pause();
      finish();
    };
    audio.onended = finish;
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The audio couldn't be played."));
    };
    if (!isCurrent()) return finish();
    audio.play().catch(reject);
  });
}

function speakWithBrowserVoice(text: string, isCurrent: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth || !isCurrent()) return resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices();
    const english = voices.filter((voice) => voice.lang.startsWith("en"));
    utterance.voice =
      english.find((voice) => /Mark|Aria|Jenny/i.test(voice.name)) ?? english[0] ?? null;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    stopCurrent = () => {
      synth.cancel();
      resolve();
    };
    synth.speak(utterance);
  });
}

export async function startReadAloud(input: {
  readonly messageId: string;
  readonly markdown: string;
  readonly voice: string;
}) {
  stopReadAloud();
  const mySession = session;
  const isCurrent = () => session === mySession;
  const chunks = splitSpeechText(markdownToSpeechText(input.markdown));
  if (chunks.length === 0) return;

  setState({ messageId: input.messageId, status: "loading", fallbackReason: null });
  const bridge = typeof window !== "undefined" ? window.desktopBridge?.readAloud : undefined;

  const browserVoiceFrom = async (index: number, reason: string) => {
    if (!isCurrent()) return;
    setState({ messageId: input.messageId, status: "playing", fallbackReason: reason });
    await speakWithBrowserVoice(chunks.slice(index).join(" "), isCurrent);
  };

  let reached = 0;
  try {
    if (!bridge) {
      await browserVoiceFrom(0, "Natural voices need the desktop app.");
      return;
    }
    // Edge's service delivers audio at roughly playback speed, so several
    // pieces are requested at once to stay ahead of playback.
    const pending = new Map<number, ReturnType<typeof bridge.synthesize>>();
    const requestUpTo = (last: number) => {
      for (let index = 0; index <= Math.min(last, chunks.length - 1); index += 1) {
        if (!pending.has(index)) {
          pending.set(index, bridge.synthesize({ text: chunks[index]!, voice: input.voice }));
        }
      }
    };
    for (let index = 0; index < chunks.length; index += 1) {
      reached = index;
      requestUpTo(index + LOOKAHEAD_PIECES);
      const result = await pending.get(index)!;
      pending.delete(index);
      if (!isCurrent()) return;
      if (!result.ok) {
        await browserVoiceFrom(index, `Natural voice unavailable: ${result.error}`);
        return;
      }
      setState({
        messageId: input.messageId,
        status: "playing",
        fallbackReason: state.fallbackReason,
      });
      await playAudio(base64ToBlobUrl(result.audioBase64), isCurrent);
      if (!isCurrent()) return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await browserVoiceFrom(reached, `Natural voice unavailable: ${message}`);
  } finally {
    if (isCurrent()) {
      stopCurrent = null;
      // Keep the reason so the button's tooltip can still explain the voice.
      setState({ ...IDLE, fallbackReason: state.fallbackReason });
    }
  }
}
