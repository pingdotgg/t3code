import { synthesizeEnvironmentSpeech } from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, SpeechReadAloudMode } from "@t3tools/contracts";
import { msg } from "gt-react";

import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { readPreparedConnection } from "~/state/session";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";

export type ReadAloudSnapshot = {
  readonly activeMessageId: string | null;
  readonly phase: "idle" | "loading" | "playing";
  readonly mode: SpeechReadAloudMode | null;
};

const IDLE_SNAPSHOT: ReadAloudSnapshot = {
  activeMessageId: null,
  phase: "idle",
  mode: null,
};

let currentSnapshot: ReadAloudSnapshot = IDLE_SNAPSHOT;
let activeController: AbortController | null = null;
let activeAudio: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;
const listeners = new Set<() => void>();

function emitSnapshot(next: ReadAloudSnapshot) {
  currentSnapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function clearMediaSession() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = "none";
    navigator.mediaSession.setActionHandler("play", null);
    navigator.mediaSession.setActionHandler("pause", null);
    navigator.mediaSession.setActionHandler("stop", null);
  } catch {
    return;
  }
}

function configureMediaSession(audio: HTMLAudioElement, mode: SpeechReadAloudMode) {
  if (
    typeof navigator === "undefined" ||
    !("mediaSession" in navigator) ||
    typeof MediaMetadata === "undefined"
  ) {
    return;
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: mode === "summary" ? m(msg("Response summary")) : m(msg("Full response")),
      artist: "T3 Code",
    });
    navigator.mediaSession.playbackState = "playing";
    navigator.mediaSession.setActionHandler("play", () => {
      void audio.play().catch(() => stopReadAloud());
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      stopReadAloud();
    });
    navigator.mediaSession.setActionHandler("stop", () => {
      stopReadAloud();
    });
  } catch {
    return;
  }
}

function cleanupResources() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.removeAttribute("src");
    activeAudio = null;
  }
  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
  clearMediaSession();
}

export function subscribeReadAloud(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getReadAloudSnapshot(): ReadAloudSnapshot {
  return currentSnapshot;
}

export function stopReadAloud() {
  cleanupResources();
  if (currentSnapshot.phase !== "idle") {
    emitSnapshot(IDLE_SNAPSHOT);
  }
}

export function startReadAloud(input: {
  readonly messageId: string;
  readonly environmentId: EnvironmentId | null;
  readonly text: string;
  readonly mode: SpeechReadAloudMode;
}) {
  cleanupResources();
  if (!input.environmentId) {
    toastManager.add({
      type: "error",
      title: m(msg("Could not read response aloud.")),
    });
    emitSnapshot(IDLE_SNAPSHOT);
    return;
  }
  const connection = readPreparedConnection(input.environmentId);
  if (!connection) {
    toastManager.add({
      type: "error",
      title: m(msg("Could not read response aloud.")),
    });
    emitSnapshot(IDLE_SNAPSHOT);
    return;
  }
  const controller = new AbortController();
  activeController = controller;
  emitSnapshot({
    activeMessageId: input.messageId,
    phase: "loading",
    mode: input.mode,
  });
  void runEnvironmentSpeech(
    synthesizeEnvironmentSpeech(
      connection,
      input.text,
      input.mode,
      () => !controller.signal.aborted,
    ),
    { signal: controller.signal },
  ).then(
    (wavBytes) => {
      if (controller.signal.aborted || activeController !== controller) return;
      const copy = new Uint8Array(wavBytes.byteLength);
      copy.set(wavBytes);
      const blob = new Blob([copy], { type: "audio/wav" });
      const objectUrl = URL.createObjectURL(blob);
      activeObjectUrl = objectUrl;
      const audio = new Audio(objectUrl);
      activeAudio = audio;
      audio.addEventListener("ended", () => {
        if (activeAudio === audio) stopReadAloud();
      });
      audio.addEventListener("error", () => {
        if (activeAudio === audio) {
          stopReadAloud();
          toastManager.add({
            type: "error",
            title: m(msg("Could not play synthesized speech.")),
          });
        }
      });
      configureMediaSession(audio, input.mode);
      emitSnapshot({
        activeMessageId: input.messageId,
        phase: "playing",
        mode: input.mode,
      });
      void audio.play().catch(() => {
        if (activeAudio === audio) {
          stopReadAloud();
          toastManager.add({
            type: "error",
            title: m(msg("Could not play synthesized speech.")),
          });
        }
      });
    },
    () => {
      if (controller.signal.aborted || activeController !== controller) return;
      stopReadAloud();
      toastManager.add({
        type: "error",
        title: m(msg("Could not read response aloud.")),
      });
    },
  );
}
