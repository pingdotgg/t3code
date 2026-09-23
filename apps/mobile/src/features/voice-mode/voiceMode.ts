import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  VoiceModeController,
  makeVoiceSessionOpener,
  type VoiceModePhase,
  type VoicePeerConnection,
} from "@t3tools/client-runtime/voice-mode";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import { setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { AppState, NativeModules } from "react-native";
import type * as WebRTC from "react-native-webrtc";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

/**
 * False on binaries built before react-native-webrtc was added. Importing the
 * package there throws, so it only loads once a conversation starts.
 */
export const voiceModeSupported: boolean = NativeModules.WebRTCModule != null;

let webrtc: typeof WebRTC | null = null;
function loadWebRTC(): typeof WebRTC {
  webrtc ??= require("react-native-webrtc") as typeof WebRTC;
  return webrtc;
}

/** Runs the voice stream on the connection runtime, holding it for the conversation's lifetime. */
function runOnConnectionRuntime(effect: Effect.Effect<void, never, EnvironmentRegistry>) {
  return Effect.runFork(
    Effect.gen(function* () {
      yield* AtomRegistry.mount(appAtomRegistry, connectionAtomRuntime);
      const context = yield* AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime);
      yield* Effect.provideContext(effect, context);
    }).pipe(Effect.scoped, Effect.orDie),
  );
}

/**
 * react-native-webrtc's published declarations drop its EventTarget base
 * (`lib/typescript` omits the vendored event-target-shim types), so the class
 * types without `addEventListener`. The runtime class extends the shim and
 * supports it, which is all the controller uses.
 */
function createPeerConnection(): VoicePeerConnection {
  return new (loadWebRTC().RTCPeerConnection)() as unknown as VoicePeerConnection;
}

export const voiceMode = new VoiceModeController({
  createPeerConnection,
  getMicrophone: () => loadWebRTC().mediaDevices.getUserMedia({ audio: true }),
  // Native WebRTC plays remote audio tracks through its own audio device; there is nothing to attach.
  playRemoteAudio: () => () => undefined,
  openSession: makeVoiceSessionOpener(runOnConnectionRuntime),
});

/*
 * WebRTC's iOS audio session uses voice-chat mode, which plays through the
 * earpiece. Once the call is live, re-apply play-and-record with the speaker
 * as the default route (headphones and Bluetooth still win). WebRTC only sets
 * its category when its audio unit starts, which has happened by then. On
 * Android the same call turns the speakerphone on.
 */
async function routeVoiceToSpeaker(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    interruptionMode: "doNotMix",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
}

/** Mirrors dictation's release so interrupted audio in other apps resumes. */
async function releaseVoiceAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    await setIsAudioActiveAsync(false);
  }
}

const KEEP_AWAKE_TAG = "voice-mode";
let previousPhase: VoiceModePhase = "idle";
let routedAudio = false;
let keepAwake: Promise<void> | null = null;

voiceMode.subscribe(({ phase }) => {
  if (phase === previousPhase) return;
  previousPhase = phase;
  if (phase === "active" && !routedAudio) {
    routedAudio = true;
    routeVoiceToSpeaker().catch(() => undefined);
  }
  if (phase !== "idle" && !keepAwake) {
    // A hands-free conversation must not auto-lock: backgrounding ends it.
    keepAwake = activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
  }
  if (phase === "idle") {
    if (routedAudio) {
      routedAudio = false;
      releaseVoiceAudio().catch(() => undefined);
    }
    const activation = keepAwake;
    keepAwake = null;
    // Every conversation shares the tag, so a newer one must keep its lock.
    activation
      ?.then(() => (keepAwake === null ? deactivateKeepAwake(KEEP_AWAKE_TAG) : undefined))
      .catch(() => undefined);
  }
});

// iOS cuts the microphone in the background (the app has no background audio
// mode), and Android restricts background capture without a foreground
// service. End the conversation rather than leave it silently deaf.
AppState.addEventListener("change", (state) => {
  if (state === "background") voiceMode.stop();
});
