import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  VoiceModeController,
  describeVoiceEnd,
  makeVoiceSessionOpener,
  type VoiceMediaStream,
  type VoiceModePhase,
  type VoiceModePlatform,
  type VoiceModeState,
  type VoicePeerConnection,
  type VoiceSessionTarget,
} from "@t3tools/client-runtime/voice-mode";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import { useSyncExternalStore } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { VoiceAvailability } from "./voiceAvailability";

function getMicrophone(): Promise<MediaStream> {
  const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  // Browsers only expose the microphone API on secure origins, so a remote
  // environment opened over plain HTTP has no `mediaDevices` at all.
  if (!mediaDevices?.getUserMedia) {
    return Promise.reject(
      new Error("Voice needs microphone access, which requires HTTPS when connecting remotely."),
    );
  }
  return mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

function playRemoteAudio(stream: VoiceMediaStream): () => void {
  const audio = new Audio();
  audio.autoplay = true;
  audio.srcObject = stream as MediaStream;
  void audio.play().catch(() => undefined);
  return () => {
    audio.pause();
    audio.srcObject = null;
  };
}

// The voice stream runs on the connection runtime, which owns the environment
// registry. Mounting keeps that runtime alive for the conversation.
const openSession = makeVoiceSessionOpener((effect) =>
  Effect.runFork(
    Effect.scoped(
      AtomRegistry.mount(appAtomRegistry, connectionAtomRuntime).pipe(
        Effect.andThen(AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime)),
        Effect.flatMap((context) => Effect.provideContext(effect, context)),
      ),
    ).pipe(Effect.orDie),
  ),
);

const platform: VoiceModePlatform = {
  // The DOM's overloaded addEventListener does not fit the structural `never`
  // listener in VoicePeerConnection, though the runtime shape matches.
  createPeerConnection: () => new RTCPeerConnection() as unknown as VoicePeerConnection,
  getMicrophone,
  playRemoteAudio,
  openSession,
};

/** The app's single voice conversation. The microphone is exclusive, so there is one per client. */
export const voiceMode = new VoiceModeController(platform);

export function isVoiceTargetFor(
  state: VoiceModeState,
  target: VoiceSessionTarget | null,
): boolean {
  return (
    target !== null &&
    state.target !== null &&
    state.target.environmentId === target.environmentId &&
    state.target.threadId === target.threadId
  );
}

export function useVoiceModeState(): VoiceModeState {
  return useSyncExternalStore(voiceMode.subscribe, voiceMode.getState, voiceMode.getState);
}

/** The conversation phase on `target`; "idle" while voice is off or on another thread. */
export function useVoicePhaseFor(target: VoiceSessionTarget | null): VoiceModePhase {
  const getPhase = () => {
    const state = voiceMode.getState();
    return isVoiceTargetFor(state, target) ? state.phase : "idle";
  };
  return useSyncExternalStore(voiceMode.subscribe, getPhase, getPhase);
}

/**
 * Starts or stops voice on `target`. An unavailable thread explains why
 * instead of failing on the server.
 */
export function toggleThreadVoice(target: VoiceSessionTarget, availability: VoiceAvailability) {
  if (voiceMode.isActiveFor(target)) {
    voiceMode.stop();
    return;
  }
  if (availability.kind === "unsupported") return;
  if (availability.kind === "unavailable") {
    toastManager.add({ type: "info", title: availability.reason });
    return;
  }
  void voiceMode.start(target);
}

// Errors and provider-side ends surface once as a toast on the conversation's
// thread. A user stop leaves neither set, so it stays silent.
let lastPhase: VoiceModePhase = "idle";
voiceMode.subscribe((state) => {
  const previousPhase = lastPhase;
  lastPhase = state.phase;
  if (state.phase !== "idle" || state.target === null) return;
  if (state.error === null && state.endedReason === null) return;
  const threadRef = scopeThreadRef(
    EnvironmentId.make(state.target.environmentId),
    ThreadId.make(state.target.threadId),
  );
  if (state.error !== null) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: previousPhase === "active" ? "Voice conversation ended" : "Couldn't start voice",
        description: state.error,
        data: { threadRef },
      }),
    );
  } else if (state.endedReason !== null) {
    toastManager.add({
      type: "info",
      title: describeVoiceEnd(state.endedReason),
      data: { threadRef },
    });
  }
  voiceMode.dismiss();
});
